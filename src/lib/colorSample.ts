import type { PDFDocumentProxy } from "./pdfjs";
import { pdfjs } from "./pdfjs";
import { rgbToHex } from "./colors";
import type { PdfRect } from "./geometry";

/**
 * Renders a page region and estimates its background colour (dominant colour
 * along the edges) and foreground/text colour (dominant colour that differs
 * clearly from the background).
 */
export async function sampleRegionColors(pdf: PDFDocumentProxy, pageIndex: number, r: PdfRect): Promise<{ background: string; foreground: string }> {
  const page = await pdf.getPage(pageIndex + 1);
  const scale = 2;
  const vp = page.getViewport({ scale, rotation: 0 });
  const pad = 2;
  const [x1, y1] = vp.convertToViewportPoint(r[0] - pad, r[1] - pad);
  const [x2, y2] = vp.convertToViewportPoint(r[2] + pad, r[3] + pad);
  const left = Math.floor(Math.min(x1, x2));
  const top = Math.floor(Math.min(y1, y2));
  const w = Math.max(2, Math.ceil(Math.abs(x2 - x1)));
  const h = Math.max(2, Math.ceil(Math.abs(y2 - y1)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  await page.render({ canvas, viewport: vp, transform: [1, 0, 0, 1, -left, -top], annotationMode: pdfjs.AnnotationMode.DISABLE, background: "#ffffff" }).promise;
  const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const q = (v: number) => v >> 3; // 5-bit buckets
  const key = (i: number) => (q(data[i]) << 10) | (q(data[i + 1]) << 5) | q(data[i + 2]);
  const edge = new Map<number, number>();
  const count = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);
  for (let x = 0; x < w; x++) {
    count(edge, key(x * 4));
    count(edge, key(((h - 1) * w + x) * 4));
  }
  for (let y = 0; y < h; y++) {
    count(edge, key(y * w * 4));
    count(edge, key((y * w + w - 1) * 4));
  }
  const bgKey = [...edge.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0x7fff;
  const unpack = (k: number) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4];
  const bg = unpack(bgKey);
  const fg = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - bg[0],
      dg = data[i + 1] - bg[1],
      db = data[i + 2] - bg[2];
    if (dr * dr + dg * dg + db * db > 90 * 90) count(fg, key(i));
  }
  const fgKey = [...fg.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const fgRgb = fgKey === undefined ? [0, 0, 0] : unpack(fgKey);
  // Snap near-white / near-black to pure values for cleaner output.
  const snap = (c: number[]) => (c.every((v) => v > 240) ? [255, 255, 255] : c.every((v) => v < 30) ? [0, 0, 0] : c);
  const b2 = snap(bg),
    f2 = snap(fgRgb);
  return { background: rgbToHex(b2[0], b2[1], b2[2]), foreground: rgbToHex(f2[0], f2[1], f2[2]) };
}
