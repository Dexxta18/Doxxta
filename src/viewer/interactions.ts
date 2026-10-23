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

    // Touch screens: two fingers zoom around the point between them (one finger scrolls).
    let pinch: number | null = null;
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      pinch = spread(e.touches);
      e.preventDefault();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (pinch === null || e.touches.length !== 2) return;
      e.preventDefault();
      const now = spread(e.touches);
      const factor = now / pinch;
      if (Math.abs(factor - 1) < 0.02) return;
      pinch = now;
      const [a, b] = [e.touches[0], e.touches[1]];
      pdfViewer.updateScale({ scaleFactor: factor, origin: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2], drawingDelay: 400 });
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    // Safari's own page zoom (gesture events): the pages zoom instead.
    const onGesture = (e: Event) => e.preventDefault();

    // Text selected by touch is adjusted with handles after the finger lifts: the menu follows the selection.
    let pointerType = "mouse";
    let selectionTimer: ReturnType<typeof setTimeout> | undefined;
    const onSelectionChange = () => {
      if (pointerType !== "touch") return;
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (useApp.getState().tool !== "select" || !useSettings.getState().showTextSelectionMenu) return;
        const sels = selectionToQuads(pdfViewer, container);
        if (sels.length && sels.some((s) => s.quads.length)) {
          const last = sels[sels.length - 1].lastRect;
          useTextSelectionMenu.setState({ docId, selections: sels, x: last.right, y: last.bottom + 8 });
        } else if (useTextSelectionMenu.getState().docId) {
          useTextSelectionMenu.setState({ docId: null });
        }
      }, 350);
    };

    // Hand tool: drag to pan.
    let pan: { x: number; y: number; left: number; top: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      pointerType = e.pointerType;
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
    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", onTouchEnd);
    container.addEventListener("gesturestart", onGesture);
    document.addEventListener("selectionchange", onSelectionChange);
    container.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      container.removeEventListener("gesturestart", onGesture);
      document.removeEventListener("selectionchange", onSelectionChange);
      clearTimeout(selectionTimer);
      container.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("scroll", onScroll);
    };
  }, [docId, handle]);
}
