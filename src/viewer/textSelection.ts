import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { Quad } from "../lib/geometry";

export interface PageSelection {
  pageIndex: number;
  quads: Quad[];
  text: string;
  /** Client rect of the last line, for positioning popups. */
  lastRect: DOMRect;
}

/**
 * Converts the current DOM text selection (inside pdf.js text layers) into
 * per-page QuadPoints in PDF user space, merging fragments that sit on the
 * same line.
 */
export function selectionToQuads(pdfViewer: PDFViewer, container: HTMLElement): PageSelection[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const byPage = new Map<number, { rects: DOMRect[]; text: string }>();
  for (let r = 0; r < sel.rangeCount; r++) {
    const range = sel.getRangeAt(r);
    if (!container.contains(range.commonAncestorContainer)) continue;
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentNode! : range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode : walker.nextNode();
    while (node) {
      if (range.intersectsNode(node)) {
        const parent = node.parentElement;
        const layer = parent?.closest(".textLayer");
        const pageDiv = parent?.closest<HTMLElement>(".page");
        if (layer && pageDiv && !parent?.classList.contains("endOfContent")) {
          const pageIndex = Number(pageDiv.dataset.pageNumber) - 1;
          const sub = document.createRange();
          const len = node.textContent?.length ?? 0;
          const start = node === range.startContainer ? range.startOffset : 0;
          const end = node === range.endContainer ? range.endOffset : len;
          if (end > start) {
            sub.setStart(node, start);
            sub.setEnd(node, end);
            const entry = byPage.get(pageIndex) ?? { rects: [], text: "" };
            for (const rect of Array.from(sub.getClientRects())) if (rect.width > 0.5 && rect.height > 0.5) entry.rects.push(rect);
            const piece = (node.textContent ?? "").slice(start, end);
            const brk = parent?.nextSibling && (parent.nextSibling as HTMLElement).tagName === "BR";
            entry.text += piece + (brk ? "\n" : "");
            byPage.set(pageIndex, entry);
          }
        }
      }
      node = walker.nextNode();
    }
  }
  const out: PageSelection[] = [];
  for (const [pageIndex, { rects, text }] of byPage) {
    const pv = pdfViewer.getPageView(pageIndex);
    if (!pv?.div || !rects.length) continue;
    const merged = mergeLineRects(rects);
    const pr = pv.div.getBoundingClientRect();
    const ox = pr.left + pv.div.clientLeft;
    const oy = pr.top + pv.div.clientTop;
    const toPdf = (x: number, y: number) => pv.viewport.convertToPdfPoint(x - ox, y - oy) as [number, number];
    const quads = merged.map((r) => {
      const ul = toPdf(r.left, r.top);
      const ur = toPdf(r.right, r.top);
      const ll = toPdf(r.left, r.bottom);
      const lr = toPdf(r.right, r.bottom);
      return [ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]] as Quad;
    });
    out.push({ pageIndex, quads, text: text.replace(/\s+\n/g, "\n").trim(), lastRect: merged[merged.length - 1] });
  }
  return out.sort((a, b) => a.pageIndex - b.pageIndex);
}

/** Merges client rects that belong to the same visual line. */
function mergeLineRects(rects: DOMRect[]): DOMRect[] {
  // Rotated pages produce vertical lines; detect orientation by aspect.
  const vertical = rects.filter((r) => r.height > r.width * 1.5).length > rects.length / 2 && rects.every((r) => r.height > r.width);
  const sorted = [...rects].sort((a, b) => (vertical ? a.left - b.left || a.top - b.top : a.top - b.top || a.left - b.left));
  const lines: DOMRect[] = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last) {
      if (!vertical) {
        const overlap = Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top);
        const minH = Math.min(last.height, r.height);
        const gap = r.left - last.right;
        if (overlap > minH * 0.5 && gap < Math.max(last.height, r.height) * 1.2 && r.left >= last.left - 2) {
          lines[lines.length - 1] = new DOMRect(Math.min(last.left, r.left), Math.min(last.top, r.top), Math.max(last.right, r.right) - Math.min(last.left, r.left), Math.max(last.bottom, r.bottom) - Math.min(last.top, r.top));
          continue;
        }
      } else {
        const overlap = Math.min(last.right, r.right) - Math.max(last.left, r.left);
        const minW = Math.min(last.width, r.width);
        const gap = r.top - last.bottom;
        if (overlap > minW * 0.5 && gap < Math.max(last.width, r.width) * 1.2) {
          lines[lines.length - 1] = new DOMRect(Math.min(last.left, r.left), Math.min(last.top, r.top), Math.max(last.right, r.right) - Math.min(last.left, r.left), Math.max(last.bottom, r.bottom) - Math.min(last.top, r.top));
          continue;
        }
      }
    }
    lines.push(r);
  }
  return lines;
}
