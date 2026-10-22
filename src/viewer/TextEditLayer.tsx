import { useEffect, useMemo, useRef, useState } from "react";
import type { FontFamily, TextEditAnnot } from "../annotations/types";
import { stageBox, type RenderCtx } from "../annotations/render";
import { analyzePage, type TextBlock, type TextRun } from "../lib/textLayout";
import { getRuntime } from "../state/runtime";
import { getDoc, useApp, withBusy } from "../state/store";
import { deleteAnnotations, updateAnnotation } from "../state/annotActions";
import { stdFontName, wrapText } from "../lib/fontMetrics";
import { sampleRegionColors } from "../lib/colorSample";
import { inflateRect, rectsIntersect, type PdfRect } from "../lib/geometry";
import { applyDocumentChange } from "../core/document";
import { FontCache, loadPdfLib, type PDFDocument } from "../lib/pdflib";
import { familyKey, parseFontName } from "../lib/fontNames";
import type { TextAlign, TextEditRequest } from "../ops/editText";
import type { BaseStyle, RichChar } from "./richText";
import { TextEditorBox, type EditorResult, type RichEditing } from "./TextEditorBox";
import type { FontMenu } from "./TextFormatBar";

const familyOf = (f: TextBlock["family"]): FontFamily => (f === "serif" ? "Times" : f === "monospace" ? "Courier" : "Helvetica");

interface Editing extends RichEditing {
  /** Existing text edit being changed, or null for a new edit of `block`. */
  annotId: string | null;
  block: TextBlock | null;
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
}

/**
 * Edit PDF → Edit text: outlines text blocks on hover; clicking opens an
 * in-place editor with a formatting toolbar. Committing changes the page's
 * text right away, keeping its fonts and layout.
 */
export function TextEditLayer({ docId, pageIndex, ctx, geo, scale }: { docId: string; pageIndex: number; ctx: RenderCtx; geo: { width: number; height: number }; scale: number }) {
  const [layout, setLayout] = useState<{ blocks: TextBlock[]; runs: TextRun[] } | null>(null);
  // The colors of each run's letters, read from the page (after its layout).
  const inks = useRef<Promise<Inks | null>>(Promise.resolve(null));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [fontList, setFontList] = useState<FontMenu["others"]>([]);
  const page = useApp((s) => s.docs[docId].pages[pageIndex]);
  const all = useApp((s) => s.docs[docId].annotations);
  const edits = useMemo(() => all.filter((a): a is TextEditAnnot => a.kind === "textedit" && a.pageId === page.id), [all, page.id]);
  const version = useApp((s) => s.docs[docId].version);
  const result = useRef<(() => EditorResult) | null>(null);
  // The edit being committed, so it's committed once.
  const done = useRef<Editing | null>(null);
  const blocks = layout?.blocks ?? null;

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
        setLayout({ blocks: l.blocks.filter((b) => Math.abs(b.lines[0].angle) < 0.02), runs: l.runs });
        inks.current = runColors(getRuntime(docId)?.bytes, pageIndex, l.runs).catch(() => null);
      })
      .catch(() => alive && setLayout({ blocks: [], runs: [] }));
    return () => {
      alive = false;
    };
  }, [docId, pageIndex, version]);

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

  const visibleBlocks = useMemo(
    () => (blocks ?? []).filter((b) => !edits.some((e) => rectsIntersect(inflateRect(e.originalRect, -1), b.rect))),
    [blocks, edits],
  );

  // Colors are sampled while the user types, so committing is instant.
  const colorsFor = useRef<{ block: TextBlock; colors: Promise<{ background: string; foreground: string }> } | null>(null);

  const startBlock = async (b: TextBlock) => {
    const rt = getRuntime(docId);
    const colors = rt ? sampleRegionColors(rt.pdf, pageIndex, b.rect).catch(() => ({ background: "#ffffff", foreground: "#000000" })) : null;
    if (colors) colorsFor.current = { block: b, colors };
    // The letters' colors are read when the tool opens: usually ready by the time a paragraph is clicked.
    const known = await Promise.race([inks.current, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    const { bases, chars } = richBlock(b, known);
    const n = b.lines.length;
    setEditing({
      annotId: null,
      block: b,
      rect: b.rect,
      text: b.text,
      fontFamily: familyOf(b.family),
      fontSize: Math.round(b.size * 10) / 10,
      bold: b.bold,
      italic: b.italic,
      maxRight: n > 1 ? b.rect[2] : lineLimit(b, blocks ?? []),
      bases,
      chars,
      align: alignOf(b),
      leading: n > 1 ? Math.max(1, (b.lines[0].baseline - b.lines[n - 1].baseline) / (n - 1) / b.size) : 1.2,
      formatting: true,
    });
    void colors?.then((c) => setEditing((e) => (e?.block === b ? { ...e, color: c.foreground } : e)));
  };

  const startEdit = (a: TextEditAnnot) => {
    const base: BaseStyle = { fontName: "", family: "", psName: stdFontName(a.fontFamily, a.bold, a.italic), kind: a.fontFamily === "Times" ? "serif" : a.fontFamily === "Courier" ? "monospace" : "sans-serif", weight: a.bold ? 700 : 400, italic: a.italic, size: a.fontSize };
    setEditing({
      annotId: a.id,
      block: null,
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
    const b = ed.block;
    const formatted = formats.some(Boolean);
    if (!b || (text === b.text && !formatted && !out.align)) return;
    const rt = getRuntime(docId);
    if (!rt || !getDoc(docId)) return;
    const pending = colorsFor.current?.block === b ? colorsFor.current.colors : sampleRegionColors(rt.pdf, pageIndex, b.rect);
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

  return (
    <>
      <div className="doxxta-stage doxxta-textedit-layer" style={{ width: geo.width, height: geo.height }}>
        {blocks === null && <div className="doxxta-textedit-loading">Analyzing text…</div>}
        {visibleBlocks.map((b, i) => {
          const box = stageBox(ctx.m, b.rect);
          if (editing?.block === b) return null;
          return (
            <div
              key={i}
              className="doxxta-text-block"
              style={{ left: box.x - 2, top: box.y - 2, width: box.w + 4, height: box.h + 4 }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (editing) void commit();
                void startBlock(b);
              }}
            />
          );
        })}
        {edits.map((a) => {
          if (editing?.annotId === a.id) return null;
          const box = stageBox(ctx.m, a.rect);
          return (
            <div
              key={a.id}
              className="doxxta-text-block is-edited"
              style={{ left: box.x - 2, top: box.y - 2, width: box.w + 4, height: box.h + 4 }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (editing) void commit();
                startEdit(a);
              }}
            />
          );
        })}
      </div>
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

/** The colors of the letters (not spaces) of each run, in order. */
type Inks = Map<TextRun, string[]>;

/** The block's text with the style of each character's run (and its color). */
function richBlock(b: TextBlock, inks: Inks | null): { bases: BaseStyle[]; chars: RichChar[] } {
  const bases: BaseStyle[] = [];
  const index = new Map<string, number>();
  const baseOf = (r: TextRun, color: string | undefined) => {
    const size = Math.round(r.size * 10) / 10;
    const key = `${r.fontName}|${size}|${r.weight}|${r.italic}|${color}`;
    let i = index.get(key);
    if (i === undefined) {
      index.set(key, (i = bases.length));
      bases.push({ fontName: r.fontName, family: parseFontName(r.psName).family, psName: r.psName, kind: r.family, weight: r.weight, italic: r.italic, size, color });
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

const parsed = new WeakMap<Uint8Array, Promise<PDFDocument>>();

/** The colors of each run's letters, from the glyphs the page's content draws under it. */
async function runColors(bytes: Uint8Array | undefined, pageIndex: number, runs: TextRun[]): Promise<Inks | null> {
  // Very large files would take long to read again.
  if (!bytes || bytes.length > 40e6) return null;
  let doc = parsed.get(bytes);
  if (!doc) parsed.set(bytes, (doc = loadPdfLib(bytes)));
  const d = await doc.catch(() => null);
  const page = d?.getPages()[pageIndex];
  if (!d || !page) return null;
  const { extractGlyphs } = await import("../ops/contentRedact");
  const glyphs = ((await extractGlyphs(d, page).catch(() => null)) ?? []).filter((g) => g.style && g.style.mode !== 3 && g.text.trim());
  const out: Inks = new Map();
  for (const r of runs) {
    const under = glyphs
      .filter((g) => {
        const x = (g.origin.x + g.end.x) / 2;
        return x >= r.rect[0] - 0.5 && x <= r.rect[2] + 0.5 && Math.abs(g.origin.y - r.y) <= r.size * 0.3;
      })
      .sort((a, c) => a.origin.x - c.origin.x);
    // A ligature glyph colors each of its letters.
    const colors = under.flatMap((g) => Array.from({ length: [...g.text.replace(/\s/g, "")].length }, () => g.style!.fill));
    if (colors.length) out.set(r, colors);
  }
  return out;
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
