import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, loadPdfLib, type PDFDocument, type PDFObject } from "../lib/pdflib";
import { PName, parseContent } from "../lib/contentStream";
import { decodeImage, decodeStreamData, encodeImage, filtersOf, isImageMask } from "../lib/pdfImages";
import { IDENTITY, multiply, type Matrix } from "../lib/geometry";
import { pageContent } from "./contentRedact";
import { sanitizeDoc } from "./sanitize";

/** "Reduce file size": image downsampling and recompression, duplicate removal, stream compression. */

export interface CompressOptions {
  /** Images above this resolution (pixels per inch as displayed) are downsampled to it. */
  targetDpi: number;
  /** JPEG quality, 0–1. */
  quality: number;
  /** Re-encode large photographic images even if they don't need downsampling. */
  recompress: boolean;
  removeMetadata: boolean;
  removeThumbnails: boolean;
}

export const COMPRESS_PRESETS: { id: string; label: string; hint: string; options: CompressOptions }[] = [
  { id: "high", label: "High quality", hint: "Images kept at up to 220 ppi. Good for print.", options: { targetDpi: 220, quality: 0.88, recompress: false, removeMetadata: false, removeThumbnails: true } },
  { id: "balanced", label: "Balanced", hint: "Images at up to 150 ppi. Good for sharing and screen reading.", options: { targetDpi: 150, quality: 0.8, recompress: true, removeMetadata: false, removeThumbnails: true } },
  { id: "small", label: "Smallest file", hint: "Images at up to 96 ppi with stronger compression. Best for email.", options: { targetDpi: 96, quality: 0.62, recompress: true, removeMetadata: true, removeThumbnails: true } },
];

export interface CompressReport {
  before: number;
  after: number;
  images: number;
  duplicates: number;
  streams: number;
}

const lookupIn = (doc: PDFDocument) => (o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
const numOf = (o: PDFObject | undefined, fallback = 0) => (o instanceof PDFNumber ? o.asNumber() : fallback);

/** For every image XObject: the smallest resolution it's displayed at (pixels per inch). */
function imageResolutions(doc: PDFDocument): Map<string, { ref: PDFRef; ppi: number }> {
  const lookup = lookupIn(doc);
  const out = new Map<string, { ref: PDFRef; ppi: number }>();
  const visitedForms = new Set<string>();
  const walk = (data: Uint8Array, resources: PDFDict | undefined, ctm0: Matrix, depth: number) => {
    const xobjects = resources ? lookup(resources.get(PDFName.of("XObject"))) : undefined;
    let ctm = ctm0;
    const stack: Matrix[] = [];
    for (const o of parseContent(data)) {
      if (o.op === "q") stack.push(ctm);
      else if (o.op === "Q") ctm = stack.pop() ?? ctm;
      else if (o.op === "cm" && o.args.length === 6) ctm = multiply(ctm, o.args.map((a) => (typeof a === "number" ? a : 0)) as Matrix);
      else if (o.op === "Do" && o.args[0] instanceof PName && xobjects instanceof PDFDict) {
        const ref = xobjects.get(PDFName.of(o.args[0].name));
        const x = lookup(ref);
        if (!(ref instanceof PDFRef) || !(x instanceof PDFRawStream)) continue;
        const subtype = lookup(x.dict.get(PDFName.of("Subtype")));
        if (subtype === PDFName.of("Image")) {
          const w = numOf(lookup(x.dict.get(PDFName.of("Width"))));
          const h = numOf(lookup(x.dict.get(PDFName.of("Height"))));
          const shownW = Math.hypot(ctm[0], ctm[1]) / 72;
          const shownH = Math.hypot(ctm[2], ctm[3]) / 72;
          if (shownW < 1e-3 || shownH < 1e-3) continue;
          const ppi = Math.min(w / shownW, h / shownH);
          const prev = out.get(ref.tag);
          if (!prev || ppi < prev.ppi) out.set(ref.tag, { ref, ppi });
        } else if (subtype === PDFName.of("Form") && depth < 10) {
          const key = `${ref.tag}@${ctm.map((v) => v.toFixed(2)).join(",")}`;
          if (visitedForms.has(key)) continue;
          visitedForms.add(key);
          const body = decodeStreamData(doc, x);
          const m = lookup(x.dict.get(PDFName.of("Matrix")));
          const fm = m instanceof PDFArray ? (m.asArray().map((v) => numOf(lookup(v))) as Matrix) : IDENTITY;
          const res = lookup(x.dict.get(PDFName.of("Resources")));
          if (body) walk(body, res instanceof PDFDict ? res : resources, multiply(ctm, fm), depth + 1);
        }
      }
    }
  };
  for (const page of doc.getPages()) {
    const data = pageContent(doc, page);
    if (data) walk(data, page.node.Resources(), IDENTITY, 0);
  }
  return out;
}

function streamSize(doc: PDFDocument, s: PDFRawStream): number {
  const smask = lookupIn(doc)(s.dict.get(PDFName.of("SMask")));
  return s.contents.length + (smask instanceof PDFRawStream ? smask.contents.length : 0);
}

/** Whether pixels look like a photo (many colors) rather than flat artwork. */
function photographic(rgba: Uint8ClampedArray): boolean {
  const colors = new Set<number>();
  const step = Math.max(1, Math.floor(rgba.length / 4 / 8192)) * 4;
  for (let i = 0; i < rgba.length && colors.size < 300; i += step) colors.add(((rgba[i] >> 2) << 12) | ((rgba[i + 1] >> 2) << 6) | (rgba[i + 2] >> 2));
  return colors.size >= 300;
}

function resample(img: { width: number; height: number; rgba: Uint8ClampedArray }, scale: number) {
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const src = document.createElement("canvas");
  src.width = img.width;
  src.height = img.height;
  src.getContext("2d")!.putImageData(new ImageData(img.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const dst = document.createElement("canvas");
  dst.width = w;
  dst.height = h;
  const g = dst.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  return { width: w, height: h, rgba: g.getImageData(0, 0, w, h).data };
}

/** Downsamples and recompresses the document's images in place. */
async function compressImages(doc: PDFDocument, opts: CompressOptions, onProgress?: (done: number, total: number) => void): Promise<number> {
  const ctx = doc.context;
  const lookup = lookupIn(doc);
  const images = [...imageResolutions(doc).values()];
  let changed = 0;
  for (let k = 0; k < images.length; k++) {
    onProgress?.(k, images.length);
    const { ref, ppi } = images[k];
    const s = lookup(ref);
    if (!(s instanceof PDFRawStream) || isImageMask(doc, s.dict)) continue;
    const filters = filtersOf(doc, s.dict);
    if (filters.some((f) => f === "JBIG2Decode" || f === "CCITTFaxDecode" || f === "JPXDecode")) continue;
    const w = numOf(lookup(s.dict.get(PDFName.of("Width"))));
    const h = numOf(lookup(s.dict.get(PDFName.of("Height"))));
    if (w * h < 64 * 64) continue;
    const scale = ppi > opts.targetDpi * 1.3 ? opts.targetDpi / ppi : 1;
    const before = streamSize(doc, s);
    if (scale === 1 && (!opts.recompress || before < 40_000)) continue;
    const img = await decodeImage(doc, s).catch(() => null);
    if (!img) continue;
    const small = scale < 1 ? resample(img, scale) : img;
    // Photos become JPEG; flat artwork stays lossless so text in screenshots stays crisp.
    const jpeg = img.opaque && (img.jpeg || photographic(small.rgba));
    if (scale === 1 && !jpeg) continue;
    const newRef = await encodeImage(doc, small, { jpeg, quality: opts.quality });
    const fresh = lookup(newRef);
    if (!(fresh instanceof PDFRawStream) || streamSize(doc, fresh) >= before * 0.92) {
      ctx.delete(newRef);
      continue;
    }
    for (const key of ["Interpolate", "OC", "Intent", "Metadata", "StructParent"]) {
      const v = s.dict.get(PDFName.of(key));
      if (v && !(key === "Metadata" && opts.removeMetadata)) fresh.dict.set(PDFName.of(key), v);
    }
    // Same object number: every page and form that uses the image now gets the smaller one.
    ctx.assign(ref, fresh);
    ctx.delete(newRef);
    changed++;
  }
  onProgress?.(images.length, images.length);
  return changed;
}

/** Hash of a stream's dictionary and data, for duplicate detection. */
function streamKey(s: PDFRawStream): string {
  let h1 = 0x811c9dc5,
    h2 = 0;
  const c = s.contents;
  for (let i = 0; i < c.length; i++) {
    h1 = Math.imul(h1 ^ c[i], 0x01000193);
    h2 = (h2 + c[i] * (i + 1)) | 0;
  }
  const dict = s.dict
    .entries()
    .filter(([k]) => k.decodeText() !== "Length")
    .map(([k, v]) => `${k.decodeText()}=${v.toString()}`)
    .sort()
    .join(";");
  return `${c.length}:${h1 >>> 0}:${h2 >>> 0}:${dict}`;
}

/** Merges identical streams (fonts, images, forms embedded more than once). */
function mergeDuplicateStreams(doc: PDFDocument): number {
  const ctx = doc.context;
  const canonical = new Map<string, PDFRef>();
  const replace = new Map<string, PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 512) continue;
    const type = obj.dict.get(PDFName.of("Type"));
    if (type === PDFName.of("XRef") || type === PDFName.of("ObjStm")) continue;
    const key = streamKey(obj);
    const first = canonical.get(key);
    if (first) replace.set(ref.tag, first);
    else canonical.set(key, ref);
  }
  if (!replace.size) return 0;
  const swap = (v: PDFObject): PDFObject => (v instanceof PDFRef ? (replace.get(v.tag) ?? v) : v);
  const visit = (o: PDFObject) => {
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        const n = swap(v);
        if (n !== v) o.set(k, n);
        else if (v instanceof PDFDict || v instanceof PDFArray) visit(v);
      }
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i);
        const n = swap(v);
        if (n !== v) o.set(i, n);
        else if (v instanceof PDFDict || v instanceof PDFArray) visit(v);
      }
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj instanceof PDFStream ? obj.dict : obj);
  const t = ctx.trailerInfo as Record<string, PDFObject | undefined>;
  for (const k of ["Root", "Info"]) if (t[k]) t[k] = swap(t[k]!);
  for (const tag of replace.keys()) {
    const [num, gen] = tag.split(" ").map(Number);
    ctx.delete(PDFRef.of(num, gen));
  }
  return replace.size;
}

/** Flate-compresses streams that are stored without any filter. */
function compressPlainStreams(doc: PDFDocument): number {
  const ctx = doc.context;
  let n = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Filter")) || obj.contents.length < 256) continue;
    if (obj.dict.get(PDFName.of("Type")) === PDFName.of("XRef")) continue;
    const s = ctx.flateStream(obj.contents);
    for (const [k, v] of obj.dict.entries()) if (k.decodeText() !== "Length") s.dict.set(k, v);
    ctx.assign(ref, s);
    n++;
  }
  return n;
}

/** Produces a smaller version of `bytes`. */
export async function compressBytes(bytes: Uint8Array, opts: CompressOptions, onProgress?: (done: number, total: number) => void): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const doc = await loadPdfLib(bytes);
  const images = await compressImages(doc, opts, onProgress);
  const duplicates = mergeDuplicateStreams(doc);
  const streams = compressPlainStreams(doc);
  if (opts.removeMetadata || opts.removeThumbnails)
    await sanitizeDoc(doc, { metadata: opts.removeMetadata, privateData: opts.removeMetadata, thumbnails: opts.removeThumbnails, attachments: false, comments: false, formFields: false, hiddenText: false, hiddenLayers: false, bookmarks: false, scripts: false });
  const out = await doc.save({ useObjectStreams: true });
  // Never make a file bigger.
  const result = out.length < bytes.length ? out : bytes;
  return { bytes: result, report: { before: bytes.length, after: result.length, images, duplicates, streams } };
}
