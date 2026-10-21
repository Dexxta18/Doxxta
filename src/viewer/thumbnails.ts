import type { PDFDocumentProxy } from "../lib/pdfjs";
import { pdfjs } from "../lib/pdfjs";

/**
 * Small page renders shared by the thumbnails panel, Organize view and other
 * pickers. Renders are queued (two at a time) and cached per document proxy.
 */

const cache = new WeakMap<PDFDocumentProxy, Map<string, Promise<string>>>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
const MAX_CONCURRENT = 2;

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

export function renderThumbnail(pdf: PDFDocumentProxy, pageIndex: number, width: number, rotation = 0): Promise<string> {
  let m = cache.get(pdf);
  if (!m) {
    m = new Map();
    cache.set(pdf, m);
  }
  const key = `${pageIndex}:${width}:${rotation}`;
  let p = m.get(key);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      queue.push(async () => {
        try {
          const page = await pdf.getPage(pageIndex + 1);
          const rot = (page.rotate + rotation) % 360;
          const vp1 = page.getViewport({ scale: 1, rotation: rot });
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const scale = (width * dpr) / vp1.width;
          const vp = page.getViewport({ scale, rotation: rot });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(vp.width));
          canvas.height = Math.max(1, Math.floor(vp.height));
          await page.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE, background: "#ffffff" }).promise;
          const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
          resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL());
        } catch (e) {
          m!.delete(key);
          reject(e);
        }
      });
      pump();
    });
    m.set(key, p);
  }
  return p;
}

/** Drops cached renders for a page (e.g. after a form value changed). */
export function invalidateThumbnail(pdf: PDFDocumentProxy, pageIndex?: number) {
  const m = cache.get(pdf);
  if (!m) return;
  for (const k of [...m.keys()]) if (pageIndex === undefined || k.startsWith(`${pageIndex}:`)) m.delete(k);
}
