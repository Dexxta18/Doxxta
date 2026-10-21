import { useEffect, useRef, useState } from "react";
import { PDFDocument, loadPdfLib } from "../../lib/pdflib";
import { getRuntime } from "../../state/runtime";
import { openPdf, renderPageToCanvas } from "../../lib/pdfjs";

const singlePageCache = new Map<string, Promise<Uint8Array>>();

function singlePage(docId: string, pageIndex: number): Promise<Uint8Array> | null {
  const rt = getRuntime(docId);
  if (!rt) return null;
  const key = `${docId}:${rt.bytes.length}:${pageIndex}`;
  let p = singlePageCache.get(key);
  if (!p) {
    p = (async () => {
      const src = await loadPdfLib(rt.bytes);
      const out = await PDFDocument.create();
      const [page] = await out.copyPages(src, [pageIndex]);
      out.addPage(page);
      return out.save();
    })();
    singlePageCache.set(key, p);
    if (singlePageCache.size > 12) singlePageCache.delete(singlePageCache.keys().next().value!);
  }
  return p;
}

/**
 * Renders a preview of one page after applying `apply` to a single-page copy
 * of the document — the exact code path used for the real change.
 */
export function usePagePreview(docId: string, pageIndex: number, apply: (doc: PDFDocument) => Promise<void>, deps: unknown[], width = 340) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const base = singlePage(docId, pageIndex);
        if (!base) return;
        const doc = await loadPdfLib(await base);
        await applyRef.current(doc);
        const bytes = await doc.save();
        if (my !== seq.current) return;
        const { pdf } = await openPdf(bytes);
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const canvas = await renderPageToCanvas(page, { scale: (width * Math.min(2, window.devicePixelRatio || 1)) / vp.width });
        await pdf.loadingTask.destroy();
        if (my !== seq.current) return;
        setUrl(canvas.toDataURL("image/png"));
      } catch (e) {
        console.warn("preview failed", e);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, pageIndex, width, ...deps]);

  return { url, loading };
}
