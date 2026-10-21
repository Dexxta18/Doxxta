// The legacy build bundles polyfills for browsers that lack newer JS built-ins.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy };

const abs = (p: string) => new URL(`${import.meta.env.BASE_URL}${p}`, document.baseURI).href;

export const PDFJS_ASSETS = {
  cMapUrl: abs("vendor/pdfjs/cmaps/"),
  standardFontDataUrl: abs("vendor/pdfjs/standard_fonts/"),
  wasmUrl: abs("vendor/pdfjs/wasm/"),
  iccUrl: abs("vendor/pdfjs/iccs/"),
  sandboxBundleSrc: abs("vendor/pdfjs/pdf.sandbox.min.mjs"),
  imageResourcesPath: abs("vendor/pdfjs/images/"),
};

export class PasswordCancelled extends Error {
  constructor() {
    super("Password entry was cancelled");
  }
}

export type PasswordPrompt = (reason: "need" | "incorrect") => Promise<string | null>;

export interface OpenResult {
  pdf: PDFDocumentProxy;
  password?: string;
}

/**
 * Opens a PDF with pdf.js. pdf.js takes ownership of typed arrays it is given,
 * so a copy of `data` is always passed.
 */
export async function openPdf(data: Uint8Array, opts: { password?: string; onPassword?: PasswordPrompt } = {}): Promise<OpenResult> {
  let password = opts.password;
  const task = pdfjs.getDocument({
    data: data.slice(),
    password,
    cMapUrl: PDFJS_ASSETS.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_ASSETS.standardFontDataUrl,
    wasmUrl: PDFJS_ASSETS.wasmUrl,
    iccUrl: PDFJS_ASSETS.iccUrl,
    enableXfa: true,
  });
  let cancelled = false;
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    if (!opts.onPassword) {
      cancelled = true;
      task.destroy();
      return;
    }
    const why = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? "incorrect" : "need";
    opts.onPassword(why).then((pw) => {
      if (pw === null) {
        cancelled = true;
        task.destroy();
      } else {
        password = pw;
        update(pw);
      }
    });
  };
  try {
    const pdf = await task.promise;
    return { pdf, password };
  } catch (e) {
    if (cancelled) throw new PasswordCancelled();
    throw e;
  }
}

export interface TextItemLite {
  str: string;
  /** Transform of the text item in PDF user space. */
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
  dir: string;
}

const textCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<{ items: TextItemLite[]; styles: Record<string, { fontFamily: string; ascent: number; descent: number; vertical: boolean }> }>>>();

/** Cached `getTextContent` per document page. */
export function getPageTextContent(pdf: PDFDocumentProxy, pageIndex: number) {
  let m = textCache.get(pdf);
  if (!m) {
    m = new Map();
    textCache.set(pdf, m);
  }
  let p = m.get(pageIndex);
  if (!p) {
    p = pdf.getPage(pageIndex + 1).then(async (page) => {
      const tc = await page.getTextContent();
      const items = (tc.items as TextItemLite[]).filter((it) => typeof it.str === "string");
      return { items, styles: tc.styles as never };
    });
    m.set(pageIndex, p);
  }
  return p;
}

/** Plain text of a page, with line breaks where pdf.js reports end-of-line. */
export async function getPageText(pdf: PDFDocumentProxy, pageIndex: number): Promise<string> {
  const { items } = await getPageTextContent(pdf, pageIndex);
  let out = "";
  for (const it of items) {
    out += it.str;
    if (it.hasEOL) out += "\n";
  }
  return out;
}

export async function getDocumentText(pdf: PDFDocumentProxy, onProgress?: (done: number, total: number) => void): Promise<string[]> {
  const pages: string[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    pages.push(await getPageText(pdf, i));
    onProgress?.(i + 1, pdf.numPages);
  }
  return pages;
}

export interface RenderOptions {
  scale: number;
  rotation?: number;
  background?: string;
  annotationMode?: number;
  intent?: "display" | "print";
}

/** Renders a page into a new canvas. */
export async function renderPageToCanvas(page: PDFPageProxy, opts: RenderOptions): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: opts.scale, rotation: ((page.rotate + (opts.rotation ?? 0)) % 360 + 360) % 360 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({
    canvas,
    viewport,
    background: opts.background ?? "#ffffff",
    annotationMode: opts.annotationMode ?? pdfjs.AnnotationMode.ENABLE,
    intent: opts.intent ?? "display",
  });
  await task.promise;
  return canvas;
}

export function pdfDateToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = pdfjs.PDFDateString.toDateObject(s);
  return d ? d.toISOString() : null;
}

export function isoToPdfDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
