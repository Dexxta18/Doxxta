import { getRuntime } from "../state/runtime";
import { getDoc, toast } from "../state/store";
import { pdfjs } from "../lib/pdfjs";
import { canvasToBlob, downloadBlob, baseName } from "../lib/util";
import type { PdfRect } from "../lib/geometry";

/** "Take a snapshot": copies a page region as an image (falls back to download). */
export async function snapshotRegion(docId: string, pageIndex: number, r: PdfRect, dpi = 200) {
  const rt = getRuntime(docId);
  const doc = getDoc(docId);
  if (!rt || !doc) return;
  const page = await rt.pdf.getPage(pageIndex + 1);
  const scale = dpi / 72;
  const vp = page.getViewport({ scale, rotation: (page.rotate + doc.view.rotation) % 360 });
  const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
  const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
  const left = Math.min(x1, x2),
    top = Math.min(y1, y2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(Math.abs(x2 - x1)));
  canvas.height = Math.max(1, Math.round(Math.abs(y2 - y1)));
  await page.render({
    canvas,
    viewport: vp,
    transform: [1, 0, 0, 1, -left, -top],
    annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,
    background: "#ffffff",
  }).promise;
  const blob = await canvasToBlob(canvas, "image/png");
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Snapshot copied to the clipboard", "success");
  } catch {
    downloadBlob(blob, `${baseName(doc.name)}-p${pageIndex + 1}-snapshot.png`);
    toast("Clipboard unavailable — snapshot downloaded instead", "info");
  }
}
