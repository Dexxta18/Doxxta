import { buildPdf } from "../core/save";
import { openPdf, pdfjs } from "../lib/pdfjs";
import { canvasToBlob } from "../lib/util";

export interface PrintOptions {
  pages: number[];
  /** all = document + comments + forms; document = no annotations; forms = document + form fields. */
  content: "all" | "document" | "forms";
  sizing: "fit" | "actual" | "shrink";
  orientation: "auto" | "portrait" | "landscape";
  dpi: number;
  grayscale: boolean;
}

/**
 * Prints by rendering the final PDF (with comments flattened in) to images
 * and handing them to the browser's print dialog, so the output matches what
 * other viewers will show.
 */
export async function printDocument(docId: string, opts: PrintOptions, progress: (p: number, detail?: string) => void) {
  const bytes = await buildPdf(docId, { omitAnnotations: opts.content !== "all", pageIndices: opts.pages, security: "none" });
  const { pdf } = await openPdf(bytes);
  const root = document.createElement("div");
  root.id = "folio-print-root";
  const style = document.createElement("style");
  let landscape = 0;
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      progress(i / pdf.numPages, `Preparing page ${i + 1} of ${pdf.numPages}`);
      const page = await pdf.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      if (vp1.width > vp1.height) landscape++;
      const scale = opts.dpi / 72;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({
        canvas,
        viewport: vp,
        intent: "print",
        annotationMode: opts.content === "document" ? pdfjs.AnnotationMode.DISABLE : pdfjs.AnnotationMode.ENABLE_STORAGE,
        background: "#ffffff",
      }).promise;
      const url = URL.createObjectURL(await canvasToBlob(canvas, "image/jpeg", 0.92));
      const sheet = document.createElement("div");
      sheet.className = "print-sheet";
      const img = document.createElement("img");
      img.src = url;
      if (opts.sizing === "actual") {
        img.style.width = `${vp1.width}pt`;
        img.style.height = `${vp1.height}pt`;
      } else if (opts.sizing === "shrink") {
        img.style.width = `${vp1.width}pt`;
        img.style.maxWidth = "100%";
        img.style.maxHeight = "100vh";
      }
      sheet.appendChild(img);
      root.appendChild(sheet);
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  const orient = opts.orientation === "auto" ? (landscape > pdf.numPages / 2 ? "landscape" : "portrait") : opts.orientation;
  style.textContent = `
    #folio-print-root { display: none; }
    @media print {
      @page { size: ${orient}; margin: 0; }
      html, body { overflow: visible !important; height: auto !important; background: #fff !important; }
      body > *:not(#folio-print-root) { display: none !important; }
      #folio-print-root { display: block; }
      .print-sheet { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; page-break-after: always; break-after: page; overflow: hidden; }
      .print-sheet:last-child { page-break-after: auto; break-after: auto; }
      .print-sheet img { ${opts.sizing === "fit" ? "max-width: 100%; max-height: 100%; width: auto; height: auto;" : ""} ${opts.grayscale ? "filter: grayscale(1);" : ""} }
    }`;
  document.head.appendChild(style);
  document.body.appendChild(root);
  await Promise.all(Array.from(root.querySelectorAll("img")).map((img) => (img.complete ? Promise.resolve() : new Promise((r) => (img.onload = img.onerror = r)))));
  progress(1, "Opening print dialog");
  const cleanup = () => {
    root.querySelectorAll("img").forEach((img) => URL.revokeObjectURL(img.src));
    root.remove();
    style.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Give the browser a frame to lay out the sheets.
  await new Promise((r) => setTimeout(r, 50));
  window.print();
  // Some browsers don't fire afterprint; clean up eventually.
  setTimeout(cleanup, 60_000);
}
