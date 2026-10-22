import { useEffect, useMemo, useRef, useState } from "react";
import type { FontFamily, TextEditAnnot } from "../annotations/types";
import { stageBox, type RenderCtx } from "../annotations/render";
import { analyzePage, type TextBlock } from "../lib/textLayout";
import { getRuntime } from "../state/runtime";
import { getDoc, useApp, withBusy } from "../state/store";
import { deleteAnnotations, updateAnnotation } from "../state/annotActions";
import { CSS_FONT, stdFontName, wrapText } from "../lib/fontMetrics";
import { sampleRegionColors } from "../lib/colorSample";
import { inflateRect, rectsIntersect, type PdfRect } from "../lib/geometry";
import { applyDocumentChange } from "../core/document";
import { FontCache, loadPdfLib } from "../lib/pdflib";

const familyOf = (f: TextBlock["family"]): FontFamily => (f === "serif" ? "Times" : f === "monospace" ? "Courier" : "Helvetica");

interface Editing {
  /** Existing text edit being changed, or null for a new edit of `block`. */
  annotId: string | null;
  block: TextBlock | null;
  rect: PdfRect;
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** CSS font family: the PDF's own font (as loaded by pdf.js) with a fallback. */
  cssFont: string;
  color?: string;
  /** How far right the text may run: a single line grows up to the next text beside it or the page's text margin. */
  maxRight: number;
}

/**
 * Edit PDF → Edit text: outlines text blocks on hover; clicking opens an
 * in-place editor. Committing records a "textedit" that replaces the
 * original text when the PDF is saved.
 */
export function TextEditLayer({ docId, pageIndex, ctx, geo }: { docId: string; pageIndex: number; ctx: RenderCtx; geo: { width: number; height: number } }) {
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const page = useApp((s) => s.docs[docId].pages[pageIndex]);
  const all = useApp((s) => s.docs[docId].annotations);
  const edits = useMemo(() => all.filter((a): a is TextEditAnnot => a.kind === "textedit" && a.pageId === page.id), [all, page.id]);
  const version = useApp((s) => s.docs[docId].version);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rt = getRuntime(docId);
    if (!rt) return;
    let alive = true;
    analyzePage(rt.pdf, pageIndex)
      .then((l) => alive && setBlocks(l.blocks.filter((b) => Math.abs(b.lines[0].angle) < 0.02)))
      .catch(() => alive && setBlocks([]));
    return () => {
      alive = false;
    };
  }, [docId, pageIndex, version]);

  const visibleBlocks = useMemo(
    () => (blocks ?? []).filter((b) => !edits.some((e) => rectsIntersect(inflateRect(e.originalRect, -1), b.rect))),
    [blocks, edits],
  );

  // Colors are sampled while the user types, so committing is instant.
  const colorsFor = useRef<{ block: TextBlock; colors: Promise<{ background: string; foreground: string }> } | null>(null);

  const startBlock = (b: TextBlock) => {
    const rt = getRuntime(docId);
    const colors = rt ? sampleRegionColors(rt.pdf, pageIndex, b.rect).catch(() => ({ background: "#ffffff", foreground: "#000000" })) : null;
    if (colors) colorsFor.current = { block: b, colors };
    const fontFamily = familyOf(b.family);
    setEditing({
      annotId: null,
      block: b,
      rect: b.rect,
      text: b.text,
      fontFamily,
      fontSize: Math.round(b.size * 10) / 10,
      bold: b.bold,
      italic: b.italic,
      cssFont: `"${b.fontName}", ${CSS_FONT[fontFamily]}`,
      maxRight: b.lines.length > 1 ? b.rect[2] : lineLimit(b, blocks ?? []),
    });
    void colors?.then((c) => setEditing((e) => (e?.block === b ? { ...e, color: c.foreground } : e)));
  };

  const startEdit = (a: TextEditAnnot) => {
    setEditing({ annotId: a.id, block: null, rect: a.rect, text: a.text, fontFamily: a.fontFamily, fontSize: a.fontSize, bold: a.bold, italic: a.italic, cssFont: CSS_FONT[a.fontFamily], color: a.textColor, maxRight: a.rect[2] });
  };

  const commit = async () => {
    const ed = editing;
    const el = editorRef.current;
    if (!ed || !el) return;
    const text = el.innerText.replace(/\n$/, "");
    setEditing(null);
    if (ed.annotId) {
      const a = edits.find((x) => x.id === ed.annotId);
      if (!a) return;
      if (text === a.text) return;
      if (text === a.originalText) {
        deleteAnnotations(docId, [a.id], "Revert text edit");
        return;
      }
      updateAnnotation(docId, a.id, { text, rect: fitRect(a.rect, text, a), } as never, "Edit text");
      return;
    }
    const b = ed.block;
    if (!b || text === b.text) return;
    const rt = getRuntime(docId);
    if (!rt || !getDoc(docId)) return;
    const pending = colorsFor.current?.block === b ? colorsFor.current.colors : sampleRegionColors(rt.pdf, pageIndex, b.rect);
    const colors = await pending.catch(() => ({ background: "#ffffff", foreground: "#000000" }));
    // The change is made in the page right away (and can be undone), keeping its fonts and layout.
    const request = {
      pageIndex,
      lines: b.lines.map((l, i) => ({ text: l.text, rect: l.rect, baseline: l.baseline, sep: b.seps[i] ?? "" })),
      before: b.text,
      after: text,
      background: colors.background,
      fallback: { size: ed.fontSize, color: colors.foreground, bold: ed.bold, italic: ed.italic, family: ed.fontFamily },
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

  useEffect(() => {
    if (!editing || !editorRef.current) return;
    const el = editorRef.current;
    el.innerText = editing.text;
    el.focus();
    const sel = window.getSelection();
    sel?.selectAllChildren(el);
    sel?.collapseToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.annotId, editing?.block]);

  return (
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
              startBlock(b);
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
      {editing && (
        <EditorBox editing={editing} ctx={ctx} editorRef={editorRef} onCommit={() => void commit()} onCancel={() => setEditing(null)} />
      )}
    </div>
  );
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

function EditorBox({ editing, ctx, editorRef, onCommit, onCancel }: { editing: Editing; ctx: RenderCtx; editorRef: React.RefObject<HTMLDivElement | null>; onCommit: () => void; onCancel: () => void }) {
  const box = stageBox(ctx.m, editing.rect);
  const room = stageBox(ctx.m, [editing.rect[0], editing.rect[1], Math.max(editing.rect[2], editing.maxRight), editing.rect[3]]);
  return (
    <>
      <div className="doxxta-textedit-cover is-live" style={{ left: box.x - 1, top: box.y - 1, width: box.w + 2, height: box.h + 2 }} />
      <div
        ref={editorRef}
        className="doxxta-textedit-editor"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck
        style={{
          left: box.x - 2,
          top: box.y - 2,
          width: "max-content",
          minWidth: box.w + 4,
          maxWidth: room.w + 4,
          minHeight: box.h + 4,
          fontFamily: editing.cssFont,
          fontSize: editing.fontSize,
          fontWeight: editing.bold ? 700 : 400,
          fontStyle: editing.italic ? "italic" : "normal",
          fontSynthesis: "none",
          color: editing.color,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onCommit();
          }
        }}
        onBlur={onCommit}
      />
    </>
  );
}
