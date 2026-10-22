import { addPageContent, addPageResource, fontKeyFor, type FontCache, type PDFDocument, type PDFFont } from "../lib/pdflib";
import type { TextEditAnnot } from "../annotations/types";
import { fmt, hexToPdf } from "../lib/colors";
import { wrapText } from "../lib/fontMetrics";

const BASELINE: Record<string, number> = { Helvetica: 0.946, Times: 0.937, Courier: 0.867 };

/**
 * Applies "Edit text" changes: removes the original glyphs from the content
 * stream where possible (falling back to covering them with the sampled
 * background colour) and writes the replacement text.
 */
export async function applyTextEdits(doc: PDFDocument, edits: TextEditAnnot[], pageIds: string[], fonts: FontCache) {
  const pages = doc.getPages();
  const byPage = new Map<number, TextEditAnnot[]>();
  for (const e of edits) {
    const pi = pageIds.indexOf(e.pageId);
    if (pi >= 0) byPage.set(pi, [...(byPage.get(pi) ?? []), e]);
  }
  let removeText: ((doc: PDFDocument, pageIndex: number, rects: [number, number, number, number][]) => Promise<boolean>) | null = null;
  try {
    removeText = (await import("./contentRedact")).removeTextInRects;
  } catch {
    removeText = null;
  }
  for (const [pi, list] of byPage) {
    const page = pages[pi];
    const removed = removeText ? await removeText(doc, pi, list.map((e) => e.originalRect)).catch(() => false) : false;
    const ops: string[] = [];
    const fontNames = new Map<PDFFont, string>();
    for (const e of list) {
      if (!removed) {
        const [r, g, b] = hexToPdf(e.backgroundColor);
        const [x1, y1, x2, y2] = e.originalRect;
        ops.push(`q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${fmt(x1)} ${fmt(y1)} ${fmt(x2 - x1)} ${fmt(y2 - y1)} re f Q`);
      }
      const key = fontKeyFor(e.fontFamily, e.bold, e.italic);
      const font = await fonts.forText(key, e.text);
      let fname = fontNames.get(font);
      if (!fname) {
        fname = addPageResource(page, "Font", "DoxxtaTE", font.ref);
        fontNames.set(font, fname);
      }
      const width = e.rect[2] - e.rect[0];
      const lines = wrapText(e.text, key, e.fontSize, width);
      const lh = e.fontSize * e.lineHeight;
      const [r, g, b] = hexToPdf(e.textColor);
      ops.push("q BT", `/${fname} ${fmt(e.fontSize)} Tf`, `${fmt(r)} ${fmt(g)} ${fmt(b)} rg`);
      let y = e.rect[3] - (lh - e.fontSize * 1.2) / 2 - e.fontSize * BASELINE[e.fontFamily];
      for (const line of lines) {
        if (line) {
          const w = font.widthOfTextAtSize(line, e.fontSize);
          const x = e.align === "center" ? e.rect[0] + (width - w) / 2 : e.align === "right" ? e.rect[2] - w : e.rect[0];
          ops.push(`1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`, `${font.encodeText(line).toString()} Tj`);
        }
        y -= lh;
      }
      ops.push("ET Q");
    }
    addPageContent(doc, page, ops.join("\n"));
  }
}
