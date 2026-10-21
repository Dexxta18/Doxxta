import { FontCache, loadPdfLib, type PDFDocument } from "../lib/pdflib";
import { openPdf, pdfjs, renderPageToCanvas, type PDFDocumentProxy } from "../lib/pdfjs";
import { applyDocumentChange } from "../core/document";
import { getDoc } from "../state/store";
import { computeRect } from "../annotations/geometry";
import type { Annotation, RedactAnnot } from "../annotations/types";
import type { Quad } from "../lib/geometry";
import { uid } from "../lib/util";
import { mergeLineRects } from "../viewer/textSelection";
import { drawRedactionMarks, extractGlyphs, glyphQuads, glyphText, rasterizePage, redactPage, regionsFrom, removeAnnotationsIn, type Region } from "./contentRedact";
import { sanitizeDoc, type SanitizeOptions } from "./sanitize";

// ---------------- Finding text to redact ----------------

export interface RedactMatch {
  id: string;
  pageIndex: number;
  text: string;
  before: string;
  after: string;
  quads: Quad[];
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const MONTHS = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";

/** Built-in patterns, like Acrobat's "Find text → Patterns". */
export const REDACTION_PATTERNS: { id: string; label: string; example: string; regex: RegExp; accept?: (m: string) => boolean }[] = [
  { id: "phone", label: "Phone numbers", example: "(555) 012-3456, +44 20 7946 0958", regex: /(?<![\d\w])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\d\w])/g },
  { id: "card", label: "Credit card numbers", example: "4111 1111 1111 1111", regex: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, accept: (m) => luhn(m.replace(/\D/g, "")) },
  { id: "ssn", label: "Social Security numbers", example: "123-45-6789", regex: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  { id: "email", label: "Email addresses", example: "name@example.com", regex: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu },
  {
    id: "date",
    label: "Dates",
    example: "03/14/2024, 2024-03-14, March 14, 2024",
    regex: new RegExp(`(?<!\\d)(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS},?\\s+\\d{4})(?!\\d)`, "giu"),
  },
];

/** Lays out a page's text like the viewer's text layer, offscreen, to measure matches. */
async function pageTextLayer(pdf: PDFDocumentProxy, pageIndex: number) {
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
async function exactPageText(doc: PDFDocument, pageIndex: number) {
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

/** Finds the matches of `searches` (global regexes) on the given pages. */
export async function findRedactionMatches(
  source: { pdf: PDFDocumentProxy; bytes: Uint8Array },
  searches: { regex: RegExp; accept?: (m: string) => boolean }[],
  pages: number[],
  onProgress?: (done: number, total: number) => void,
  cancelled?: () => boolean,
): Promise<RedactMatch[]> {
  const out: RedactMatch[] = [];
  const doc = await loadPdfLib(source.bytes);
  for (let k = 0; k < pages.length; k++) {
    if (cancelled?.()) break;
    const i = pages[k];
    // Exact positions from the PDF itself; the viewer's text layer only as a fallback.
    const layer = (await exactPageText(doc, i).catch(() => null)) ?? (await pageTextLayer(source.pdf, i));
    try {
      const seen = new Set<string>();
      for (const s of searches) {
        s.regex.lastIndex = 0;
        for (const m of layer.text.matchAll(s.regex)) {
          if (!m[0].trim() || (s.accept && !s.accept(m[0]))) continue;
          const start = m.index!,
            end = start + m[0].length;
          const key = `${start}:${end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const quads = layer.quadsFor(start, end);
          if (!quads.length) continue;
          out.push({
            id: uid("m"),
            pageIndex: i,
            text: m[0].replace(/\s+/g, " "),
            before: layer.text.slice(Math.max(0, start - 30), start).replace(/\s+/g, " "),
            after: layer.text.slice(end, end + 30).replace(/\s+/g, " "),
            quads,
          });
        }
      }
    } finally {
      layer.dispose();
    }
    onProgress?.(k + 1, pages.length);
  }
  return out;
}

// ---------------- Applying ----------------

export interface RedactionSummary {
  marks: number;
  pages: number;
  glyphs: number;
  images: number;
  graphics: number;
  annotations: number;
  rasterized: number[];
  hidden: string[];
}

function regionsOf(a: RedactAnnot): Region[] {
  return regionsFrom(a.rect, a.quads as number[][] | undefined);
}

/**
 * Applies redaction marks: permanently removes the content beneath them,
 * paints the marks, and removes comments and fields in those areas.
 */
export async function applyRedactions(docId: string, opts: { ids?: string[]; sanitize?: SanitizeOptions } = {}): Promise<RedactionSummary | null> {
  const d = getDoc(docId);
  if (!d) return null;
  const marks = d.annotations.filter((a): a is RedactAnnot => a.kind === "redact" && (!opts.ids || opts.ids.includes(a.id)));
  if (!marks.length) return null;
  const summary: RedactionSummary = { marks: marks.length, pages: 0, glyphs: 0, images: 0, graphics: 0, annotations: 0, rasterized: [], hidden: [] };
  await applyDocumentChange(docId, marks.length === 1 ? "Apply redaction" : "Apply redactions", async ({ bytes, pageIds, annotations }) => {
    const doc = await loadPdfLib(bytes);
    const pages = doc.getPages();
    const fonts = new FontCache(doc);
    const byPage = new Map<number, RedactAnnot[]>();
    for (const m of marks) {
      const i = pageIds.indexOf(m.pageId);
      if (i >= 0) byPage.set(i, [...(byPage.get(i) ?? []), m]);
    }
    let source: PDFDocumentProxy | null = null;
    const pageRegions = new Map<string, Region[]>();
    try {
      for (const [i, list] of [...byPage].sort((a, b) => a[0] - b[0])) {
        const page = pages[i];
        // Marks made from a mouse selection follow the viewer's approximate text layout; snap them to the exact glyphs.
        const exact = list.some((m) => m.markedText && m.quads?.length) ? await exactPageText(doc, i).catch(() => null) : null;
        const snapped = (m: RedactAnnot): RedactAnnot => {
          const q = exact && m.markedText && m.quads?.length ? snapToGlyphs(exact, m.markedText, m.quads) : null;
          return q ? { ...m, quads: q } : m;
        };
        list.splice(0, list.length, ...list.map(snapped));
        const regions = list.flatMap(regionsOf);
        pageRegions.set(pageIds[i], regions);
        const res = await redactPage(doc, page, regions, { text: true, images: true, graphics: true, fill: list[0].fillColor });
        summary.pages++;
        summary.glyphs += res.removedGlyphs;
        summary.images += res.changedImages + res.removedImages;
        summary.graphics += res.removedPaths + res.clippedPaths;
        if (res.unsupported.length) {
          // Content we can't take apart safely: replace the page with a rendering of it.
          source ??= (await openPdf(bytes)).pdf;
          const pdfPage = await source.getPage(i + 1);
          await rasterizePage(
            doc,
            page,
            async (scale) => {
              const viewport = pdfPage.getViewport({ scale });
              const canvas = await renderPageToCanvas(pdfPage, { scale, annotationMode: pdfjs.AnnotationMode.DISABLE, intent: "print" });
              return { canvas, toCanvas: (x, y) => viewport.convertToViewportPoint(x, y) as [number, number] };
            },
            regions,
            list[0].fillColor,
          );
          summary.rasterized.push(i + 1);
        }
        summary.annotations += removeAnnotationsIn(doc, page, regions);
        await drawRedactionMarks(
          doc,
          page,
          list.map((m) => ({ regions: regionsOf(m), fill: m.fillColor, text: m.overlayText || undefined })),
          fonts,
        );
      }
    } finally {
      await source?.loadingTask.destroy();
    }
    // Comments and fields (in Folio's model) inside redacted areas go too.
    const applied = new Set(marks.map((m) => m.id));
    const kept = annotations.filter((a) => {
      if (applied.has(a.id)) return false;
      const regions = pageRegions.get(a.pageId);
      if (!regions || a.kind === "redact") return true;
      const hit = overlapsAny(a, regions);
      if (hit) summary.annotations++;
      return !hit;
    });
    if (opts.sanitize) summary.hidden = (await sanitizeDoc(doc, opts.sanitize)).removed;
    const out = await doc.save({ useObjectStreams: true });
    return { bytes: out, pageIds, annotations: opts.sanitize?.comments ? kept.filter((a) => a.kind === "field" || a.kind === "link" || a.kind === "textedit" || a.kind === "redact") : kept };
  });
  return summary;
}

/** The occurrence of `text` that best overlaps the approximate quads, as exact glyph quads. */
function snapToGlyphs(exact: { text: string; quadsFor(start: number, end: number): Quad[] }, text: string, approx: Quad[]): Quad[] | null {
  const chars = [...text.replace(/\s+/g, "")];
  if (!chars.length) return null;
  const re = new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "gu");
  const box = (q: number[]) => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];
  const overlap = (a: number[], b: number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const target = approx.map(box);
  let best: Quad[] | null = null;
  let bestScore = 0;
  for (const m of exact.text.matchAll(re)) {
    const quads = exact.quadsFor(m.index!, m.index! + m[0].length);
    const boxes = quads.map(box);
    const area = boxes.reduce((s, b) => s + (b[2] - b[0]) * (b[3] - b[1]), 0) || 1;
    const score = boxes.reduce((s, b) => s + target.reduce((t, a) => t + overlap(a, b), 0), 0) / area;
    if (score > bestScore) {
      bestScore = score;
      best = quads;
    }
  }
  return bestScore > 0.3 ? best : null;
}

function overlapsAny(a: Annotation, regions: Region[]): boolean {
  const [x0, y0, x1, y1] = computeRect(a);
  return regions.some((r) => {
    const xs = r.map((p) => p.x),
      ys = r.map((p) => p.y);
    return Math.min(...xs) < x1 && Math.max(...xs) > x0 && Math.min(...ys) < y1 && Math.max(...ys) > y0;
  });
}
