import { PDFArray, PDFName, PDFStream, addPageResource, displayFrame, fontKeyFor, loadPdfLib, FontCache, type PDFDocument, type PDFPage, type PDFRef, type PDFFont } from "../lib/pdflib";

export { displayFrame };
import { applyDocumentChange } from "../core/document";
import { getDoc } from "../state/store";
import { fmt, hexToPdf } from "../lib/colors";
import { invert, rotationMatrix, type Matrix } from "../lib/geometry";
import { dataUrlToBytes } from "../lib/util";
import { formatDatePattern } from "../lib/dates";
import type { FontFamily } from "../annotations/types";

/** Marks are written as separate content streams tagged with /FolioMark so they can be removed later. */
export type MarkKind = "watermark" | "header" | "footer" | "background" | "bates" | "pagenumber";

export interface TextStyle {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  size: number;
  color: string;
  opacity: number;
  underline?: boolean;
}

export type Anchor = "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";

const cm = (m: Matrix) => `${m.map(fmt).join(" ")} cm`;

function tagStream(doc: PDFDocument, page: PDFPage, ops: string, kind: MarkKind, behind: boolean) {
  const ctx = doc.context;
  page.node.normalize();
  const stream = ctx.flateStream(ops, { FolioMark: PDFName.of(kind) } as never);
  const ref = ctx.register(stream);
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) {
    if (behind) contents.insert(0, ref);
    else contents.push(ref);
  }
}

function gs(page: PDFPage, opacity: number): string {
  if (opacity >= 1) return "";
  const ref = page.doc.context.register(page.doc.context.obj({ Type: "ExtGState", ca: opacity, CA: opacity }));
  return `/${addPageResource(page, "ExtGState", "FolioGS", ref)} gs`;
}

/** Removes previously added marks of the given kinds from pages. Returns the number removed. */
export function removeMarks(doc: PDFDocument, kinds: MarkKind[] | "all", pages?: number[]): number {
  let removed = 0;
  const all = doc.getPages();
  const idx = pages ?? all.map((_, i) => i);
  for (const i of idx) {
    const page = all[i];
    const contents = page.node.Contents();
    if (!(contents instanceof PDFArray)) continue;
    for (let k = contents.size() - 1; k >= 0; k--) {
      const s = doc.context.lookup(contents.get(k));
      if (!(s instanceof PDFStream)) continue;
      const mark = s.dict.get(PDFName.of("FolioMark"));
      if (mark instanceof PDFName && (kinds === "all" || kinds.includes(mark.decodeText() as MarkKind))) {
        contents.remove(k);
        removed++;
      }
    }
  }
  return removed;
}

export function countMarks(doc: PDFDocument, kinds: MarkKind[]): number {
  let n = 0;
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    if (!(contents instanceof PDFArray)) continue;
    for (let k = 0; k < contents.size(); k++) {
      const s = doc.context.lookup(contents.get(k));
      const mark = s instanceof PDFStream ? s.dict.get(PDFName.of("FolioMark")) : undefined;
      if (mark instanceof PDFName && kinds.includes(mark.decodeText() as MarkKind)) n++;
    }
  }
  return n;
}

async function textOps(page: PDFPage, fonts: FontCache, text: string, style: TextStyle, x: number, y: number, align: "left" | "center" | "right"): Promise<{ ops: string; width: number }> {
  const key = fontKeyFor(style.family, style.bold, style.italic);
  const font: PDFFont = await fonts.forText(key, text);
  const name = addPageResource(page, "Font", "FolioMk", font.ref as PDFRef);
  const width = font.widthOfTextAtSize(text, style.size);
  const tx = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  const [r, g, b] = hexToPdf(style.color);
  let ops = `BT /${name} ${fmt(style.size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg 1 0 0 1 ${fmt(tx)} ${fmt(y)} Tm ${font.encodeText(text).toString()} Tj ET`;
  if (style.underline) ops += `\n${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${fmt(Math.max(0.5, style.size / 18))} w ${fmt(tx)} ${fmt(y - style.size * 0.15)} m ${fmt(tx + width)} ${fmt(y - style.size * 0.15)} l S`;
  return { ops, width };
}

/** An image or a page of another PDF, placed as a watermark or background. */
export interface GraphicSource {
  image?: { dataUrl: string; width: number; height: number };
  pdf?: { bytes: Uint8Array; pageIndex: number; name: string; pageCount: number };
}

interface EmbeddedGraphic {
  ref: PDFRef;
  /** Display size (points for PDF pages, pixels for images — only the ratio matters). */
  width: number;
  height: number;
  /** For a PDF page: form space → display frame (applies the source page's /Rotate). */
  form?: Matrix;
}

async function embedGraphic(doc: PDFDocument, src: GraphicSource | undefined): Promise<EmbeddedGraphic | null> {
  if (src?.pdf) {
    const srcDoc = await loadPdfLib(src.pdf.bytes);
    const page = srcDoc.getPage(Math.min(src.pdf.pageIndex, srcDoc.getPageCount() - 1));
    const cb = page.getCropBox();
    const emb = await doc.embedPage(page, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
    // The embedded form occupies [0, 0, cb.width, cb.height]; rotate it the way the page displays.
    const r = ((page.getRotation().angle % 360) + 360) % 360;
    const rot = rotationMatrix(r);
    const t = r === 90 ? [cb.width, 0] : r === 180 ? [cb.width, cb.height] : r === 270 ? [0, cb.height] : [0, 0];
    const swap = r === 90 || r === 270;
    return {
      ref: emb.ref,
      width: swap ? cb.height : cb.width,
      height: swap ? cb.width : cb.height,
      form: invert([rot[0], rot[1], rot[2], rot[3], t[0], t[1]]),
    };
  }
  if (src?.image) {
    const b = dataUrlToBytes(src.image.dataUrl);
    const img = src.image.dataUrl.startsWith("data:image/jpeg") ? await doc.embedJpg(b) : await doc.embedPng(b);
    return { ref: img.ref, width: src.image.width, height: src.image.height };
  }
  return null;
}

/** Operators drawing `g` into the box (x, y, w, h) of the current coordinate system. */
function graphicOps(page: PDFPage, g: EmbeddedGraphic, prefix: string, x: number, y: number, w: number, h: number): string {
  const name = addPageResource(page, "XObject", prefix, g.ref);
  if (g.form) return `q ${fmt(w / g.width)} 0 0 ${fmt(h / g.height)} ${fmt(x)} ${fmt(y)} cm ${cm(g.form)} /${name} Do Q`;
  return `q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /${name} Do Q`;
}

// ---------------- Header / footer / page numbers / Bates ----------------

export interface HeaderFooterSpec {
  header: [string, string, string];
  footer: [string, string, string];
  style: TextStyle;
  margins: { top: number; bottom: number; left: number; right: number };
  pages: number[];
  startNumber: number;
  dateFormat: string;
  bates?: { prefix: string; suffix: string; digits: number; start: number };
  kind?: MarkKind;
}

export function expandTokens(s: string, ctx: { page: number; pages: number; file: string; title: string; date: string; bates: string }): string {
  return s
    .replace(/<<page>>/gi, String(ctx.page))
    .replace(/<<pages>>/gi, String(ctx.pages))
    .replace(/<<date>>/gi, ctx.date)
    .replace(/<<file>>/gi, ctx.file)
    .replace(/<<title>>/gi, ctx.title)
    .replace(/<<bates>>/gi, ctx.bates);
}

export function batesNumber(b: NonNullable<HeaderFooterSpec["bates"]>, n: number) {
  return `${b.prefix}${String(b.start + n).padStart(b.digits, "0")}${b.suffix}`;
}

export interface MarkDocInfo {
  file: string;
  title: string;
}

export async function applyHeaderFooterToDoc(doc: PDFDocument, spec: HeaderFooterSpec, info: MarkDocInfo) {
  const date = formatDatePattern(new Date(), spec.dateFormat);
  const fonts = new FontCache(doc);
  const pages = doc.getPages();
  const total = spec.pages.length;
  let n = 0;
  for (const i of spec.pages) {
    const page = pages[i];
    if (!page) continue;
    const { w, h, m } = displayFrame(page);
    const ctx = {
      page: spec.startNumber + n,
      pages: spec.startNumber + total - 1,
      file: info.file,
      title: info.title,
      date,
      bates: spec.bates ? batesNumber(spec.bates, n) : "",
    };
    n++;
    const ops: string[] = ["q", cm(m), gs(page, spec.style.opacity)];
    const { top, bottom, left, right } = spec.margins;
    const slots: [string, number, number, "left" | "center" | "right"][] = [
      [spec.header[0], left, h - top - spec.style.size * 0.8, "left"],
      [spec.header[1], w / 2, h - top - spec.style.size * 0.8, "center"],
      [spec.header[2], w - right, h - top - spec.style.size * 0.8, "right"],
      [spec.footer[0], left, bottom, "left"],
      [spec.footer[1], w / 2, bottom, "center"],
      [spec.footer[2], w - right, bottom, "right"],
    ];
    let any = false;
    for (const [tpl, x, y, align] of slots) {
      const text = expandTokens(tpl, ctx);
      if (!text.trim()) continue;
      any = true;
      ops.push((await textOps(page, fonts, text, spec.style, x, y, align)).ops);
    }
    ops.push("Q");
    if (any) tagStream(doc, page, ops.filter(Boolean).join("\n"), spec.kind ?? (spec.bates ? "bates" : "header"), false);
  }
}

export async function addHeaderFooter(docId: string, spec: HeaderFooterSpec, label = "Add header & footer") {
  const d = getDoc(docId);
  if (!d) return;
  await applyDocumentChange(docId, label, async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    await applyHeaderFooterToDoc(doc, spec, { file: d.name, title: d.metadata?.title || d.name });
    return { bytes: await doc.save(), pageIds };
  });
}

// ---------------- Watermark ----------------

export interface WatermarkSpec {
  kind: "text" | "file";
  text: string;
  style: TextStyle;
  file?: GraphicSource;
  /** File size as a fraction of the page width. */
  scale: number;
  rotation: number;
  opacity: number;
  anchor: Anchor;
  offsetX: number;
  offsetY: number;
  behind: boolean;
  pages: number[];
  /** Repeat the watermark in a grid across the page. */
  tile?: boolean;
  /** Remove watermarks previously added to these pages first. */
  replace?: boolean;
}

function anchorPoint(anchor: Anchor, w: number, h: number, margin = 36): [number, number] {
  const col = anchor[1],
    row = anchor[0];
  const x = col === "l" ? margin : col === "r" ? w - margin : w / 2;
  const y = row === "t" ? h - margin : row === "b" ? margin : h / 2;
  return [x, y];
}

export async function addWatermark(docId: string, spec: WatermarkSpec) {
  await applyDocumentChange(docId, "Add watermark", async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    await applyWatermarkToDoc(doc, spec);
    return { bytes: await doc.save(), pageIds };
  });
}

export async function applyWatermarkToDoc(doc: PDFDocument, spec: WatermarkSpec) {
  {
    if (spec.replace) removeMarks(doc, ["watermark"], spec.pages);
    const fonts = new FontCache(doc);
    const pages = doc.getPages();
    const graphic = spec.kind === "file" ? await embedGraphic(doc, spec.file) : null;
    for (const i of spec.pages) {
      const page = pages[i];
      if (!page) continue;
      const { w, h, m } = displayFrame(page);
      const [ax, ay] = anchorPoint(spec.anchor, w, h);
      const positions: [number, number][] = spec.tile
        ? Array.from({ length: 9 }, (_, k) => [w * (0.17 + (k % 3) * 0.33), h * (0.17 + Math.floor(k / 3) * 0.33)] as [number, number])
        : [[ax + spec.offsetX, ay + spec.offsetY]];
      const ops: string[] = ["q", cm(m), gs(page, spec.opacity)];
      const a = (spec.rotation * Math.PI) / 180;
      const c = Math.cos(a),
        s = Math.sin(a);
      for (const [px, py] of positions) {
        if (spec.kind === "text") {
          const key = fontKeyFor(spec.style.family, spec.style.bold, spec.style.italic);
          const font = await fonts.forText(key, spec.text);
          const name = addPageResource(page, "Font", "FolioMk", font.ref as PDFRef);
          const tw = font.widthOfTextAtSize(spec.text, spec.style.size);
          const [r, g, b] = hexToPdf(spec.style.color);
          // Center the text on the anchor (vertically on its cap height).
          const ox = spec.anchor[1] === "l" && !spec.tile ? 0 : spec.anchor[1] === "r" && !spec.tile ? -tw : -tw / 2;
          const oy = -spec.style.size * 0.35;
          ops.push(`q ${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} ${fmt(px)} ${fmt(py)} cm BT /${name} ${fmt(spec.style.size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg 1 0 0 1 ${fmt(ox)} ${fmt(oy)} Tm ${font.encodeText(spec.text).toString()} Tj ET Q`);
        } else if (graphic) {
          const iw = w * spec.scale;
          const ih = (iw * graphic.height) / graphic.width;
          const ox = spec.anchor[1] === "l" && !spec.tile ? 0 : spec.anchor[1] === "r" && !spec.tile ? -iw : -iw / 2;
          const oy = spec.anchor[0] === "b" && !spec.tile ? 0 : spec.anchor[0] === "t" && !spec.tile ? -ih : -ih / 2;
          ops.push(`q ${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} ${fmt(px)} ${fmt(py)} cm ${graphicOps(page, graphic, "FolioWm", ox, oy, iw, ih)} Q`);
        }
      }
      ops.push("Q");
      tagStream(doc, page, ops.filter(Boolean).join("\n"), "watermark", spec.behind);
    }
  }
}

// ---------------- Background ----------------

export interface BackgroundSpec {
  kind: "color" | "file";
  color: string;
  file?: GraphicSource;
  opacity: number;
  /** File: fraction of page width (1 = fill width). */
  scale: number;
  pages: number[];
  /** Remove backgrounds previously added to these pages first. */
  replace?: boolean;
}

export async function addBackground(docId: string, spec: BackgroundSpec) {
  await applyDocumentChange(docId, "Add background", async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    await applyBackgroundToDoc(doc, spec);
    return { bytes: await doc.save(), pageIds };
  });
}

export async function applyBackgroundToDoc(doc: PDFDocument, spec: BackgroundSpec) {
  {
    if (spec.replace) removeMarks(doc, ["background"], spec.pages);
    const pages = doc.getPages();
    const graphic = spec.kind === "file" ? await embedGraphic(doc, spec.file) : null;
    for (const i of spec.pages) {
      const page = pages[i];
      if (!page) continue;
      const { w, h, m } = displayFrame(page);
      const ops: string[] = ["q", cm(m), gs(page, spec.opacity)];
      if (spec.kind === "color") {
        const [r, g, b] = hexToPdf(spec.color);
        ops.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg 0 0 ${fmt(w)} ${fmt(h)} re f`);
      } else if (graphic) {
        const iw = w * spec.scale;
        const ih = (iw * graphic.height) / graphic.width;
        ops.push(graphicOps(page, graphic, "FolioBg", (w - iw) / 2, (h - ih) / 2, iw, ih));
      }
      ops.push("Q");
      tagStream(doc, page, ops.filter(Boolean).join("\n"), "background", true);
    }
  }
}

export async function removePageMarks(docId: string, kinds: MarkKind[] | "all", label: string): Promise<number> {
  let removed = 0;
  await applyDocumentChange(docId, label, async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    removed = removeMarks(doc, kinds);
    return { bytes: await doc.save(), pageIds };
  });
  return removed;
}

export async function hasMarks(bytes: Uint8Array, kinds: MarkKind[]): Promise<number> {
  const doc = await loadPdfLib(bytes);
  return countMarks(doc, kinds);
}
