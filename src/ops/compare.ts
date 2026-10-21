import { diffArrays } from "diff";
import { loadPdfLib, type PDFDocument } from "../lib/pdflib";
import { openPdf, pdfjs, renderPageToCanvas, type PDFDocumentProxy } from "../lib/pdfjs";
import type { Quad } from "../lib/geometry";
import { uid } from "../lib/util";
import { pageText } from "./pageText";

/** Compare Files: word-level text differences, or pixel differences for scans and drawings. */

export interface ChangeSide {
  page: number;
  quads: Quad[];
  /** A thin marker where content was inserted on the other side. */
  marker?: boolean;
}

export interface CompareChange {
  id: string;
  kind: "insert" | "delete" | "replace" | "visual";
  oldText: string;
  newText: string;
  old: ChangeSide[];
  new: ChangeSide[];
}

export interface CompareResult {
  changes: CompareChange[];
  oldPages: number;
  newPages: number;
  /** Text could not be read from at least one side (scans): only the visual comparison is meaningful. */
  noText: boolean;
}

interface Token {
  word: string;
  page: number;
  start: number;
  end: number;
}

interface DocText {
  tokens: Token[];
  pages: { quadsFor(start: number, end: number): Quad[] }[];
  dispose(): void;
}

async function readText(doc: PDFDocument, pdf: PDFDocumentProxy, onPage: () => void): Promise<DocText> {
  const tokens: Token[] = [];
  const pages: DocText["pages"] = [];
  const disposers: (() => void)[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const t = await pageText(doc, pdf, i);
    for (const m of t.text.matchAll(/\S+/g)) tokens.push({ word: m[0], page: i, start: m.index!, end: m.index! + m[0].length });
    pages.push(t);
    disposers.push(() => t.dispose());
    onPage();
  }
  return { tokens, pages, dispose: () => disposers.forEach((d) => d()) };
}

/** Quads for consecutive tokens, split by page. */
function sides(text: DocText, tokens: Token[]): ChangeSide[] {
  const byPage = new Map<number, Token[]>();
  for (const t of tokens) byPage.set(t.page, [...(byPage.get(t.page) ?? []), t]);
  return [...byPage].map(([page, ts]) => ({ page, quads: text.pages[page].quadsFor(ts[0].start, ts[ts.length - 1].end) }));
}

/** A thin insertion marker just before `token` (or after the previous one). */
function marker(text: DocText, before: Token | undefined, after: Token | undefined): ChangeSide[] {
  const t = after ?? before;
  if (!t) return [];
  const q = text.pages[t.page].quadsFor(t.start, t.start + 1)[0];
  if (!q) return [];
  const atEnd = !after;
  const x = atEnd ? Math.max(q[2], q[6]) : Math.min(q[0], q[4]);
  const top = Math.max(q[1], q[3]),
    bottom = Math.min(q[5], q[7]);
  return [{ page: t.page, quads: [[x - 1, top, x + 1, top, x - 1, bottom, x + 1, bottom] as Quad], marker: true }];
}

const norm = (w: string) => w.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-");

export async function compareText(oldBytes: Uint8Array, newBytes: Uint8Array, onProgress?: (done: number, total: number, label: string) => void): Promise<CompareResult> {
  const [oldDoc, newDoc] = await Promise.all([loadPdfLib(oldBytes), loadPdfLib(newBytes)]);
  const [{ pdf: oldPdf }, { pdf: newPdf }] = await Promise.all([openPdf(oldBytes), openPdf(newBytes)]);
  try {
    const total = oldPdf.numPages + newPdf.numPages;
    let done = 0;
    const tick = () => onProgress?.(++done, total, "Reading text…");
    const a = await readText(oldDoc, oldPdf, tick);
    const b = await readText(newDoc, newPdf, tick).catch((e) => {
      a.dispose();
      throw e;
    });
    try {
    const noText = !a.tokens.length || !b.tokens.length;
    onProgress?.(total, total, "Finding differences…");
    await new Promise((r) => setTimeout(r, 0));
    const changes: CompareChange[] = [];
    if (!noText) {
      const parts = diffArrays(
        a.tokens.map((t) => norm(t.word)),
        b.tokens.map((t) => norm(t.word)),
        { timeout: 20000 },
      );
      if (!parts) throw new Error("These documents are too different to compare word by word. Try the visual comparison.");
      let ia = 0,
        ib = 0;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        if (!p.added && !p.removed) {
          ia += p.count;
          ib += p.count;
          continue;
        }
        const next = parts[k + 1];
        if (p.removed && next?.added) {
          const ta = a.tokens.slice(ia, ia + p.count);
          const tb = b.tokens.slice(ib, ib + next.count);
          changes.push({ id: uid("c"), kind: "replace", oldText: ta.map((t) => t.word).join(" "), newText: tb.map((t) => t.word).join(" "), old: sides(a, ta), new: sides(b, tb) });
          ia += p.count;
          ib += next.count;
          k++;
        } else if (p.removed) {
          const ta = a.tokens.slice(ia, ia + p.count);
          changes.push({ id: uid("c"), kind: "delete", oldText: ta.map((t) => t.word).join(" "), newText: "", old: sides(a, ta), new: marker(b, b.tokens[ib - 1], b.tokens[ib]) });
          ia += p.count;
        } else {
          const tb = b.tokens.slice(ib, ib + p.count);
          changes.push({ id: uid("c"), kind: "insert", oldText: "", newText: tb.map((t) => t.word).join(" "), old: marker(a, a.tokens[ia - 1], a.tokens[ia]), new: sides(b, tb) });
          ib += p.count;
        }
      }
    }
    return { changes, oldPages: oldPdf.numPages, newPages: newPdf.numPages, noText };
    } finally {
      a.dispose();
      b.dispose();
    }
  } finally {
    await Promise.all([oldPdf.loadingTask.destroy(), newPdf.loadingTask.destroy()]);
  }
}

/** Pixel comparison of page pairs. */
export async function compareVisual(oldBytes: Uint8Array, newBytes: Uint8Array, onProgress?: (done: number, total: number, label: string) => void): Promise<CompareResult> {
  const [{ pdf: oldPdf }, { pdf: newPdf }] = await Promise.all([openPdf(oldBytes), openPdf(newBytes)]);
  try {
    const n = Math.min(oldPdf.numPages, newPdf.numPages);
    const changes: CompareChange[] = [];
    for (let i = 0; i < n; i++) {
      onProgress?.(i, n, `Comparing page ${i + 1}…`);
      const [pa, pb] = await Promise.all([oldPdf.getPage(i + 1), newPdf.getPage(i + 1)]);
      const va = pa.getViewport({ scale: 1 }),
        vb = pb.getViewport({ scale: 1 });
      const width = 900;
      const [ca, cb] = await Promise.all([
        renderPageToCanvas(pa, { scale: width / va.width, annotationMode: pdfjs.AnnotationMode.ENABLE }),
        renderPageToCanvas(pb, { scale: width / vb.width, annotationMode: pdfjs.AnnotationMode.ENABLE }),
      ]);
      const h = Math.min(ca.height, cb.height);
      const da = ca.getContext("2d")!.getImageData(0, 0, width, h).data;
      const db = cb.getContext("2d")!.getImageData(0, 0, width, h).data;
      // Changed pixels, counted per 6×6 cell.
      const cell = 6;
      const cw = Math.ceil(width / cell),
        chh = Math.ceil(h / cell);
      const counts = new Uint16Array(cw * chh);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < width; x++) {
          const k = (y * width + x) * 4;
          if (Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2]) > 90) counts[Math.floor(y / cell) * cw + Math.floor(x / cell)]++;
        }
      const hot = new Uint8Array(cw * chh);
      for (let k = 0; k < counts.length; k++) hot[k] = counts[k] >= 3 ? 1 : 0;
      // Connected regions of changed cells (8-connected, bridging 1-cell gaps).
      const seen = new Uint8Array(cw * chh);
      const boxes: [number, number, number, number][] = [];
      for (let k = 0; k < hot.length; k++) {
        if (!hot[k] || seen[k]) continue;
        let x0 = cw,
          y0 = chh,
          x1 = 0,
          y1 = 0;
        const stack = [k];
        seen[k] = 1;
        while (stack.length) {
          const c = stack.pop()!;
          const cx = c % cw,
            cy = Math.floor(c / cw);
          x0 = Math.min(x0, cx);
          y0 = Math.min(y0, cy);
          x1 = Math.max(x1, cx);
          y1 = Math.max(y1, cy);
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
              const nx = cx + dx,
                ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= cw || ny >= chh) continue;
              const q = ny * cw + nx;
              if (hot[q] && !seen[q]) {
                seen[q] = 1;
                stack.push(q);
              }
            }
        }
        boxes.push([x0 * cell, y0 * cell, (x1 + 1) * cell, (y1 + 1) * cell]);
      }
      const toQuad = (vp: typeof va, b: number[], scale: number): Quad => {
        const p = (x: number, y: number) => vp.convertToPdfPoint(x / scale, y / scale) as [number, number];
        const [ulx, uly] = p(b[0], b[1]),
          [urx, ury] = p(b[2], b[1]),
          [llx, lly] = p(b[0], b[3]),
          [lrx, lry] = p(b[2], b[3]);
        return [ulx, uly, urx, ury, llx, lly, lrx, lry];
      };
      for (const b of boxes) {
        changes.push({ id: uid("c"), kind: "visual", oldText: "", newText: "", old: [{ page: i, quads: [toQuad(va, b, width / va.width)] }], new: [{ page: i, quads: [toQuad(vb, b, width / vb.width)] }] });
      }
    }
    onProgress?.(n, n, "Done");
    return { changes, oldPages: oldPdf.numPages, newPages: newPdf.numPages, noText: false };
  } finally {
    await Promise.all([oldPdf.loadingTask.destroy(), newPdf.loadingTask.destroy()]);
  }
}
