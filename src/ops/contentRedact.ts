import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, addPageResource, displayFrame, fontKeyFor, type FontCache, type PDFDocument, type PDFFont, type PDFObject, type PDFPage } from "../lib/pdflib";
import { PName, PString, parseContent, serializeContent, type Op, type Operand } from "../lib/contentStream";
import { decodeImage, decodeStencil, decodeStreamData, encodeImage, encodeStencil, isImageMask } from "../lib/pdfImages";
import { IDENTITY, apply, invert, multiply, type Matrix, type Point } from "../lib/geometry";
import { encodingTable, glyphUnicode, standardFontName, stdGlyphWidth } from "../lib/fontMetrics";
import { fmt, hexToPdf } from "../lib/colors";

/**
 * True redaction: removes the text, image pixels and graphics under the given
 * areas from a page's content (not just covering them). Content the engine
 * can't measure exactly (unknown fonts, exotic image codecs) is reported so
 * the caller can rasterize the page instead.
 */

/** A convex area in PDF user space. */
export type Region = Point[];

export interface RedactOptions {
  text: boolean;
  images: boolean;
  graphics: boolean;
  /** Pixel fill for redacted image areas. */
  fill?: string;
  /** Leave the page untouched when something couldn't be handled. */
  onlyIfComplete?: boolean;
  /** Also remove all invisible text (render mode 3), e.g. for "remove hidden information". */
  removeInvisible?: boolean;
  /** Receives every glyph with its exact position (text extraction). */
  collect?: (g: PageGlyph) => void;
}

/** A glyph as drawn: its text and its box in user space (p0–p1 baseline side, p3–p2 top side). */
export interface PageGlyph {
  text: string;
  quad: Point[];
  origin: Point;
  end: Point;
  /** Font size in user space units. */
  size: number;
}

export interface RedactPageResult {
  changed: boolean;
  removedGlyphs: number;
  changedImages: number;
  removedImages: number;
  removedPaths: number;
  clippedPaths: number;
  /** Why the page should be rasterized instead (empty when fully handled). */
  unsupported: string[];
}

// ---------------- Geometry ----------------

function signedArea(p: Point[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function lineIntersect(p: Point, q: Point, a: Point, b: Point): Point {
  const d = (p.x - q.x) * (a.y - b.y) - (p.y - q.y) * (a.x - b.x);
  if (Math.abs(d) < 1e-12) return q;
  const t = ((p.x - a.x) * (a.y - b.y) - (p.y - a.y) * (a.x - b.x)) / d;
  return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
}

/** Sutherland–Hodgman clipping of `subject` by the convex polygon `clip`. */
function clipPolygon(subject: Point[], clip: Point[]): Point[] {
  const ccw = signedArea(clip) > 0;
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i],
      b = clip[(i + 1) % clip.length];
    const inside = (p: Point) => {
      const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      return ccw ? c >= -1e-9 : c <= 1e-9;
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j],
        q = input[(j + 1) % input.length];
      const pin = inside(p),
        qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) out.push(lineIntersect(p, q, a, b));
    }
  }
  return out;
}

const overlapArea = (a: Point[], b: Point[]) => {
  const c = clipPolygon(a, b);
  return c.length >= 3 ? Math.abs(signedArea(c)) : 0;
};

function bbox(pts: Point[]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

const boxesOverlap = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

function insideConvex(p: Point, poly: Point[]): boolean {
  const ccw = signedArea(poly) > 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (ccw ? c < -1e-6 : c > 1e-6) return false;
  }
  return true;
}

const quad = (m: Matrix, x0: number, y0: number, x1: number, y1: number): Point[] => [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];

/** Region polygons of a rect or a list of quads (UL, UR, LL, LR). */
export function regionsFrom(rect: number[], quads?: number[][]): Region[] {
  const out: Region[] = quads?.length
    ? quads.map((q) => [
        { x: q[0], y: q[1] },
        { x: q[2], y: q[3] },
        { x: q[6], y: q[7] },
        { x: q[4], y: q[5] },
      ])
    : [
        [
          { x: rect[0], y: rect[1] },
          { x: rect[2], y: rect[1] },
          { x: rect[2], y: rect[3] },
          { x: rect[0], y: rect[3] },
        ],
      ];
  return out.filter((r) => Math.abs(signedArea(r)) > 0.01);
}

// ---------------- Fonts ----------------

interface FontInfo {
  ok: boolean;
  vertical: boolean;
  /** Splits a string into character codes. */
  codes(bytes: Uint8Array): { code: number; start: number; end: number }[];
  /** Advance width in 1/1000 text space units. */
  width(code: number): number;
  ascent: number;
  descent: number;
  /** One-byte codes, so word spacing applies to code 32. */
  singleByte: boolean;
  /** Text a character code stands for ("" when unknown). */
  unicode(code: number): string;
}

const UNSUPPORTED_FONT: FontInfo = { ok: false, vertical: false, codes: () => [], width: () => 0, ascent: 800, descent: -200, singleByte: true, unicode: () => "" };

/** Parses a ToUnicode CMap (bfchar / bfrange). */
function parseToUnicode(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const num = (b: Uint8Array) => b.reduce((acc, v) => acc * 256 + v, 0);
  const utf16 = (b: Uint8Array) => {
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return b.length % 2 ? s + String.fromCharCode(b[b.length - 1]) : s;
  };
  for (const o of parseContent(data)) {
    if (o.op === "endbfchar") {
      for (let i = 0; i + 1 < o.args.length; i += 2) {
        const src = o.args[i],
          dst = o.args[i + 1];
        if (src instanceof PString && dst instanceof PString) map.set(num(src.bytes), utf16(dst.bytes));
      }
    } else if (o.op === "endbfrange") {
      for (let i = 0; i + 2 < o.args.length; i += 3) {
        const lo = o.args[i],
          hi = o.args[i + 1],
          dst = o.args[i + 2];
        if (!(lo instanceof PString && hi instanceof PString)) continue;
        const a = num(lo.bytes),
          b = Math.min(num(hi.bytes), a + 65535);
        for (let code = a; code <= b; code++) {
          if (Array.isArray(dst)) {
            const d = dst[code - a];
            if (d instanceof PString) map.set(code, utf16(d.bytes));
          } else if (dst instanceof PString && dst.bytes.length) {
            const bytes = Uint8Array.from(dst.bytes);
            const n = bytes.length;
            const last = ((n >= 2 ? bytes[n - 2] << 8 : 0) | bytes[n - 1]) + (code - a);
            bytes[n - 1] = last & 0xff;
            if (n >= 2) bytes[n - 2] = (last >> 8) & 0xff;
            map.set(code, utf16(bytes));
          }
        }
      }
    }
  }
  return map;
}

function toUnicodeOf(c: Ctx, f: PDFDict): Map<number, string> | null {
  const tu = c.lookup(f.get(PDFName.of("ToUnicode")));
  if (!(tu instanceof PDFRawStream)) return null;
  const data = decodeStreamData(c.doc, tu);
  return data ? parseToUnicode(data) : null;
}

/** Code → glyph name from the font's encoding (base encoding plus /Differences). */
function encodingNames(c: Ctx, f: PDFDict, builtIn: "WinAnsi" | "Symbol" | "ZapfDingbats"): Map<number, string> {
  const table = new Map(encodingTable(builtIn));
  const enc = c.lookup(f.get(PDFName.of("Encoding")));
  const diffs = enc instanceof PDFDict ? c.lookup(enc.get(PDFName.of("Differences"))) : undefined;
  if (diffs instanceof PDFArray) {
    let code = 0;
    for (const item of diffs.asArray()) {
      const v = c.lookup(item);
      if (v instanceof PDFNumber) code = v.asNumber();
      else if (v instanceof PDFName) table.set(code++, v.decodeText());
    }
  }
  return table;
}

type Ctx = { doc: PDFDocument; lookup: (o: PDFObject | undefined) => PDFObject | undefined };

const numOf = (o: PDFObject | undefined, fallback = 0) => (o instanceof PDFNumber ? o.asNumber() : fallback);
const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : undefined);

function descriptorMetrics(c: Ctx, desc: PDFObject | undefined): { ascent: number; descent: number; missing: number } {
  const d = c.lookup(desc);
  let ascent = 0,
    descent = 0,
    missing = 0;
  if (d instanceof PDFDict) {
    ascent = numOf(c.lookup(d.get(PDFName.of("Ascent"))));
    descent = numOf(c.lookup(d.get(PDFName.of("Descent"))));
    missing = numOf(c.lookup(d.get(PDFName.of("MissingWidth"))));
    const fb = c.lookup(d.get(PDFName.of("FontBBox")));
    if (fb instanceof PDFArray && (!ascent || !descent)) {
      const v = fb.asArray().map((x) => numOf(c.lookup(x)));
      if (!ascent) ascent = v[3];
      if (!descent) descent = v[1];
    }
  }
  // Generous vertical extent: accents and descenders of the redacted words count too.
  return { ascent: Math.max(ascent || 800, 700), descent: Math.min(descent || -200, -200), missing };
}

function oneByteCodes(bytes: Uint8Array) {
  return Array.from(bytes, (code, i) => ({ code, start: i, end: i + 1 }));
}

function simpleFont(c: Ctx, f: PDFDict): FontInfo {
  const subtype = nameOf(c.lookup(f.get(PDFName.of("Subtype"))));
  const first = numOf(c.lookup(f.get(PDFName.of("FirstChar"))));
  const widthsObj = c.lookup(f.get(PDFName.of("Widths")));
  const widths = widthsObj instanceof PDFArray ? widthsObj.asArray().map((w) => numOf(c.lookup(w))) : null;
  const m = descriptorMetrics(c, f.get(PDFName.of("FontDescriptor")));
  const std = standardFontName(nameOf(c.lookup(f.get(PDFName.of("BaseFont")))) ?? "");
  const names = encodingNames(c, f, std === "Symbol" || std === "ZapfDingbats" ? std : "WinAnsi");
  const tu = toUnicodeOf(c, f);
  const unicode = (code: number) => tu?.get(code) ?? glyphUnicode(names.get(code) ?? "");
  if (subtype === "Type3") {
    const fm = c.lookup(f.get(PDFName.of("FontMatrix")));
    const matrix = fm instanceof PDFArray ? fm.asArray().map((x) => numOf(c.lookup(x))) : [0.001, 0, 0, 0.001, 0, 0];
    const fbObj = c.lookup(f.get(PDFName.of("FontBBox")));
    const fb = fbObj instanceof PDFArray ? fbObj.asArray().map((x) => numOf(c.lookup(x))) : [0, -200, 1000, 800];
    if (!widths) return UNSUPPORTED_FONT;
    const sx = matrix[0] * 1000,
      sy = Math.abs(matrix[3]) * 1000;
    return {
      ok: true,
      vertical: false,
      codes: oneByteCodes,
      width: (code) => (widths[code - first] ?? 0) * sx,
      ascent: Math.max(fb[3] * sy, 700),
      descent: Math.min(fb[1] * sy, -200),
      singleByte: true,
      unicode,
    };
  }
  if (widths) {
    return { ok: true, vertical: false, codes: oneByteCodes, width: (code) => widths[code - first] ?? m.missing, ascent: m.ascent, descent: m.descent, singleByte: true, unicode };
  }
  // No /Widths: a non-embedded standard font.
  if (!std) return UNSUPPORTED_FONT;
  return { ok: true, vertical: false, codes: oneByteCodes, width: (code) => stdGlyphWidth(std, names.get(code) ?? "") ?? 0, ascent: m.ascent, descent: m.descent, singleByte: true, unicode };
}

interface Codespace {
  n: number;
  lo: number[];
  hi: number[];
}

function parseCMap(data: Uint8Array): { codespace: Codespace[]; cid: (code: number) => number; vertical: boolean; usesOther: boolean } {
  const ops = parseContent(data);
  const codespace: Codespace[] = [];
  const ranges: [number, number, number][] = [];
  const singles = new Map<number, number>();
  let vertical = false;
  let usesOther = false;
  const bytesNum = (b: Uint8Array) => b.reduce((acc, v) => acc * 256 + v, 0);
  for (const o of ops) {
    if (o.op === "endcodespacerange") {
      for (let i = 0; i + 1 < o.args.length; i += 2) {
        const lo = o.args[i],
          hi = o.args[i + 1];
        if (lo instanceof PString && hi instanceof PString) codespace.push({ n: lo.bytes.length, lo: [...lo.bytes], hi: [...hi.bytes] });
      }
    } else if (o.op === "endcidrange") {
      for (let i = 0; i + 2 < o.args.length; i += 3) {
        const lo = o.args[i],
          hi = o.args[i + 1],
          cid = o.args[i + 2];
        if (lo instanceof PString && hi instanceof PString && typeof cid === "number") ranges.push([bytesNum(lo.bytes), bytesNum(hi.bytes), cid]);
      }
    } else if (o.op === "endcidchar") {
      for (let i = 0; i + 1 < o.args.length; i += 2) {
        const code = o.args[i],
          cid = o.args[i + 1];
        if (code instanceof PString && typeof cid === "number") singles.set(bytesNum(code.bytes), cid);
      }
    } else if (o.op === "def" && o.args[0] instanceof PName && o.args[0].name === "WMode" && o.args[1] === 1) vertical = true;
    else if (o.op === "usecmap") usesOther = true;
  }
  return {
    codespace,
    vertical,
    usesOther,
    cid: (code) => {
      const s = singles.get(code);
      if (s !== undefined) return s;
      for (const [lo, hi, cid] of ranges) if (code >= lo && code <= hi) return cid + code - lo;
      return 0;
    },
  };
}

function compositeFont(c: Ctx, f: PDFDict): FontInfo {
  const descendants = c.lookup(f.get(PDFName.of("DescendantFonts")));
  const cidFont = descendants instanceof PDFArray ? c.lookup(descendants.get(0)) : undefined;
  if (!(cidFont instanceof PDFDict)) return UNSUPPORTED_FONT;
  const encoding = c.lookup(f.get(PDFName.of("Encoding")));
  let codes: FontInfo["codes"];
  let cid: (code: number) => number = (code) => code;
  const twoByte = (bytes: Uint8Array) => {
    const out = [];
    for (let i = 0; i < bytes.length; i += 2) out.push({ code: i + 1 < bytes.length ? (bytes[i] << 8) | bytes[i + 1] : bytes[i], start: i, end: Math.min(i + 2, bytes.length) });
    return out;
  };
  const encName = nameOf(encoding);
  if (encName === "Identity-H") codes = twoByte;
  else if (encName === "Identity-V") return { ...UNSUPPORTED_FONT, vertical: true };
  else if (encoding instanceof PDFRawStream) {
    const data = decodeStreamData(c.doc, encoding);
    if (!data) return UNSUPPORTED_FONT;
    const cmap = parseCMap(data);
    const useCMap = nameOf(c.lookup(encoding.dict.get(PDFName.of("UseCMap"))));
    if (cmap.vertical || numOf(c.lookup(encoding.dict.get(PDFName.of("WMode")))) === 1) return { ...UNSUPPORTED_FONT, vertical: true };
    if ((cmap.usesOther || useCMap) && useCMap !== "Identity-H") return UNSUPPORTED_FONT;
    if (!cmap.codespace.length) codes = twoByte;
    else {
      const spaces = [...cmap.codespace].sort((a, b) => a.n - b.n);
      codes = (bytes) => {
        const out = [];
        let i = 0;
        while (i < bytes.length) {
          let n = 1;
          for (const s of spaces) {
            if (i + s.n > bytes.length) continue;
            let ok = true;
            for (let k = 0; k < s.n && ok; k++) ok = bytes[i + k] >= s.lo[k] && bytes[i + k] <= s.hi[k];
            if (ok) {
              n = s.n;
              break;
            }
          }
          let code = 0;
          for (let k = 0; k < n; k++) code = code * 256 + bytes[i + k];
          out.push({ code, start: i, end: i + n });
          i += n;
        }
        return out;
      };
      cid = cmap.cid;
    }
  } else return UNSUPPORTED_FONT; // Other predefined CMaps (code → CID tables we don't ship).

  const dw = numOf(c.lookup(cidFont.get(PDFName.of("DW"))), 1000);
  const widths = new Map<number, number>();
  const w = c.lookup(cidFont.get(PDFName.of("W")));
  if (w instanceof PDFArray) {
    const items = w.asArray().map((x) => c.lookup(x));
    for (let i = 0; i < items.length; ) {
      const first = numOf(items[i]);
      const next = items[i + 1];
      if (next instanceof PDFArray) {
        next.asArray().forEach((v, k) => widths.set(first + k, numOf(c.lookup(v))));
        i += 2;
      } else {
        const last = numOf(next);
        const width = numOf(items[i + 2]);
        for (let k = first; k <= last && k - first < 65536; k++) widths.set(k, width);
        i += 3;
      }
    }
  }
  const m = descriptorMetrics(c, cidFont.get(PDFName.of("FontDescriptor")));
  const tu = toUnicodeOf(c, f);
  return { ok: true, vertical: false, codes, width: (code) => widths.get(cid(code)) ?? dw, ascent: m.ascent, descent: m.descent, singleByte: false, unicode: (code) => tu?.get(code) ?? "" };
}

function loadFont(c: Ctx, cache: Map<PDFObject, FontInfo>, obj: PDFObject | undefined): FontInfo {
  if (!obj) return UNSUPPORTED_FONT;
  const hit = cache.get(obj);
  if (hit) return hit;
  const f = c.lookup(obj);
  let info = UNSUPPORTED_FONT;
  if (f instanceof PDFDict) {
    try {
      info = nameOf(c.lookup(f.get(PDFName.of("Subtype")))) === "Type0" ? compositeFont(c, f) : simpleFont(c, f);
    } catch (e) {
      console.warn("font metrics", e);
    }
  }
  cache.set(obj, info);
  return info;
}

// ---------------- Content processing ----------------

interface GState {
  ctm: Matrix;
  font: FontInfo | null;
  /** Text render mode. */
  tr: number;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
}

const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

class Redactor {
  readonly result: RedactPageResult = { changed: false, removedGlyphs: 0, changedImages: 0, removedImages: 0, removedPaths: 0, clippedPaths: 0, unsupported: [] };
  private readonly fonts = new Map<PDFObject, FontInfo>();
  private readonly c: Ctx;
  private readonly boxes: number[][];

  constructor(
    private readonly doc: PDFDocument,
    private readonly regions: Region[],
    private readonly opts: RedactOptions,
  ) {
    this.c = { doc, lookup: (o) => (o instanceof PDFRef ? doc.context.lookup(o) : o) };
    this.boxes = regions.map(bbox);
  }

  private flag(reason: string) {
    if (!this.result.unsupported.includes(reason)) this.result.unsupported.push(reason);
  }

  /** How much of `poly` (user space) lies under the redaction areas, 0–1. */
  private coverage(poly: Point[]): number {
    const area = Math.abs(signedArea(poly));
    const b = bbox(poly);
    let covered = 0;
    for (let i = 0; i < this.regions.length; i++) {
      if (!boxesOverlap(b, this.boxes[i])) continue;
      if (area < 1e-6) {
        const cx = (b[0] + b[2]) / 2,
          cy = (b[1] + b[3]) / 2;
        if (insideConvex({ x: cx, y: cy }, this.regions[i])) return 1;
        continue;
      }
      covered = Math.max(covered, overlapArea(poly, this.regions[i]) / area);
      if (covered >= 0.999) break;
    }
    return covered;
  }

  private touches(poly: Point[]): boolean {
    const b = bbox(poly);
    return this.regions.some((r, i) => boxesOverlap(b, this.boxes[i]) && overlapArea(poly, r) > 1e-4);
  }

  private resource(resources: PDFDict | undefined, kind: string, name: string): PDFObject | undefined {
    const dict = resources && this.c.lookup(resources.get(PDFName.of(kind)));
    return dict instanceof PDFDict ? dict.get(PDFName.of(name)) : undefined;
  }

  private addXObject(resources: PDFDict, ref: PDFRef): string {
    const ctx = this.doc.context;
    let dict = this.c.lookup(resources.get(PDFName.of("XObject")));
    if (!(dict instanceof PDFDict)) {
      dict = ctx.obj({});
      resources.set(PDFName.of("XObject"), dict);
    }
    const d = dict as PDFDict;
    let i = 1;
    while (d.has(PDFName.of(`FRd${i}`))) i++;
    d.set(PDFName.of(`FRd${i}`), ref);
    return `FRd${i}`;
  }

  /** Clip ops that exclude every redaction area (one even-odd clip per area). */
  private exclusionClip(ctm: Matrix): Op[] {
    const inv = invert(ctm);
    const big = quad(inv, -1e5, -1e5, 1e5, 1e5);
    const ops: Op[] = [];
    const poly = (pts: Point[]) => {
      ops.push({ op: "m", args: [pts[0].x, pts[0].y] });
      for (const p of pts.slice(1)) ops.push({ op: "l", args: [p.x, p.y] });
      ops.push({ op: "h", args: [] });
    };
    for (const r of this.regions) {
      poly(big);
      poly(r.map((p) => apply(inv, p.x, p.y)));
      ops.push({ op: "W*", args: [] }, { op: "n", args: [] });
    }
    return ops;
  }

  async process(ops: Op[], resources: PDFDict | undefined, ctm0: Matrix, depth = 0): Promise<{ ops: Op[]; changed: boolean }> {
    const out: Op[] = [];
    let changed = false;
    let gs: GState = { ctm: ctm0, font: null, tr: 0, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
    const stack: GState[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let path: Op[] = [];
    let pathPts: Point[] = [];
    let clipOp: Op | null = null;
    let cur: Point = { x: 0, y: 0 };
    let start: Point = { x: 0, y: 0 };

    const nextLine = (tx: number, ty: number) => {
      tlm = multiply(tlm, [1, 0, 0, 1, tx, ty]);
      tm = tlm;
    };
    const userPt = (x: number, y: number) => apply(gs.ctm, x, y);

    for (const o of ops) {
      const a = o.args;
      const n = (i: number) => (typeof a[i] === "number" ? (a[i] as number) : 0);
      // ----- paths -----
      if (PATH_OPS.has(o.op)) {
        path.push(o);
        switch (o.op) {
          case "m":
            cur = start = { x: n(0), y: n(1) };
            pathPts.push(userPt(cur.x, cur.y));
            break;
          case "l":
            cur = { x: n(0), y: n(1) };
            pathPts.push(userPt(cur.x, cur.y));
            break;
          case "c":
            pathPts.push(userPt(n(0), n(1)), userPt(n(2), n(3)), userPt(n(4), n(5)));
            cur = { x: n(4), y: n(5) };
            break;
          case "v":
          case "y":
            pathPts.push(userPt(n(0), n(1)), userPt(n(2), n(3)));
            cur = { x: n(2), y: n(3) };
            break;
          case "h":
            cur = start;
            break;
          case "re":
            pathPts.push(...quad(gs.ctm, n(0), n(1), n(0) + n(2), n(1) + n(3)));
            cur = start = { x: n(0), y: n(1) };
            break;
        }
        continue;
      }
      if (o.op === "W" || o.op === "W*") {
        clipOp = o;
        continue;
      }
      if (PAINT_OPS.has(o.op)) {
        const painted = o.op !== "n";
        if (this.opts.graphics && painted && pathPts.length && this.touches(pathPts)) {
          const inside = this.regions.some((r) => pathPts.every((p) => insideConvex(p, r)));
          changed = true;
          if (inside) this.result.removedPaths++;
          else {
            this.result.clippedPaths++;
            out.push({ op: "q", args: [] }, ...this.exclusionClip(gs.ctm), ...path, o, { op: "Q", args: [] });
          }
          if (clipOp) out.push(...path, clipOp, { op: "n", args: [] });
        } else {
          out.push(...path);
          if (clipOp) out.push(clipOp);
          out.push(o);
        }
        path = [];
        pathPts = [];
        clipOp = null;
        continue;
      }
      if (path.length) {
        // Malformed: an operator inside a path object. Keep it as it was.
        out.push(...path);
        if (clipOp) out.push(clipOp);
        path = [];
        pathPts = [];
        clipOp = null;
      }

      switch (o.op) {
        case "q":
          stack.push(gs);
          gs = { ...gs };
          break;
        case "Q":
          gs = stack.pop() ?? gs;
          break;
        case "cm":
          gs = { ...gs, ctm: multiply(gs.ctm, [n(0), n(1), n(2), n(3), n(4), n(5)]) };
          break;
        case "BT":
          tm = tlm = IDENTITY;
          break;
        case "Tf": {
          const name = a[0] instanceof PName ? a[0].name : "";
          gs = { ...gs, font: loadFont(this.c, this.fonts, this.resource(resources, "Font", name)), size: n(1) };
          break;
        }
        case "Tc":
          gs = { ...gs, tc: n(0) };
          break;
        case "Tw":
          gs = { ...gs, tw: n(0) };
          break;
        case "Tz":
          gs = { ...gs, th: n(0) / 100 };
          break;
        case "TL":
          gs = { ...gs, tl: n(0) };
          break;
        case "Ts":
          gs = { ...gs, rise: n(0) };
          break;
        case "Tr":
          gs = { ...gs, tr: n(0) };
          break;
        case "Td":
          nextLine(n(0), n(1));
          break;
        case "TD":
          gs = { ...gs, tl: -n(1) };
          nextLine(n(0), n(1));
          break;
        case "Tm":
          tm = tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
          break;
        case "T*":
          nextLine(0, -gs.tl);
          break;
        case "gs": {
          const egs = this.c.lookup(this.resource(resources, "ExtGState", a[0] instanceof PName ? a[0].name : ""));
          const font = egs instanceof PDFDict ? this.c.lookup(egs.get(PDFName.of("Font"))) : undefined;
          if (font instanceof PDFArray) gs = { ...gs, font: loadFont(this.c, this.fonts, font.get(0)), size: numOf(this.c.lookup(font.get(1))) };
          break;
        }
      }

      if (o.op === "Tj" || o.op === "TJ" || o.op === "'" || o.op === '"') {
        if (o.op === "'") nextLine(0, -gs.tl);
        if (o.op === '"') {
          gs = { ...gs, tw: n(0), tc: n(1) };
          nextLine(0, -gs.tl);
        }
        const items: Operand[] = o.op === "TJ" ? (Array.isArray(a[0]) ? (a[0] as Operand[]) : []) : [a[o.op === '"' ? 2 : 0]];
        const shown = this.opts.text ? this.showText(items, gs, tm) : null;
        if (shown === "unsupported") {
          this.flag("font");
          out.push(o);
          continue;
        }
        if (shown) tm = multiply(tm, [1, 0, 0, 1, shown.advance, 0]);
        if (shown?.changed) {
          changed = true;
          if (o.op === "'") out.push({ op: "T*", args: [] });
          if (o.op === '"') out.push({ op: "Tw", args: [n(0)] }, { op: "Tc", args: [n(1)] }, { op: "T*", args: [] });
          out.push({ op: "TJ", args: [shown.items] });
        } else out.push(o);
        continue;
      }

      if (o.op === "BI" && o.inline) {
        if (this.opts.images && this.touches(quad(gs.ctm, 0, 0, 1, 1))) {
          this.result.removedImages++;
          changed = true;
          continue;
        }
        out.push(o);
        continue;
      }

      if (o.op === "sh" && this.opts.graphics) {
        changed = true;
        out.push({ op: "q", args: [] }, ...this.exclusionClip(gs.ctm), o, { op: "Q", args: [] });
        continue;
      }

      if (o.op === "Do" && a[0] instanceof PName && resources) {
        const ref = this.resource(resources, "XObject", a[0].name);
        const xobj = this.c.lookup(ref);
        if (xobj instanceof PDFRawStream) {
          const subtype = nameOf(this.c.lookup(xobj.dict.get(PDFName.of("Subtype"))));
          if (subtype === "Form" && this.opts.collect && !this.regions.length) await this.collectForm(xobj, gs.ctm, resources, depth);
          const replacement = subtype === "Image" ? await this.image(xobj, gs.ctm) : subtype === "Form" ? await this.form(xobj, gs.ctm, resources, depth) : null;
          if (replacement) {
            changed = true;
            out.push({ op: "Do", args: [new PName(this.addXObject(resources, replacement))] });
            continue;
          }
        }
      }
      out.push(o);
    }
    out.push(...path);
    return { ops: out, changed };
  }

  /** Removes covered glyphs from a text-showing operation. */
  private showText(items: Operand[], gs: GState, tm: Matrix): { items: Operand[]; changed: boolean; advance: number } | "unsupported" | null {
    const font = gs.font;
    const m = multiply(gs.ctm, tm);
    const invisible = !!this.opts.removeInvisible && gs.tr === 3;
    if (!font || !font.ok || font.vertical) {
      if (invisible) return this.dropAll(items);
      // Unknown widths: only a problem if this line could reach a redaction area.
      const band = quad(m, -1e6, gs.rise - 2 * Math.abs(gs.size), 1e6, gs.rise + 2 * Math.abs(gs.size));
      return this.touches(band) ? "unsupported" : null;
    }
    const size = gs.size,
      th = gs.th;
    const y0 = gs.rise + (font.descent / 1000) * size,
      y1 = gs.rise + (font.ascent / 1000) * size;
    const out: Operand[] = [];
    let x = 0;
    let removedAdvance = 0;
    let keep: number[] = [];
    let changed = false;
    const flushString = () => {
      if (keep.length) out.push(new PString(Uint8Array.from(keep)));
      keep = [];
    };
    const flushRemoved = () => {
      if (!removedAdvance) return;
      flushString();
      const k = size * th ? (-removedAdvance / (size * th)) * 1000 : 0;
      const last = out[out.length - 1];
      if (typeof last === "number") out[out.length - 1] = last + k;
      else out.push(k);
      removedAdvance = 0;
    };
    for (const item of items) {
      if (typeof item === "number") {
        flushRemoved();
        flushString();
        out.push(item);
        x += (-item / 1000) * size * th;
        continue;
      }
      if (!(item instanceof PString)) continue;
      for (const g of font.codes(item.bytes)) {
        const w0 = font.width(g.code) / 1000;
        const space = font.singleByte && g.end - g.start === 1 && item.bytes[g.start] === 32;
        const advance = (w0 * size + gs.tc + (space ? gs.tw : 0)) * th;
        const glyphW = w0 * size * th;
        const poly = quad(m, x, y0, x + (glyphW || 0), y1);
        if (this.opts.collect) {
          const o = apply(m, x, gs.rise);
          const up = apply(m, x, gs.rise + size);
          this.opts.collect({ text: font.unicode(g.code), quad: poly, origin: o, end: apply(m, x + advance, gs.rise), size: Math.hypot(up.x - o.x, up.y - o.y) });
        }
        if (invisible || this.coverage(poly) >= 0.25) {
          removedAdvance += advance;
          this.result.removedGlyphs++;
          changed = true;
        } else {
          flushRemoved();
          for (let k = g.start; k < g.end; k++) keep.push(item.bytes[k]);
        }
        x += advance;
      }
    }
    flushRemoved();
    flushString();
    return { items: out, changed, advance: x };
  }

  /** Invisible text in a font we can't measure: drop the strings (positions after it may shift, but nothing is shown). */
  private dropAll(items: Operand[]): { items: Operand[]; changed: boolean; advance: number } {
    const kept = items.filter((i) => typeof i === "number");
    this.result.removedGlyphs += items.length - kept.length;
    return { items: kept, changed: kept.length !== items.length, advance: 0 };
  }

  /** Redacts the pixels of an image drawn with `ctm`; returns the replacement image. */
  private async image(stream: PDFRawStream, ctm: Matrix): Promise<PDFRef | null> {
    if (!this.opts.images || !this.touches(quad(ctm, 0, 0, 1, 1))) return null;
    const w = numOf(this.c.lookup(stream.dict.get(PDFName.of("Width"))));
    const h = numOf(this.c.lookup(stream.dict.get(PDFName.of("Height"))));
    if (!w || !h) return null;
    // Region polygons in image pixel space (image space is the unit square, y up).
    const inv = invert(ctm);
    const polys = this.regions.map((r) => r.map((p) => apply(inv, p.x, p.y)).map((p) => ({ x: p.x * w, y: (1 - p.y) * h })));
    const mask = rasterizePolygons(w, h, polys);
    if (isImageMask(this.doc, stream.dict)) {
      const stencil = decodeStencil(this.doc, stream);
      if (!stencil) {
        this.flag("image");
        return null;
      }
      for (let i = 0; i < mask.length; i++) if (mask[i]) stencil.painted[i] = 0;
      this.result.changedImages++;
      return encodeStencil(this.doc, stream, w, h, stencil.painted);
    }
    const img = await decodeImage(this.doc, stream);
    if (!img) {
      this.flag("image");
      return null;
    }
    const [r, g, b] = hexToPdf(this.opts.fill ?? "#000000").map((v) => Math.round(v * 255));
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      img.rgba[i * 4] = r;
      img.rgba[i * 4 + 1] = g;
      img.rgba[i * 4 + 2] = b;
      img.rgba[i * 4 + 3] = 255;
    }
    this.result.changedImages++;
    return encodeImage(this.doc, img, { jpeg: img.jpeg && img.opaque, quality: 0.92 });
  }

  /** Walks a form XObject for text extraction only. */
  private async collectForm(stream: PDFRawStream, ctm: Matrix, parentResources: PDFDict, depth: number) {
    if (depth > 12) return;
    const fmObj = this.c.lookup(stream.dict.get(PDFName.of("Matrix")));
    const fm = fmObj instanceof PDFArray ? (fmObj.asArray().map((x) => numOf(this.c.lookup(x))) as Matrix) : IDENTITY;
    const data = decodeStreamData(this.doc, stream);
    if (!data) return;
    const res = this.c.lookup(stream.dict.get(PDFName.of("Resources")));
    await this.process(parseContent(data), res instanceof PDFDict ? res : parentResources, multiply(ctm, fm), depth + 1);
  }

  /** Redacts inside a form XObject; returns a redacted copy when something changed. */
  private async form(stream: PDFRawStream, ctm: Matrix, parentResources: PDFDict, depth: number): Promise<PDFRef | null> {
    const fmObj = this.c.lookup(stream.dict.get(PDFName.of("Matrix")));
    const fm = fmObj instanceof PDFArray ? (fmObj.asArray().map((x) => numOf(this.c.lookup(x))) as Matrix) : IDENTITY;
    const formCtm = multiply(ctm, fm);
    const bbObj = this.c.lookup(stream.dict.get(PDFName.of("BBox")));
    const bb = bbObj instanceof PDFArray ? bbObj.asArray().map((x) => numOf(this.c.lookup(x))) : null;
    if (bb && !this.touches(quad(formCtm, bb[0], bb[1], bb[2], bb[3]))) return null;
    if (depth > 12) {
      this.flag("nesting");
      return null;
    }
    const data = decodeStreamData(this.doc, stream);
    if (!data) {
      this.flag("form");
      return null;
    }
    const res = this.c.lookup(stream.dict.get(PDFName.of("Resources")));
    const resources = res instanceof PDFDict ? res : parentResources;
    const r = await this.process(parseContent(data), resources, formCtm, depth + 1);
    if (!r.changed) return null;
    const ctx = this.doc.context;
    const copy = ctx.flateStream(serializeContent(r.ops));
    for (const [k, v] of stream.dict.entries()) {
      const key = k.decodeText();
      if (key !== "Length" && key !== "Filter" && key !== "DecodeParms") copy.dict.set(k, v);
    }
    return ctx.register(copy);
  }
}

/** Marks the pixels covered by polygons (pixel space, y down). */
function rasterizePolygons(w: number, h: number, polys: Point[][]): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  for (const p of polys) {
    ctx.beginPath();
    p.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
    ctx.closePath();
    ctx.fill();
    // Include partially covered edge pixels.
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 0 ? 1 : 0;
  return mask;
}

/** Reads a page's content (all streams joined). */
export function pageContent(doc: PDFDocument, page: PDFPage): Uint8Array | null {
  const contents = page.node.get(PDFName.of("Contents"));
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  const streams = resolved instanceof PDFArray ? resolved.asArray().map((r) => (r instanceof PDFRef ? doc.context.lookup(r) : r)) : [resolved];
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    if (!s) continue;
    if (!(s instanceof PDFRawStream)) {
      if (s instanceof PDFStream) parts.push(s.getContents());
      continue;
    }
    const d = decodeStreamData(doc, s);
    if (!d) return null;
    parts.push(d);
  }
  let size = 0;
  for (const p of parts) size += p.length + 1;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    out[at + p.length] = 0x0a;
    at += p.length + 1;
  }
  return out;
}

/** Removes content under `regions` from one page. */
export async function redactPage(doc: PDFDocument, page: PDFPage, regions: Region[], opts: RedactOptions): Promise<RedactPageResult> {
  const r = new Redactor(doc, regions, opts);
  if (!regions.length && !opts.removeInvisible) return r.result;
  const data = pageContent(doc, page);
  if (!data) {
    r.result.unsupported.push("content");
    return r.result;
  }
  page.node.normalize();
  const resources = page.node.Resources();
  const res = await r.process(parseContent(data), resources, IDENTITY);
  if (!res.changed || (opts.onlyIfComplete && r.result.unsupported.length)) return r.result;
  const ctx = doc.context;
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(serializeContent(res.ops))));
  r.result.changed = true;
  return r.result;
}

/** Every glyph of a page, in drawing order, with exact positions. Null when the content can't be read. */
export async function extractGlyphs(doc: PDFDocument, page: PDFPage): Promise<PageGlyph[] | null> {
  const glyphs: PageGlyph[] = [];
  const r = new Redactor(doc, [], { text: true, images: false, graphics: false, collect: (g) => glyphs.push(g) });
  const data = pageContent(doc, page);
  if (!data) return null;
  await r.process(parseContent(data), page.node.Resources(), IDENTITY);
  return glyphs;
}

/** Joins glyphs into text, inserting spaces and line breaks from their layout; map[i] is the glyph of character i (-1 for inserted ones). */
export function glyphText(glyphs: PageGlyph[]): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  const push = (s: string, g: number) => {
    text += s;
    for (let k = 0; k < s.length; k++) map.push(g);
  };
  glyphs.forEach((g, i) => {
    const prev = glyphs[i - 1];
    if (prev) {
      const dx = prev.end.x - prev.origin.x,
        dy = prev.end.y - prev.origin.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = len > 1e-6 ? dx / len : 1,
        uy = len > 1e-6 ? dy / len : 0;
      const vx = g.origin.x - prev.end.x,
        vy = g.origin.y - prev.end.y;
      const along = vx * ux + vy * uy;
      const perp = Math.abs(vx * uy - vy * ux);
      const size = Math.max(g.size, prev.size, 1);
      const last = text[text.length - 1];
      if (perp > size * 0.6 || along < -size * 3) {
        if (last !== "\n") push("\n", -1);
      } else if (along > size * 0.22 && last !== " " && last !== "\n" && !/^\s/.test(g.text)) push(" ", -1);
    }
    push(g.text, i);
  });
  return { text, map };
}

/** Quads (UL, UR, LL, LR) covering glyphs, one per line. */
export function glyphQuads(glyphs: PageGlyph[], indexes: number[]): number[][] {
  const out: number[][] = [];
  let first: PageGlyph | null = null;
  let last: PageGlyph | null = null;
  const flush = () => {
    if (!first || !last) return;
    const ul = first.quad[3],
      ll = first.quad[0],
      ur = last.quad[2],
      lr = last.quad[1];
    out.push([ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y]);
  };
  for (const i of indexes) {
    const g = glyphs[i];
    if (!g) continue;
    if (last) {
      const dx = last.end.x - last.origin.x,
        dy = last.end.y - last.origin.y;
      const len = Math.hypot(dx, dy) || 1;
      const perp = Math.abs((g.origin.x - last.origin.x) * (dy / len) - (g.origin.y - last.origin.y) * (dx / len));
      if (perp > Math.max(g.size, last.size) * 0.5) {
        flush();
        first = null;
      }
    }
    if (!first) first = g;
    last = g;
  }
  flush();
  return out;
}

/** Used by Edit text: removes the original glyphs under the edited blocks. */
export async function removeTextInRects(doc: PDFDocument, pageIndex: number, rects: [number, number, number, number][]): Promise<boolean> {
  const page = doc.getPages()[pageIndex];
  if (!page) return false;
  const regions = rects.flatMap((rc) => regionsFrom(rc));
  const res = await redactPage(doc, page, regions, { text: true, images: false, graphics: false, onlyIfComplete: true });
  return res.unsupported.length === 0 && res.removedGlyphs > 0;
}

// ---------------- Page-level helpers used when applying redactions ----------------

/** Replaces a page's content with a rendering of it in which the areas are painted over. */
export async function rasterizePage(doc: PDFDocument, page: PDFPage, render: (scale: number) => Promise<{ canvas: HTMLCanvasElement; toCanvas: (x: number, y: number) => [number, number] }>, regions: Region[], fill: string) {
  const { w, h, m } = displayFrame(page);
  const scale = Math.min(200 / 72, 4200 / Math.max(w, h));
  const { canvas, toCanvas } = await render(scale);
  const g = canvas.getContext("2d")!;
  g.fillStyle = fill;
  for (const r of regions) {
    g.beginPath();
    r.forEach((p, i) => {
      const [x, y] = toCanvas(p.x, p.y);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.closePath();
    g.fill();
  }
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("render failed"))), "image/jpeg", 0.9));
  const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const ctx = doc.context;
  page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { FRast: img.ref } }));
  const ops = `q ${m.map(fmt).join(" ")} cm ${fmt(w)} 0 0 ${fmt(h)} 0 0 cm /FRast Do Q`;
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(ops)));
}

/** Removes annotations and form widgets left in the file that overlap the areas. Returns the count. */
export function removeAnnotationsIn(doc: PDFDocument, page: PDFPage, regions: Region[]): number {
  const lookup = (o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const annots = lookup(page.node.get(PDFName.of("Annots")));
  if (!(annots instanceof PDFArray)) return 0;
  const keep: PDFObject[] = [];
  const removedWidgets = new Set<PDFObject>();
  let removed = 0;
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    const d = lookup(ref);
    const rect = d instanceof PDFDict ? lookup(d.get(PDFName.of("Rect"))) : undefined;
    if (rect instanceof PDFArray && rect.size() === 4) {
      const [x0, y0, x1, y1] = rect.asArray().map((x) => numOf(lookup(x)));
      const poly = quad(IDENTITY, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
      const b = bbox(poly);
      if (regions.some((r) => boxesOverlap(b, bbox(r)) && overlapArea(poly, r) > 1e-4)) {
        removed++;
        if (nameOf(lookup((d as PDFDict).get(PDFName.of("Subtype")))) === "Widget") removedWidgets.add(ref);
        continue;
      }
    }
    keep.push(ref);
  }
  if (!removed) return 0;
  page.node.set(PDFName.of("Annots"), doc.context.obj(keep));
  if (removedWidgets.size) {
    try {
      const form = doc.getForm();
      for (const field of form.getFields()) {
        if (field.acroField.getWidgets().some((w) => [...removedWidgets].some((r) => r instanceof PDFRef && doc.context.getObjectRef(w.dict) === r))) form.removeField(field);
      }
    } catch (e) {
      console.warn("removing redacted fields", e);
    }
  }
  return removed;
}

/** Paints the redaction marks (fill and optional overlay text) on top of the page. */
export async function drawRedactionMarks(doc: PDFDocument, page: PDFPage, marks: { regions: Region[]; fill: string; text?: string }[], fonts: FontCache) {
  const ops: string[] = [];
  const { m } = displayFrame(page);
  const inv = invert(m);
  for (const mark of marks) {
    const [r, g, b] = hexToPdf(mark.fill);
    for (const reg of mark.regions) {
      ops.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${reg.map((p, i) => `${fmt(p.x)} ${fmt(p.y)} ${i ? "l" : "m"}`).join(" ")} h f`);
    }
    if (mark.text && mark.regions.length) {
      // Centered in the largest area, upright as the page is displayed.
      const reg = mark.regions.reduce((best, x) => (Math.abs(signedArea(x)) > Math.abs(signedArea(best)) ? x : best));
      const [x0, y0, x1, y1] = bbox(reg.map((p) => apply(inv, p.x, p.y)));
      const font: PDFFont = await fonts.forText(fontKeyFor("Helvetica", false, false), mark.text);
      const name = addPageResource(page, "Font", "FRdF", font.ref);
      const size = Math.max(4, Math.min(12, (y1 - y0) * 0.7));
      const tw = font.widthOfTextAtSize(mark.text, size);
      const scale = tw > (x1 - x0) * 0.95 ? ((x1 - x0) * 0.95) / tw : 1;
      const light = (r * 299 + g * 587 + b * 114) / 1000 > 0.5;
      const tx = x0 + (x1 - x0 - tw * scale) / 2,
        ty = y0 + (y1 - y0 - size * scale * 0.7) / 2;
      ops.push(`q ${m.map(fmt).join(" ")} cm BT /${name} ${fmt(size * scale)} Tf ${light ? "0 0 0" : "1 1 1"} rg 1 0 0 1 ${fmt(tx)} ${fmt(ty)} Tm ${font.encodeText(mark.text).toString()} Tj ET Q`);
    }
  }
  if (!ops.length) return;
  const ctx = doc.context;
  page.node.normalize();
  const contents = page.node.Contents();
  const ref = ctx.register(ctx.flateStream(`q\n${ops.join("\n")}\nQ`));
  if (contents instanceof PDFArray) contents.push(ref);
  else page.node.set(PDFName.of("Contents"), ctx.obj(contents ? [page.node.get(PDFName.of("Contents"))!, ref] : [ref]));
}


