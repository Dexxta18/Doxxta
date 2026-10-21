import { useEffect } from "react";
import { create } from "zustand";
import { getViewer, type ViewerHandle } from "../state/runtime";
import { getDoc, useApp } from "../state/store";
import { selectionToQuads, type PageSelection } from "./textSelection";
import { createMarkup, createRedaction } from "../annotations/factory";
import { addAnnotations } from "../state/annotActions";
import { clearSelection } from "../core/annotOps";
import { useSettings } from "../state/settings";
import { unionRects, quadBounds } from "../lib/geometry";
import type { ToolId } from "../state/types";

/** Floating quick-actions menu shown after selecting text with the Select tool. */
export const useTextSelectionMenu = create<{ docId: string | null; selections: PageSelection[]; x: number; y: number } | { docId: null }>(() => ({ docId: null }));

const MARKUP_TOOLS: Partial<Record<ToolId, "highlight" | "underline" | "strikeout" | "squiggly">> = {
  highlight: "highlight",
  underline: "underline",
  strikeout: "strikeout",
  squiggly: "squiggly",
};

/** Creates markup annotations from the current text selection. */
export function markupFromSelection(docId: string, kind: "highlight" | "underline" | "strikeout" | "squiggly" | "redact", selections?: PageSelection[]): string[] {
  const doc = getDoc(docId);
  const v = getViewer(docId);
  const sels = selections ?? (v ? selectionToQuads(v.pdfViewer, v.container) : []);
  if (!doc || !sels.length) return [];
  const annots = sels
    .filter((s) => s.quads.length)
    .map((s) => {
      const page = doc.pages[s.pageIndex];
      const rotation = (page.rotate + doc.view.rotation) % 360;
      if (kind === "redact") return createRedaction(page.id, unionRects(s.quads.map(quadBounds))!, rotation, s.quads, s.text);
      const tool: ToolId = kind;
      return createMarkup(kind, tool, page.id, s.quads, rotation, s.text);
    });
  if (!annots.length) return [];
  addAnnotations(docId, annots, kind === "redact" ? "Mark for redaction" : `Add ${kind}`, false);
  window.getSelection()?.removeAllRanges();
  return annots.map((a) => a.id);
}

export function useViewerInteractions(docId: string, handle: ViewerHandle | null) {
  useEffect(() => {
    if (!handle) return;
    const { container, pdfViewer } = handle;

    // Ctrl/⌘ + wheel zooms around the pointer; trackpad pinch arrives as ctrl+wheel too.
    let wheelAccum = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      wheelAccum += e.deltaY * (e.deltaMode === 1 ? 30 : 1);
      const factor = Math.exp(-wheelAccum / 300);
      wheelAccum = 0;
      pdfViewer.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY], drawingDelay: 300 });
    };

    // Hand tool: drag to pan.
    let pan: { x: number; y: number; left: number; top: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      const tool = useApp.getState().tool;
      const target = e.target as HTMLElement;
      const middle = e.button === 1;
      if ((tool === "hand" && e.button === 0) || middle) {
        if (target.closest("[data-annot-id], .annot-toolbar, .note-popup, input, textarea, select")) return;
        pan = { x: e.clientX, y: e.clientY, left: container.scrollLeft, top: container.scrollTop };
        container.classList.add("is-panning");
        e.preventDefault();
        return;
      }
      if (e.button === 0 && !target.closest("[data-annot-id], [data-handle], .annot-toolbar, .note-popup, .selection-menu")) {
        // Clicking empty page area deselects annotations (Select tool).
        if (tool === "select" || tool in MARKUP_TOOLS || tool === "redact-text") clearSelection(docId);
        useTextSelectionMenu.setState({ docId: null });
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!pan) return;
      container.scrollLeft = pan.left - (e.clientX - pan.x);
      container.scrollTop = pan.top - (e.clientY - pan.y);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pan) {
        pan = null;
        container.classList.remove("is-panning");
        return;
      }
      const tool = useApp.getState().tool;
      // Let the browser finalize the selection first.
      setTimeout(() => {
        const kind = MARKUP_TOOLS[tool];
        if (kind || tool === "redact-text") {
          markupFromSelection(docId, kind ?? "redact");
          return;
        }
        if (tool === "select" && useSettings.getState().showTextSelectionMenu) {
          const sels = selectionToQuads(pdfViewer, container);
          if (sels.length && sels.some((s) => s.quads.length)) {
            const last = sels[sels.length - 1].lastRect;
            useTextSelectionMenu.setState({ docId, selections: sels, x: Math.min(e.clientX, last.right), y: last.bottom + 8 });
          } else {
            useTextSelectionMenu.setState({ docId: null });
          }
        }
      }, 0);
    };
    const onScroll = () => {
      if (useTextSelectionMenu.getState().docId) useTextSelectionMenu.setState({ docId: null });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("scroll", onScroll);
    };
  }, [docId, handle]);
}
