import { buildPdf } from "../../core/save";
import { getDoc } from "../../state/store";
import { openPdf, pdfjs, renderPageToCanvas } from "../../lib/pdfjs";
import { baseName, canvasToBlob } from "../../lib/util";
import { zipFiles } from "../combine";
import { pageStructure, type PageStructure } from "./structure";
import { layoutTextOf, pageRows, toDocx, toHtml, toMarkdown, toPptx, toXlsx } from "./writers";

export type ExportFormat = "docx" | "xlsx" | "pptx" | "image" | "txt" | "html" | "md";

export interface ExportOptions {
  /** 0-based page indexes. */
  pages: number[];
  /** Include images (Word, HTML, Markdown). */
  images: boolean;
  pptxMode: "images" | "editable";
  imageFormat: "png" | "jpeg" | "webp";
  /** Image export: render pages, or extract the images embedded in them. */
  imageSource: "pages" | "embedded";
  dpi: number;
  quality: number;
  /** Plain text: keep the page layout with spaces. */
  textLayout: boolean;
  xlsxSheets: "perPage" | "single";
}

export const EXPORT_DEFAULTS: ExportOptions = { pages: [], images: true, pptxMode: "images", imageFormat: "png", imageSource: "pages", dpi: 150, quality: 0.9, textLayout: false, xlsxSheets: "perPage" };

export interface ExportResult {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain;charset=utf-8",
  html: "text/html;charset=utf-8",
  md: "text/markdown;charset=utf-8",
  zip: "application/zip",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Exports the document (with its edits and comments) to another format. */
export async function exportDocument(docId: string, format: ExportFormat, opts: ExportOptions, onProgress?: (done: number, total: number, label: string) => void): Promise<ExportResult> {
  const doc = getDoc(docId);
  if (!doc) throw new Error("Document is not open");
  const base = baseName(doc.name);
  const meta = { title: doc.metadata?.title || base, author: doc.metadata?.author };
  const pages = opts.pages.length ? opts.pages : doc.pages.map((_, i) => i);
  onProgress?.(0, pages.length, "Preparing…");
  // The exported content includes edits, form values and comments, without password protection.
  const { pdf } = await openPdf(await buildPdf(docId, { security: "none" }));
  try {
    const structures = async (images: boolean) => {
      const out: PageStructure[] = [];
      for (let k = 0; k < pages.length; k++) {
        onProgress?.(k, pages.length, `Reading page ${pages[k] + 1}…`);
        out.push(await pageStructure(pdf, pages[k], { images }));
      }
      return out;
    };
    const render = async (i: number, scale: number, type: string, quality: number) => {
      const page = await pdf.getPage(i + 1);
      const canvas = await renderPageToCanvas(page, { scale, annotationMode: pdfjs.AnnotationMode.ENABLE });
      const blob = await canvasToBlob(canvas, type, quality);
      return { blob };
    };
    const text = (s: string, ext: string, mime: string): ExportResult => ({ bytes: new TextEncoder().encode(s), name: `${base}.${ext}`, mime });

    switch (format) {
      case "docx":
        return { bytes: await toDocx(await structures(opts.images), meta), name: `${base}.docx`, mime: MIME.docx };
      case "xlsx": {
        const ps = await structures(false);
        const sheets =
          opts.xlsxSheets === "single"
            ? [ps.reduce<{ name: string; rows: string[][]; headerRows: number[] }>((acc, p) => {
                const r = pageRows(p);
                if (acc.rows.length) acc.rows.push([]);
                acc.headerRows.push(...r.headerRows.map((h) => h + acc.rows.length));
                acc.rows.push(...r.rows);
                return acc;
              }, { name: base, rows: [], headerRows: [] })]
            : ps.map((p) => ({ name: `Page ${p.index + 1}`, ...pageRows(p) }));
        return { bytes: toXlsx(sheets), name: `${base}.xlsx`, mime: MIME.xlsx };
      }
      case "pptx": {
        const slides = [];
        for (let k = 0; k < pages.length; k++) {
          const i = pages[k];
          onProgress?.(k, pages.length, `Preparing slide ${k + 1}…`);
          const structure = await pageStructure(pdf, i, { images: opts.pptxMode === "editable" });
          let image: string | null = null;
          if (opts.pptxMode === "images") {
            const r = await render(i, 2, "image/jpeg", 0.88);
            image = await blobToDataUrl(r.blob);
          }
          const rotated = (await pdf.getPage(i + 1)).rotate % 180 !== 0;
          slides.push({ structure, image, width: rotated ? structure.height : structure.width, height: rotated ? structure.width : structure.height });
        }
        return { bytes: await toPptx(slides, meta, opts.pptxMode), name: `${base}.pptx`, mime: MIME.pptx };
      }
      case "txt": {
        const ps = await structures(false);
        return text(ps.map((p) => (opts.textLayout ? layoutTextOf(p) : p.text)).join("\n\n\f"), "txt", MIME.txt);
      }
      case "html":
        return text(toHtml(await structures(opts.images), meta, { images: opts.images }), "html", MIME.html);
      case "md":
        return text(toMarkdown(await structures(opts.images), meta, { images: opts.images }), "md", MIME.md);
      case "image": {
        const ext = opts.imageFormat === "jpeg" ? "jpg" : opts.imageFormat;
        const files: { name: string; bytes: Uint8Array }[] = [];
        if (opts.imageSource === "embedded") {
          for (let k = 0; k < pages.length; k++) {
            onProgress?.(k, pages.length, `Extracting images from page ${pages[k] + 1}…`);
            const s = await pageStructure(pdf, pages[k], { images: true });
            let n = 1;
            for (const e of s.elements) if (e.kind === "image") files.push({ name: `${base}-p${pages[k] + 1}-image${n++}.png`, bytes: e.png });
          }
          if (!files.length) throw new Error("No images were found on these pages");
        } else {
          for (let k = 0; k < pages.length; k++) {
            onProgress?.(k, pages.length, `Rendering page ${pages[k] + 1}…`);
            const r = await render(pages[k], opts.dpi / 72, MIME[opts.imageFormat], opts.quality);
            files.push({ name: `${base}-page${String(pages[k] + 1).padStart(String(doc.pages.length).length, "0")}.${ext}`, bytes: new Uint8Array(await r.blob.arrayBuffer()) });
          }
        }
        if (files.length === 1) return { bytes: files[0].bytes, name: files[0].name, mime: opts.imageSource === "embedded" ? MIME.png : MIME[opts.imageFormat] };
        return { bytes: zipFiles(files), name: `${base}-${opts.imageSource === "embedded" ? "images" : "pages"}.zip`, mime: MIME.zip };
      }
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
