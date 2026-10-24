import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, ScanText } from "lucide-react";
import type { FontFamily, TextEditAnnot } from "../annotations/types";
import { stageBox, type RenderCtx } from "../annotations/render";
import { analyzePage, withRunText, type TextBlock, type TextRun } from "../lib/textLayout";
import { getRuntime } from "../state/runtime";
import { getDoc, toast, useApp, withBusy } from "../state/store";
import { deleteAnnotations, updateAnnotation } from "../state/annotActions";
import { stdFontName, wrapText } from "../lib/fontMetrics";
import { sampleRegionColors } from "../lib/colorSample";
import { apply, inflateRect, invert, rectContainsPoint, rectsIntersect, type PdfRect } from "../lib/geometry";
import { applyDocumentChange } from "../core/document";
import { FontCache, loadPdfLib, type PDFDocument } from "../lib/pdflib";
import { familyKey, parseFontName } from "../lib/fontNames";
import type { SeenCharLook, TextAlign, TextEditRequest } from "../ops/editText";
import type { SeenBlock } from "../ops/recognize";
import type { PageGlyph } from "../ops/contentRedact";
import type { BaseStyle, RichChar } from "./richText";
import { TextEditorBox, type EditorResult, type RichEditing } from "./TextEditorBox";
import type { FontMenu } from "./TextFormatBar";
import { onRecognitionRequest, takeRecognition } from "./recognizeRequest";

const familyOf = (f: TextBlock["family"]): FontFamily => (f === "serif" ? "Times" : f === "monospace" ? "Courier" : "Helvetica");

interface Editing extends RichEditing {
  /** Existing text edit being changed, or null for a new edit of `block` or `seen`. */
  annotId: string | null;
  block: TextBlock | null;
  /** `block` with its text as edited (letter-spaced text read without the spaces between its letters). */
  source: TextBlock | null;
  /** Text recognized in a picture of the page. */
  seen: SeenBlock | null;
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
}

/** Text recognized in pages' pictures, by document, page and the page's rotation. */
const seenPages = new Map<string, Promise<SeenBlock[]>>();

/** Pages with less real text than this offer to recognize the text in their pictures. */
const SCARCE = 25;

/**
 * Edit PDF → Edit text: outlines text blocks on hover; clicking opens an
 * in-place editor with a formatting toolbar. Committing changes the page's
 * text right away, keeping its fonts and layout. Text that's part of a picture
 * (scans, or design apps' text exported as images or outlines) is recognized
 * first, then edited the same way.
 */
export function TextEditLayer({ docId, pageIndex, ctx, geo, scale }: { docId: string; pageIndex: number; ctx: RenderCtx; geo: { width: number; height: number }; scale: number }) {
  const [layout, setLayout] = useState<{ blocks: TextBlock[]; runs: TextRun[]; view: number[] } | null>(null);
  // How each run is drawn (read from the page after its layout): its letters' colors, whether
  // it's drawn at all, and its text without the spaces pdf.js reads in letter-spaced text.
  const glyphs = useRef<Promise<RunGlyphs | null>>(Promise.resolve(null));
  const [drawn, setDrawn] = useState<RunGlyphs | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [fontList, setFontList] = useState<FontMenu["others"]>([]);
  const [seen, setSeen] = useState<SeenBlock[] | null>(null);
  /** Recognizing the text in the page's pictures: how far it is (0–1). */
  const [recognizing, setRecognizing] = useState<number | null>(null);
  const page = useApp((s) => s.docs[docId].pages[pageIndex]);
  const all = useApp((s) => s.docs[docId].annotations);
  const edits = useMemo(() => all.filter((a): a is TextEditAnnot => a.kind === "textedit" && a.pageId === page.id), [all, page.id]);
  const version = useApp((s) => s.docs[docId].version);
  const result = useRef<(() => EditorResult) | null>(null);
  // The edit being committed, so it's committed once.
  const done = useRef<Editing | null>(null);
  const seenKey = `${docId}|${page.id}|${page.rotate}`;

  useEffect(() => {
    const rt = getRuntime(docId);
    if (!rt) return;
    let alive = true;
    // Edit mode first makes the document's links editable, which reloads it (and would close an
    // editor opened meanwhile): text can be edited once that's done.
    void import("../ops/links")
      .then((m) => m.liftLinks(docId))
      .catch(() => 0)
      .then(() => (alive ? analyzePage(rt.pdf, pageIndex) : null))
      .then((l) => {
        if (!l || !alive) return;
        setLayout({ blocks: l.blocks.filter((b) => Math.abs(b.lines[0].angle) < 0.02), runs: l.runs, view: l.view });
        setDrawn(null);
        glyphs.current = runGlyphs(getRuntime(docId)?.bytes, pageIndex, l.runs).catch(() => null);
        void glyphs.current.then((g) => alive && setDrawn(g));
      })
      .catch((e) => {
        console.warn("Could not read the page's text", e);
        if (alive) setLayout({ blocks: [], runs: [], view: [0, 0, 612, 792] });
      });
    return () => {
      alive = false;
    };
  }, [docId, pageIndex, version]);

  // Text already recognized on this page.
  useEffect(() => {
    let alive = true;
    setSeen(null);
    void seenPages.get(seenKey)?.then((b) => alive && setSeen(b), () => {});
    return () => {
      alive = false;
    };
  }, [seenKey]);

  // The fonts to offer, found while the tool is open (the computer's fonts take a moment).
  useEffect(() => {
    let alive = true;
    void import("../lib/fontMatch")
      .then(({ fontMenu }) => fontMenu())
      .then((list) => alive && setFontList(list.map((f) => ({ family: f.family, installed: f.category === "installed" }))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The page's fonts: for showing text given another weight in the PDF's own font, and for the font menu.
  const pageFonts = useMemo(() => {
    const faces = new Map<string, string>();
    const families = new Map<string, string>();
    for (const r of layout?.runs ?? []) {
      const family = parseFontName(r.psName).family;
      if (!family) continue;
      const key = familyKey(family);
      if (!families.has(key)) families.set(key, family);
      const face = `${key}|${r.weight}|${r.italic}`;
      if (!faces.has(face)) faces.set(face, r.fontName);
    }
    return { faces, families: [...families.values()].sort((a, b) => a.localeCompare(b)) };
  }, [layout]);
  const fonts = useMemo<FontMenu>(() => ({ document: pageFonts.families, others: fontList }), [pageFonts, fontList]);

  // The page's own text: not what earlier versions' edits replaced, nor an invisible OCR layer.
  const visibleBlocks = useMemo(
    () =>
      (layout?.blocks ?? []).filter(
        (b) => !edits.some((e) => rectsIntersect(inflateRect(e.originalRect, -1), b.rect)) && !b.lines.every((l) => l.runs.every((r) => drawn?.hidden.has(r))),
      ),
    [layout, edits, drawn],
  );
  const realText = visibleBlocks.reduce((n, b) => n + b.text.replace(/\s/g, "").length, 0);
  const scarce = !!layout && realText < SCARCE;
  // Recognized text the page's own text hasn't taken the place of (as edited text does).
  const seenBlocks = useMemo(
    () => (seen ?? []).filter((s) => !visibleBlocks.some((b) => rectsIntersect(b.rect, s.rect, -0.5)) && !edits.some((e) => rectsIntersect(e.rect, s.rect))),
    [seen, visibleBlocks, edits],
  );

  // Colors are sampled while the user types, so committing is instant.
  const colorsFor = useRef<{ block: TextBlock; colors: Promise<{ background: string; foreground: string }> } | null>(null);

  const startBlock = async (b: TextBlock) => {
    const rt = getRuntime(docId);
    const colors = rt ? sampleRegionColors(rt.pdf, pageIndex, b.rect).catch(() => ({ background: "#ffffff", foreground: "#000000" })) : null;
    if (colors) colorsFor.current = { block: b, colors };
    // The letters' colors are read when the tool opens: usually ready by the time a paragraph is clicked.
    const known = await Promise.race([glyphs.current, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    const source = withRunText(b, (r) => known?.texts.get(r));
    const { bases, chars } = richBlock(source, known);
    const n = b.lines.length;
    setEditing({
      annotId: null,
      block: b,
      source,
      seen: null,
      rect: b.rect,
      text: source.text,
      fontFamily: familyOf(b.family),
      fontSize: Math.round(b.size * 10) / 10,
      bold: b.bold,
      italic: b.italic,
      maxRight: n > 1 ? b.rect[2] : lineLimit(b, layout?.blocks ?? []),
      bases,
      chars,
      align: alignOf(b),
      leading: n > 1 ? Math.max(1, (b.lines[0].baseline - b.lines[n - 1].baseline) / (n - 1) / b.size) : 1.2,
      formatting: true,
    });
    void colors?.then((c) => setEditing((e) => (e?.block === b ? { ...e, color: c.foreground, background: c.background } : e)));
  };

  const startSeen = (s: SeenBlock) => {
    const bases: BaseStyle[] = [];
    const index = new Map<string, number>();
    const chars: RichChar[] = [];
    s.lines.forEach((l, i) => {
      const k = l.look;
      const key = JSON.stringify(k);
      let base = index.get(key);
      if (base === undefined) {
        index.set(key, (base = bases.length));
        bases.push({ fontName: "", family: k.family, psName: "", kind: k.kind, weight: k.weight, italic: k.italic, size: k.size, color: k.color, spacing: k.spacing });
      }
      if (i > 0) chars.push({ ch: "\n", base, f: {} });
      for (const ch of l.text) chars.push({ ch, base, f: {} });
    });
    const first = s.lines[0].look;
    const n = s.lines.length;
    const pageRight = layout?.view[2] ?? s.rect[2];
    setEditing({
      annotId: null,
      block: null,
      source: null,
      seen: s,
      rect: s.rect,
      text: s.text,
      fontFamily: familyOf(first.kind),
      fontSize: first.size,
      bold: first.weight >= 600,
      italic: first.italic,
      maxRight: n > 1 ? s.rect[2] : Math.max(s.rect[2], pageRight - first.size),
      bases,
      chars,
      align: s.align,
      leading: n > 1 ? Math.max(1, (s.lines[0].baseline - s.lines[n - 1].baseline) / (n - 1) / first.size) : 1.2,
      color: first.color,
      background: s.background,
      formatting: true,
    });
  };

  const startEdit = (a: TextEditAnnot) => {
    const base: BaseStyle = { fontName: "", family: "", psName: stdFontName(a.fontFamily, a.bold, a.italic), kind: a.fontFamily === "Times" ? "serif" : a.fontFamily === "Courier" ? "monospace" : "sans-serif", weight: a.bold ? 700 : 400, italic: a.italic, size: a.fontSize };
    setEditing({
      annotId: a.id,
      block: null,
      source: null,
      seen: null,
      rect: a.rect,
      text: a.text,
      fontFamily: a.fontFamily,
      fontSize: a.fontSize,
      bold: a.bold,
      italic: a.italic,
      color: a.textColor,
      maxRight: a.rect[2],
      bases: [base],
      chars: [...a.text].map((ch) => ({ ch, base: 0, f: {} })),
      align: "left",
      leading: 1.2,
      formatting: false,
    });
  };

  /** Recognizes the text in the page's pictures; then edits the text at `at`, if any. */
  const recognize = async (at?: { x: number; y: number }) => {
    const rt = getRuntime(docId);
    if (!rt || recognizing !== null) return;
    if (page.rotate % 360) {
      toast("Text in pictures can be edited on pages that aren't turned. Turn the page back first (Organize pages).", "info");
      return;
    }
    setRecognizing(0);
    let found = seenPages.get(seenKey);
    if (!found) {
      found = import("../ops/recognize").then((m) => m.recognizeText(rt.pdf, pageIndex, (p) => setRecognizing((r) => (r === null ? r : p))));
      seenPages.set(seenKey, found);
      found.catch(() => seenPages.delete(seenKey));
    }
    try {
      const blocks = await found;
      setSeen(blocks);
      if (!blocks.length) toast("No text was found in the pictures on this page.", "info");
      else if (at) {
        const hit = blocks.find((b) => rectContainsPoint(inflateRect(b.rect, 3), at));
        if (hit) startSeen(hit);
      }
    } catch (e) {
      toast(`The text couldn't be recognized: ${(e as Error)?.message ?? e}`, "error");
    } finally {
      setRecognizing(null);
    }
  };
  const recognizeRef = useRef(recognize);
  recognizeRef.current = recognize;
  // The "Recognize text" command, for this page.
  useEffect(() => {
    const check = () => {
      if (takeRecognition(docId, pageIndex)) void recognizeRef.current();
    };
    check();
    return onRecognitionRequest(check);
  }, [docId, pageIndex]);

  const commit = async () => {
    const ed = editing;
    const read = result.current;
    if (!ed || !read || done.current === ed) return;
    done.current = ed;
    const out = read();
    let text = out.text;
    const formats = out.formats.slice();
    // A line break typed at the end adds nothing.
    while (text.endsWith("\n")) {
      text = text.slice(0, -1);
      formats.pop();
    }
    setEditing(null);
    if (ed.annotId) {
      const a = edits.find((x) => x.id === ed.annotId);
      if (!a) return;
      if (text === a.text) return;
      if (text === a.originalText) {
        deleteAnnotations(docId, [a.id], "Revert text edit");
        return;
      }
      updateAnnotation(docId, a.id, { text, rect: fitRect(a.rect, text, a) } as never, "Edit text");
      return;
    }
    const formatted = formats.some(Boolean);
    if (ed.seen) {
      const s = ed.seen;
      if (text === s.text && !formatted && !out.align) return;
      await commitSeen(s, ed.bases, text, formats, out);
      return;
    }
    const b = ed.source;
    if (!b || (text === b.text && !formatted && !out.align)) return;
    const rt = getRuntime(docId);
    if (!rt || !getDoc(docId)) return;
    const pending = colorsFor.current?.block === ed.block ? colorsFor.current.colors : sampleRegionColors(rt.pdf, pageIndex, b.rect);
    const colors = await pending.catch(() => ({ background: "#ffffff", foreground: "#000000" }));
    // The change is made in the page right away (and can be undone), keeping its fonts and layout.
    const request: TextEditRequest = {
      pageIndex,
      lines: b.lines.map((l, i) => ({ text: l.text, rect: l.rect, baseline: l.baseline, sep: b.seps[i] ?? "" })),
      before: b.text,
      after: text,
      background: colors.background,
      fallback: { size: ed.fontSize, color: colors.foreground, bold: ed.bold, italic: ed.italic, family: ed.fontFamily },
      formats: formatted ? formats : undefined,
      align: out.align,
    };
    await withBusy("Updating text…", () =>
      applyDocumentChange(docId, "Edit text", async ({ bytes, pageIds }) => {
        const doc = await loadPdfLib(bytes);
        const { editPageText } = await import("../ops/editText");
        await editPageText(doc, request, new FontCache(doc));
        return { bytes: await doc.save(), pageIds };
      }),
    ).catch(() => {});
  };

  /** Writes recognized text again as real text, as edited, over its picture. */
  const commitSeen = async (s: SeenBlock, bases: BaseStyle[], text: string, formats: EditorResult["formats"], out: EditorResult) => {
    const looks: SeenCharLook[] = [];
    for (let i = 0; i < text.length; i++) {
      const b = bases[out.bases[i]] ?? bases[0];
      const f = formats[i] ?? {};
      looks.push({
        family: f.family ?? b.family,
        kind: b.kind,
        weight: f.weight ?? b.weight,
        italic: f.italic ?? b.italic,
        size: f.size ?? b.size,
        spacing: b.spacing ?? 0,
        color: f.color ?? b.color ?? "#000000",
        underline: f.underline,
        strike: f.strike,
        highlight: f.highlight,
      });
    }
    // The old letters are covered, a little beyond their box, but not over the text around them.
    const size = Math.max(...s.lines.map((l) => l.look.size));
    const cover: PdfRect = inflateRect(s.rect, size * 0.22);
    const others = [...visibleBlocks.map((b) => b.rect), ...seenBlocks.filter((o) => o !== s).map((o) => o.rect)];
    for (const o of others) {
      const across = o[0] < s.rect[2] && o[2] > s.rect[0];
      const along = o[1] < s.rect[3] && o[3] > s.rect[1];
      if (across && o[1] >= s.rect[3]) cover[3] = Math.min(cover[3], (s.rect[3] + o[1]) / 2);
      if (across && o[3] <= s.rect[1]) cover[1] = Math.max(cover[1], (s.rect[1] + o[3]) / 2);
      if (along && o[0] >= s.rect[2]) cover[2] = Math.min(cover[2], (s.rect[2] + o[0]) / 2);
      if (along && o[2] <= s.rect[0]) cover[0] = Math.max(cover[0], (s.rect[0] + o[2]) / 2);
    }
    const request = {
      pageIndex,
      cover,
      background: s.background,
      patch: s.patch,
      lines: s.lines.map((l) => ({ left: l.left, right: l.rect[2], baseline: l.baseline })),
      align: out.align ?? s.align,
      text,
      looks,
    };
    await withBusy("Updating text…", () =>
      applyDocumentChange(docId, "Edit text", async ({ bytes, pageIds }) => {
        const doc = await loadPdfLib(bytes);
        const { editSeenText } = await import("../ops/editText");
        await editSeenText(doc, request, new FontCache(doc));
        return { bytes: await doc.save(), pageIds };
      }),
    ).catch(() => {});
  };

  const block = (key: string | number, rect: PdfRect, className: string, open: () => void) => {
    const box = stageBox(ctx.m, rect);
    return (
      <div
        key={key}
        className={className}
        style={{ left: box.x - 2, top: box.y - 2, width: box.w + 4, height: box.h + 4 }}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (editing) void commit();
          open();
        }}
      />
    );
  };
  const offer = scarce && !seen;

  return (
    <>
      <div className="doxxta-stage doxxta-textedit-layer" style={{ width: geo.width, height: geo.height }}>
        {!layout && <div className="doxxta-textedit-loading">Analyzing text…</div>}
        {offer && (
          // On a page whose text is in pictures, tapping the text recognizes it first (a tap, not a
          // finger scrolling the page).
          <div
            className="doxxta-recognize-catcher"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void recognize(apply(invert(ctx.m), e.nativeEvent.offsetX, e.nativeEvent.offsetY));
            }}
          />
        )}
        {visibleBlocks.map((b, i) => (editing?.block === b ? null : block(i, b.rect, "doxxta-text-block", () => void startBlock(b))))}
        {seenBlocks.map((s, i) => (editing?.seen === s ? null : block(`seen${i}`, s.rect, "doxxta-text-block is-seen", () => startSeen(s))))}
        {edits.map((a) => (editing?.annotId === a.id ? null : block(a.id, a.rect, "doxxta-text-block is-edited", () => startEdit(a))))}
      </div>
      {(offer || recognizing !== null) && (
        <button
          type="button"
          className="doxxta-recognize"
          style={{ left: (geo.width * scale) / 2, top: 10 }}
          disabled={recognizing !== null}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void recognize()}
        >
          {recognizing !== null ? <LoaderCircle size={15} className="spin" /> : <ScanText size={15} />}
          {recognizing !== null ? `Recognizing text… ${Math.round(recognizing * 100)}%` : "Recognize text to edit it"}
        </button>
      )}
      {editing && (
        <TextEditorBox
          key={editing.annotId ?? `${editing.rect.join(",")}|${editing.text}`}
          editing={editing}
          ctx={ctx}
          scale={scale}
          geo={geo}
          pageFaces={pageFonts.faces}
          fonts={fonts}
          resultRef={result}
          onCommit={() => void commit()}
          onCancel={() => {
            done.current = editing;
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** The block's text with the style of each character's run (and its color). */
function richBlock(b: TextBlock, drawn: RunGlyphs | null): { bases: BaseStyle[]; chars: RichChar[] } {
  const inks = drawn?.inks;
  const bases: BaseStyle[] = [];
  const index = new Map<string, number>();
  const baseOf = (r: TextRun, color: string | undefined) => {
    const size = Math.round(r.size * 10) / 10;
    const spacing = drawn?.spacing.get(r);
    const key = `${r.fontName}|${size}|${r.weight}|${r.italic}|${color}|${spacing}`;
    let i = index.get(key);
    if (i === undefined) {
      index.set(key, (i = bases.length));
      bases.push({ fontName: r.fontName, family: parseFontName(r.psName).family, psName: r.psName, kind: r.family, weight: r.weight, italic: r.italic, size, color, spacing });
    }
    return i;
  };
  const chars: RichChar[] = [];
  b.lines.forEach((l, li) => {
    // Letters seen so far in each run, and the color of the last one.
    const seen = l.runs.map(() => 0);
    const last: (string | undefined)[] = l.runs.map(() => undefined);
    let k = 0;
    for (const ch of l.text) {
      const ri = l.runOf[k] ?? 0;
      const r = l.runs[ri];
      if (/\S/.test(ch)) last[ri] = inks?.get(r)?.[seen[ri]++] ?? last[ri] ?? inks?.get(r)?.[0];
      chars.push({ ch, base: baseOf(r, last[ri] ?? inks?.get(r)?.[0]), f: {} });
      k += ch.length;
    }
    const end = l.runs.length - 1;
    for (const ch of b.seps[li] ?? "") chars.push({ ch, base: baseOf(l.runs[end], last[end] ?? inks?.get(l.runs[end])?.[0]), f: {} });
  });
  if (chars.map((c) => c.ch).join("") !== b.text) return { bases: bases.slice(0, 1), chars: [...b.text].map((ch) => ({ ch, base: 0, f: {} })) };
  return { bases, chars };
}

/** How the page's content draws each run. */
interface RunGlyphs {
  /** The colors of its letters (not spaces), in order. */
  inks: Map<TextRun, string[]>;
  /** Runs drawn only invisibly: an OCR layer over a picture. */
  hidden: Set<TextRun>;
  /** Letter-spaced runs' text, without the spaces pdf.js reads between their letters. */
  texts: Map<TextRun, string>;
  /** Letter-spaced runs' space after each letter, in points. */
  spacing: Map<TextRun, number>;
}

const parsed = new WeakMap<Uint8Array, Promise<PDFDocument>>();

/** How the page's content draws each run, from the glyphs under it. */
async function runGlyphs(bytes: Uint8Array | undefined, pageIndex: number, runs: TextRun[]): Promise<RunGlyphs | null> {
  // Very large files would take long to read again.
  if (!bytes || bytes.length > 40e6) return null;
  let doc = parsed.get(bytes);
  if (!doc) parsed.set(bytes, (doc = loadPdfLib(bytes)));
  const d = await doc.catch(() => null);
  const page = d?.getPages()[pageIndex];
  if (!d || !page) return null;
  const { extractGlyphs } = await import("../ops/contentRedact");
  const all = ((await extractGlyphs(d, page).catch(() => null)) ?? []).filter((g) => g.style && g.text.trim());
  const invisible = (g: PageGlyph) => g.style!.mode === 3 || g.style!.mode === 7;
  const out: RunGlyphs = { inks: new Map(), hidden: new Set(), texts: new Map(), spacing: new Map() };
  for (const r of runs) {
    const under = all
      .filter((g) => {
        const x = (g.origin.x + g.end.x) / 2;
        return x >= r.rect[0] - 0.5 && x <= r.rect[2] + 0.5 && Math.abs(g.origin.y - r.y) <= r.size * 0.3;
      })
      .sort((a, c) => a.origin.x - c.origin.x);
    const drawn = under.filter((g) => !invisible(g));
    if (!drawn.length) {
      if (under.length) out.hidden.add(r);
      continue;
    }
    // A ligature glyph colors each of its letters.
    out.inks.set(
      r,
      drawn.flatMap((g) => Array.from({ length: [...g.text.replace(/\s/g, "")].length }, () => g.style!.fill)),
    );
    // Letter-spaced text: pdf.js reads a space wherever letters are apart by a tenth of the size.
    const tc = drawn[0].style!.tc;
    if (tc > r.size * 0.05 && /\S \S/.test(r.str)) {
      const text = spacedText(drawn, r.size);
      if (text !== r.str && text.replace(/\s/g, "") === r.str.replace(/\s/g, "")) {
        out.texts.set(r, text);
        out.spacing.set(r, Math.round(tc * 100) / 100);
      }
    }
  }
  return out;
}

/** The text of letter-spaced glyphs: spaces only where there is a space, or a gap between words. */
function spacedText(glyphs: PageGlyph[], size: number): string {
  let text = glyphs[0].text;
  for (let i = 1; i < glyphs.length; i++) {
    const gap = glyphs[i].origin.x - glyphs[i - 1].end.x;
    if (gap > size * 0.2 && !/\s$/.test(text) && !/^\s/.test(glyphs[i].text)) text += " ";
    text += glyphs[i].text;
  }
  return text.replace(/\s+/g, " ").trim();
}

/** How a block looks aligned, from its lines' edges (one line counts as left-aligned). */
function alignOf(b: TextBlock): TextAlign {
  const n = b.lines.length;
  if (n < 2) return "left";
  const lefts = b.lines.map((l) => l.rect[0]);
  const rights = b.lines.map((l) => l.rect[2]);
  const near = (a: number, c: number, tol: number) => Math.abs(a - c) <= tol;
  const maxRight = Math.max(...rights);
  const flushLeft = lefts.every((x) => near(x, lefts[0], 1.5));
  if (flushLeft && rights.slice(0, -1).every((x) => near(x, maxRight, 1.5)) && rights[n - 1] < maxRight - 3 && n > 2) return "justify";
  if (!flushLeft && rights.every((x) => near(x, rights[0], 1))) return "right";
  const centers = lefts.map((l, i) => (l + rights[i]) / 2);
  if (!flushLeft && centers.every((c) => near(c, centers[0], 1.5))) return "center";
  return "left";
}

/** How far right a one-line block may grow: up to the next text on its line, or the right edge of the page's text. */
function lineLimit(b: TextBlock, blocks: TextBlock[]): number {
  const [, y0, x1, y1] = b.rect;
  const beside = blocks.filter((o) => o !== b && o.rect[0] > x1 && o.rect[1] < y1 && o.rect[3] > y0);
  if (beside.length) return Math.max(x1, Math.min(...beside.map((o) => o.rect[0])) - b.size * 0.8);
  return Math.max(x1, ...blocks.map((o) => o.rect[2]));
}

function fitRect(rect: PdfRect, text: string, a: { fontFamily: FontFamily; bold: boolean; italic: boolean; fontSize: number; lineHeight?: number }): PdfRect {
  const width = rect[2] - rect[0];
  const lines = wrapText(text, stdFontName(a.fontFamily, a.bold, a.italic), a.fontSize, width);
  const h = Math.max(a.fontSize * 1.2, lines.length * a.fontSize * (a.lineHeight ?? 1.2));
  return [rect[0], rect[3] - h, rect[2], rect[3]];
}
