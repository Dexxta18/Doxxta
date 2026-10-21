import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFDocument, type PDFObject } from "./pdflib";
import { canvasToBlob } from "./util";

/**
 * Decoding and re-encoding of image XObjects, for tools that change pixels
 * (redaction) or resample images (compression).
 */

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Stored as JPEG in the file. */
  jpeg: boolean;
  /** No transparency (no soft mask or stencil mask). */
  opaque: boolean;
}

const lookup = (doc: PDFDocument, o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
const num = (o: PDFObject | undefined, fallback = 0) => (o instanceof PDFNumber ? o.asNumber() : fallback);

export function filtersOf(doc: PDFDocument, dict: PDFDict): string[] {
  const f = lookup(doc, dict.get(PDFName.of("Filter")));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (lookup(doc, x) as PDFName)?.decodeText?.() ?? "");
  return [];
}

function decodeParms(doc: PDFDocument, dict: PDFDict, index: number): PDFDict | undefined {
  const p = lookup(doc, dict.get(PDFName.of("DecodeParms")));
  if (p instanceof PDFDict) return p;
  if (p instanceof PDFArray) {
    const v = lookup(doc, p.get(index));
    return v instanceof PDFDict ? v : undefined;
  }
  return undefined;
}

/** Undoes PNG (10–15) and TIFF (2) predictors. */
export function unpredict(data: Uint8Array, parms: PDFDict | undefined, doc: PDFDocument): Uint8Array {
  if (!parms) return data;
  const predictor = num(lookup(doc, parms.get(PDFName.of("Predictor"))), 1);
  if (predictor < 2) return data;
  const colors = num(lookup(doc, parms.get(PDFName.of("Colors"))), 1);
  const bpc = num(lookup(doc, parms.get(PDFName.of("BitsPerComponent"))), 8);
  const columns = num(lookup(doc, parms.get(PDFName.of("Columns"))), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return data;
    const out = new Uint8Array(data);
    for (let r = 0; r * rowBytes < out.length; r++) {
      const base = r * rowBytes;
      for (let i = bpp; i < rowBytes && base + i < out.length; i++) out[base + i] = (out[base + i] + out[base + i - bpp]) & 0xff;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = data.subarray(r * (rowBytes + 1) + 1, (r + 1) * (rowBytes + 1));
    const cur = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      switch (type) {
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a),
            pb = Math.abs(p - b),
            pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

/** Decoded bytes of a stream (all filters pdf-lib supports, plus predictors). Null for image codecs. */
export function decodeStreamData(doc: PDFDocument, stream: PDFRawStream): Uint8Array | null {
  const filters = filtersOf(doc, stream.dict);
  if (filters.some((f) => ["DCTDecode", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "DCT", "CCF"].includes(f))) return null;
  try {
    const data = filters.length ? decodePDFRawStream(stream).decode() : stream.contents;
    return unpredict(data, decodeParms(doc, stream.dict, filters.length - 1), doc);
  } catch {
    return null;
  }
}

interface ColorSpace {
  comps: number;
  /** Converts decoded component values (0–1) to RGB 0–255. */
  toRgb(c: number[], out: Uint8ClampedArray, at: number): void;
  indexed?: { hival: number; lookup: Uint8Array; base: ColorSpace };
}

function resolveColorSpace(doc: PDFDocument, cs: PDFObject | undefined, depth = 0): ColorSpace | null {
  cs = lookup(doc, cs);
  if (depth > 4) return null;
  const name = cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray ? (lookup(doc, cs.get(0)) as PDFName)?.decodeText?.() : undefined;
  const gray: ColorSpace = { comps: 1, toRgb: (c, o, i) => void (o[i] = o[i + 1] = o[i + 2] = c[0] * 255) };
  const rgb: ColorSpace = {
    comps: 3,
    toRgb: (c, o, i) => {
      o[i] = c[0] * 255;
      o[i + 1] = c[1] * 255;
      o[i + 2] = c[2] * 255;
    },
  };
  const cmyk: ColorSpace = {
    comps: 4,
    toRgb: (c, o, i) => {
      const k = 1 - c[3];
      o[i] = 255 * (1 - c[0]) * k;
      o[i + 1] = 255 * (1 - c[1]) * k;
      o[i + 2] = 255 * (1 - c[2]) * k;
    },
  };
  switch (name) {
    case "DeviceGray":
    case "G":
    case "CalGray":
      return gray;
    case "DeviceRGB":
    case "RGB":
    case "CalRGB":
      return rgb;
    case "DeviceCMYK":
    case "CMYK":
      return cmyk;
    case "ICCBased": {
      const stream = lookup(doc, (cs as PDFArray).get(1));
      const n = stream instanceof PDFStream ? num(lookup(doc, stream.dict.get(PDFName.of("N"))), 3) : 3;
      return n === 1 ? gray : n === 4 ? cmyk : rgb;
    }
    case "Indexed":
    case "I": {
      const arr = cs as PDFArray;
      const base = resolveColorSpace(doc, arr.get(1), depth + 1);
      const hival = num(lookup(doc, arr.get(2)));
      const lk = lookup(doc, arr.get(3));
      let table: Uint8Array | null = null;
      if (lk instanceof PDFRawStream) table = decodeStreamData(doc, lk);
      else if (lk && "asBytes" in lk) table = (lk as unknown as { asBytes(): Uint8Array }).asBytes();
      if (!base || !table) return null;
      return { comps: 1, toRgb: () => {}, indexed: { hival, lookup: table, base } };
    }
    default:
      return null;
  }
}

/** Reads one sample row-by-row from packed data. */
function sampleReader(data: Uint8Array, width: number, comps: number, bpc: number) {
  const rowBytes = Math.ceil((width * comps * bpc) / 8);
  const max = (1 << bpc) - 1;
  return (x: number, y: number, c: number): number => {
    const bit = (x * comps + c) * bpc;
    const at = y * rowBytes;
    if (bpc === 8) return data[at + (bit >> 3)] ?? 0;
    if (bpc === 16) return ((data[at + (bit >> 3)] ?? 0) << 8) | (data[at + (bit >> 3) + 1] ?? 0);
    const byte = data[at + (bit >> 3)] ?? 0;
    return (byte >> (8 - bpc - (bit & 7))) & max;
  };
}

function decodeArray(doc: PDFDocument, dict: PDFDict, comps: number, defaultMax: number): number[] {
  const d = lookup(doc, dict.get(PDFName.of("Decode")));
  if (d instanceof PDFArray && d.size() >= comps * 2) return d.asArray().map((x) => num(lookup(doc, x)));
  return Array.from({ length: comps * 2 }, (_, i) => (i % 2 ? defaultMax : 0));
}

async function decodeJpeg(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8ClampedArray } | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return { width: canvas.width, height: canvas.height, rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
  } catch {
    return null;
  }
}

/** Reads a 1-component image (soft mask or stencil) as 0–255 values. */
function decodeGray(doc: PDFDocument, stream: PDFRawStream, invertStencil: boolean): { width: number; height: number; values: Uint8Array } | null {
  const width = num(lookup(doc, stream.dict.get(PDFName.of("Width"))));
  const height = num(lookup(doc, stream.dict.get(PDFName.of("Height"))));
  const isMask = lookup(doc, stream.dict.get(PDFName.of("ImageMask"))) instanceof PDFBool && (lookup(doc, stream.dict.get(PDFName.of("ImageMask"))) as PDFBool).asBoolean();
  const bpc = isMask ? 1 : num(lookup(doc, stream.dict.get(PDFName.of("BitsPerComponent"))), 8);
  const data = decodeStreamData(doc, stream);
  if (!data || !width || !height) return null;
  const read = sampleReader(data, width, 1, bpc);
  const max = (1 << bpc) - 1;
  const [d0, d1] = decodeArray(doc, stream.dict, 1, 1);
  const values = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let v = d0 + (read(x, y, 0) / max) * (d1 - d0);
      // Stencil masks: sample 0 (after Decode) means "paint", which is opaque.
      if (invertStencil) v = 1 - v;
      values[y * width + x] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  return { width, height, values };
}

/** Decodes an image XObject into RGBA, or null when its format isn't supported. */
export async function decodeImage(doc: PDFDocument, stream: PDFRawStream): Promise<DecodedImage | null> {
  const d = stream.dict;
  const width = num(lookup(doc, d.get(PDFName.of("Width"))));
  const height = num(lookup(doc, d.get(PDFName.of("Height"))));
  if (!width || !height || width * height > 60e6) return null;
  const filters = filtersOf(doc, d);
  let rgba: Uint8ClampedArray;
  let jpeg = false;
  if (filters.length === 1 && (filters[0] === "DCTDecode" || filters[0] === "DCT")) {
    const img = await decodeJpeg(stream.contents);
    if (!img || img.width !== width || img.height !== height) return null;
    rgba = img.rgba;
    jpeg = true;
  } else {
    const cs = resolveColorSpace(doc, d.get(PDFName.of("ColorSpace")));
    const bpc = num(lookup(doc, d.get(PDFName.of("BitsPerComponent"))), 8);
    const data = decodeStreamData(doc, stream);
    if (!cs || !data || ![1, 2, 4, 8, 16].includes(bpc)) return null;
    const comps = cs.indexed ? 1 : cs.comps;
    const max = (1 << bpc) - 1;
    const read = sampleReader(data, width, comps, bpc);
    const dec = decodeArray(doc, d, comps, cs.indexed ? max : 1);
    rgba = new Uint8ClampedArray(width * height * 4);
    const c = new Array<number>(4).fill(0);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        if (cs.indexed) {
          const { base, lookup: table, hival } = cs.indexed;
          const raw = read(x, y, 0);
          const idx = Math.min(hival, Math.max(0, Math.round(dec[0] + (raw / max) * (dec[1] - dec[0]))));
          for (let k = 0; k < base.comps; k++) c[k] = (table[idx * base.comps + k] ?? 0) / 255;
          base.toRgb(c, rgba, at);
        } else {
          for (let k = 0; k < comps; k++) c[k] = dec[2 * k] + (read(x, y, k) / max) * (dec[2 * k + 1] - dec[2 * k]);
          cs.toRgb(c, rgba, at);
        }
        rgba[at + 3] = 255;
      }
  }
  // Transparency from a soft mask or a stencil mask.
  let opaque = true;
  const smask = lookup(doc, d.get(PDFName.of("SMask")));
  const mask = lookup(doc, d.get(PDFName.of("Mask")));
  const alphaSource = smask instanceof PDFRawStream ? decodeGray(doc, smask, false) : mask instanceof PDFRawStream ? decodeGray(doc, mask, true) : null;
  if ((smask instanceof PDFRawStream || mask instanceof PDFRawStream) && !alphaSource) return null;
  if (alphaSource) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = Math.min(alphaSource.width - 1, Math.floor((x * alphaSource.width) / width));
        const sy = Math.min(alphaSource.height - 1, Math.floor((y * alphaSource.height) / height));
        const a = alphaSource.values[sy * alphaSource.width + sx];
        rgba[(y * width + x) * 4 + 3] = a;
        if (a !== 255) opaque = false;
      }
  }
  return { width, height, rgba, jpeg, opaque };
}

export function isImageMask(doc: PDFDocument, dict: PDFDict): boolean {
  const m = lookup(doc, dict.get(PDFName.of("ImageMask")));
  return m instanceof PDFBool && m.asBoolean();
}

/** Stencil mask as a "painted" bitmap (1 = painted with the fill color). */
export function decodeStencil(doc: PDFDocument, stream: PDFRawStream): { width: number; height: number; painted: Uint8Array } | null {
  const g = decodeGray(doc, stream, true);
  if (!g) return null;
  return { width: g.width, height: g.height, painted: g.values.map((v) => (v > 127 ? 1 : 0)) };
}

/** Writes a stencil mask back as a new Flate-compressed image XObject. */
export function encodeStencil(doc: PDFDocument, original: PDFRawStream, width: number, height: number, painted: Uint8Array): PDFRef {
  const rowBytes = Math.ceil(width / 8);
  const bits = new Uint8Array(rowBytes * height);
  // Default Decode [0 1]: a 0 sample is painted.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (!painted[y * width + x]) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: width, Height: height, ImageMask: true, BitsPerComponent: 1 };
  const interp = original.dict.get(PDFName.of("Interpolate"));
  if (interp) dict.Interpolate = interp;
  return doc.context.register(doc.context.flateStream(bits, dict as never));
}

/** Encodes RGBA pixels into a new image XObject: JPEG when asked and opaque, otherwise lossless Flate (gray or RGB, with a soft mask only if needed). */
export async function encodeImage(doc: PDFDocument, img: { width: number; height: number; rgba: Uint8ClampedArray }, opts: { jpeg: boolean; quality?: number }): Promise<PDFRef> {
  const { width: w, height: h, rgba } = img;
  let alpha = false,
    gray = true;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) alpha = true;
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) gray = false;
    if (alpha && !gray) break;
  }
  if (opts.jpeg && !alpha) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    const blob = await canvasToBlob(canvas, "image/jpeg", opts.quality ?? 0.9);
    const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    // Write the XObject now (pdf-lib would otherwise wait until save) so callers can inspect it.
    await image.embed();
    return image.ref;
  }
  const ctx = doc.context;
  const comps = gray ? 1 : 3;
  const data = new Uint8Array(w * h * comps);
  const a = alpha ? new Uint8Array(w * h) : null;
  for (let i = 0, p = 0; i < w * h; i++) {
    if (gray) data[p++] = rgba[i * 4];
    else {
      data[p++] = rgba[i * 4];
      data[p++] = rgba[i * 4 + 1];
      data[p++] = rgba[i * 4 + 2];
    }
    if (a) a[i] = rgba[i * 4 + 3];
  }
  const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: gray ? "DeviceGray" : "DeviceRGB", BitsPerComponent: 8 };
  if (a) dict.SMask = ctx.register(ctx.flateStream(a, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 8 } as never));
  return ctx.register(ctx.flateStream(data, dict as never));
}
