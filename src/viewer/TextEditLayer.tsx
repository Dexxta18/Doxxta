import { useEffect, useMemo, useRef, useState } from "react";
import type { FontFamily, TextEditAnnot } from "../annotations/types";
import { stageBox, type RenderCtx } from "../annotations/render";
import { analyzePage, type TextBlock } from "../lib/textLayout";
import { getRuntime } from "../state/runtime";
import { getDoc, toast, useApp } from "../state/store";
import { addAnnotations, deleteAnnotations, updateAnnotation } from "../state/annotActions";
import { base } from "../annotations/factory";
import { CSS_FONT, stdFontName, wrapText } from "../lib/fontMetrics";
import { sampleRegionColors } from "../lib/colorSample";
import { inflateRect, rectsIntersect, type PdfRect } from "../lib/geometry";

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

  const startBlock = (b: TextBlock) => {
    setEditing({ annotId: null, block: b, rect: b.rect, text: b.text, fontFamily: familyOf(b.family), fontSize: Math.round(b.size * 10) / 10, bold: b.bold, italic: b.italic });
  };

  const startEdit = (a: TextEditAnnot) => {
    setEditing({ annotId: a.id, block: null, rect: a.rect, text: a.text, fontFamily: a.fontFamily, fontSize: a.fontSize, bold: a.bold, italic: a.italic });
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
    if (!ed.block || text === ed.block.text) return;
    const rt = getRuntime(docId);
    const doc = getDoc(docId);
    if (!rt || !doc) return;
    let colors = { background: "#ffffff", foreground: "#000000" };
    try {
      colors = await sampleRegionColors(rt.pdf, pageIndex, ed.block.rect);
    } catch (e) {
      console.warn("color sampling failed", e);
    }
    const lineHeight = ed.block.lines.length > 1 ? Math.min(2, Math.max(1, (ed.block.lines[0].baseline - ed.block.lines[ed.block.lines.length - 1].baseline) / (ed.block.lines.length - 1) / ed.fontSize)) : 1.2;
    const a: TextEditAnnot = {
      ...base("textedit", page.id, ed.block.rect, 0),
      originalRect: inflateRect(ed.block.rect, 0.5),
      originalText: ed.block.text,
      text,
      fontFamily: ed.fontFamily,
      fontSize: ed.fontSize,
      bold: ed.bold,
      italic: ed.italic,
      textColor: colors.foreground,
      backgroundColor: colors.background,
      lineHeight: Math.round(lineHeight * 100) / 100,
      align: "left",
      color: colors.foreground,
    } as TextEditAnnot;
    addAnnotations(docId, [{ ...a, rect: fitRect(ed.block.rect, text, a) }], "Edit text", false);
    toast("Text updated — the change is applied to the page when you save.", "success");
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
    <div className="folio-stage folio-textedit-layer" style={{ width: geo.width, height: geo.height }}>
      {blocks === null && <div className="folio-textedit-loading">Analyzing text…</div>}
      {visibleBlocks.map((b, i) => {
        const box = stageBox(ctx.m, b.rect);
        if (editing?.block === b) return null;
        return (
          <div
            key={i}
            className="folio-text-block"
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
            className="folio-text-block is-edited"
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

function fitRect(rect: PdfRect, text: string, a: { fontFamily: FontFamily; bold: boolean; italic: boolean; fontSize: number; lineHeight?: number }): PdfRect {
  const width = rect[2] - rect[0];
  const lines = wrapText(text, stdFontName(a.fontFamily, a.bold, a.italic), a.fontSize, width);
  const h = Math.max(a.fontSize * 1.2, lines.length * a.fontSize * (a.lineHeight ?? 1.2));
  return [rect[0], rect[3] - h, rect[2], rect[3]];
}

function EditorBox({ editing, ctx, editorRef, onCommit, onCancel }: { editing: Editing; ctx: RenderCtx; editorRef: React.RefObject<HTMLDivElement | null>; onCommit: () => void; onCancel: () => void }) {
  const box = stageBox(ctx.m, editing.rect);
  return (
    <>
      <div className="folio-textedit-cover is-live" style={{ left: box.x - 1, top: box.y - 1, width: box.w + 2, height: box.h + 2 }} />
      <div
        ref={editorRef}
        className="folio-textedit-editor"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck
        style={{
          left: box.x - 2,
          top: box.y - 2,
          width: box.w + 4,
          minHeight: box.h + 4,
          fontFamily: CSS_FONT[editing.fontFamily],
          fontSize: editing.fontSize,
          fontWeight: editing.bold ? 700 : 400,
          fontStyle: editing.italic ? "italic" : "normal",
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
