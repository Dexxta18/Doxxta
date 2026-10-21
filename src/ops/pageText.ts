import type { PDFDocument } from "../lib/pdflib";
import { pdfjs, type PDFDocumentProxy } from "../lib/pdfjs";
import type { Quad } from "../lib/geometry";
import { mergeLineRects } from "../viewer/textSelection";
import { extractGlyphs, glyphQuads, glyphText } from "./contentRedact";

/** A page's text with a way to find where any range of it is drawn. */
export interface PageText {
  text: string;
  /** Quads (PDF user space, UL UR LL LR) covering text[start, end). */
  quadsFor(start: number, end: number): Quad[];
  dispose(): void;
}

/** Lays out a page's text like the viewer's text layer, offscreen, to measure matches. */
export async function pageTextLayer(pdf: PDFDocumentProxy, pageIndex: number) {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-30000px;top:0;width:${viewport.width}px;height:${viewport.height}px;visibility:hidden;pointer-events:none;--scale-factor:1;--total-scale-factor:1;--user-unit:1;--scale-round-x:1px;--scale-round-y:1px`;
  const layer = document.createElement("div");
  layer.className = "textLayer";
  host.appendChild(layer);
  document.body.appendChild(host);
  const tl = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport });
  await tl.render();
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      if ((n as Element).tagName === "BR") text += "\n";
      continue;
    }
    nodes.push({ node: n as Text, start: text.length });
    text += n.textContent ?? "";
  }
  const locate = (offset: number, end: boolean) => {
    let lo = 0,
      hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid].start < offset || (!end && nodes[mid].start === offset)) lo = mid;
      else hi = mid - 1;
    }
    const n = nodes[lo];
    return { node: n.node, offset: Math.min(n.node.length, Math.max(0, offset - n.start)) };
  };
  /** Quads (PDF user space) covering text[start, end). */
  const quadsFor = (start: number, end: number): Quad[] => {
    if (!nodes.length) return [];
    const a = locate(start, false);
    const b = locate(end, true);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.3 && r.height > 0.3);
    if (!rects.length) return [];
    const origin = layer.getBoundingClientRect();
    const toPdf = (x: number, y: number) => viewport.convertToPdfPoint(x - origin.left, y - origin.top) as [number, number];
    return mergeLineRects(rects).map((r) => {
      const ul = toPdf(r.left, r.top),
        ur = toPdf(r.right, r.top),
        ll = toPdf(r.left, r.bottom),
        lr = toPdf(r.right, r.bottom);
      return [ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]] as Quad;
    });
  };
  return {
    text,
    quadsFor,
    dispose: () => {
      tl.cancel();
      host.remove();
    },
  };
}

/** Page text with exact glyph geometry, read from the content streams. Null when the fonts don't say what text they draw. */
export async function exactPageText(doc: PDFDocument, pageIndex: number) {
  const glyphs = await extractGlyphs(doc, doc.getPage(pageIndex));
  if (!glyphs?.length) return null;
  const unknown = glyphs.filter((g) => !g.text).length;
  if (unknown > glyphs.length * 0.1) return null;
  const { text, map } = glyphText(glyphs);
  return {
    text,
    quadsFor: (start: number, end: number) => {
      const idx = [...new Set(map.slice(start, end).filter((g) => g >= 0))];
      return glyphQuads(glyphs, idx) as Quad[];
    },
    dispose: () => {},
  };
}

/** Exact text when the fonts allow it, otherwise the viewer's text layout. */
export async function pageText(doc: PDFDocument, pdf: PDFDocumentProxy, pageIndex: number): Promise<PageText> {
  return (await exactPageText(doc, pageIndex).catch(() => null)) ?? (await pageTextLayer(pdf, pageIndex));
}
