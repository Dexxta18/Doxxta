import type { PDFDocumentProxy } from "../lib/pdfjs";
import { pdfjs } from "../lib/pdfjs";
import type { PdfRect } from "../lib/geometry";
import { rgbToHex } from "../lib/colors";
import { cssFamily, fontLibrary, type FontFamily, type FontFile } from "../lib/fontMatch";
import type { TextAlign } from "./editText";
import { createOcrWorker } from "./ocr";

/**
 * Text that's part of a picture (a scan, or a design app's text turned into an image or into
 * outlines) found with OCR in a drawing of the page, with how it looks: the font of the app's
 * library most like it (drawn over it to compare), its weight, slant, size, letter spacing and
 * color, and the background behind it. Edit text edits it like the page's own text.
 */

/** How a line of seen text looks. */
export interface SeenLook {
  /** Family in the app's font library. */
  family: string;
  kind: "serif" | "sans-serif" | "monospace";
  weight: number;
  italic: boolean;
  /** Font size, in points. */
  size: number;
  /** Space after each letter, in points. */
  spacing: number;
  color: string;
}

/** A line of text seen in the drawing of the page. */
export interface SeenLine {
  text: string;
  /** Box of its letters, in PDF user space. */
  rect: PdfRect;
  baseline: number;
  /** Where its first letter starts on the baseline. */
  left: number;
  look: SeenLook;
  confidence: number;
}

/** Lines seen together, like a paragraph. */
export interface SeenBlock {
  lines: SeenLine[];
  rect: PdfRect;
  /** Its lines, joined by line breaks. */
  text: string;
  align: TextAlign;
  /** The color behind the text. */
  background: string;
  /** When what's behind the text isn't one color: a picture of it without the text (PNG), to cover the text with. */
  patch?: { png: Uint8Array; rect: PdfRect };
}

/** The page drawn for reading, and how its pixels map to the page. */
interface Drawing {
  canvas: HTMLCanvasElement;
  /** Pixels per point. */
  scale: number;
  toPdf: (x: number, y: number) => [number, number];
}

/** A line as OCR found it, in pixels of the drawing. */
interface RawLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Baseline. */
  base: number;
  confidence: number;
}

/** The page drawn at about 300 dpi (less for very large pages), as it's shown. */
async function draw(pdf: PDFDocumentProxy, pageIndex: number): Promise<Drawing> {
  const page = await pdf.getPage(pageIndex + 1);
  const one = page.getViewport({ scale: 1 });
  const scale = Math.max(1.5, Math.min(4, 4200 / Math.max(one.width, one.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE, background: "#ffffff" }).promise;
  return { canvas, scale, toPdf: (x, y) => vp.convertToPdfPoint(x, y) as [number, number] };
}

type RGB = [number, number, number];
const dist2 = (p: Uint8ClampedArray, i: number, c: RGB) => (p[i] - c[0]) ** 2 + (p[i + 1] - c[1]) ** 2 + (p[i + 2] - c[2]) ** 2;
const pack = (p: Uint8ClampedArray, i: number) => ((p[i] >> 3) << 10) | ((p[i + 1] >> 3) << 5) | (p[i + 2] >> 3);
const unpack = (k: number): RGB => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4];

/**
 * The drawing with every mark that stands out from what's around it dark on white, whatever its
 * color: OCR reads dark text on light paper, and design text is often light on a color.
 */
function inkOf(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const data = src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  // The most common color of each cell, and of the cells around it: the background there.
  const cell = 16;
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const modes = new Int32Array(cw * ch);
  const counts = new Int32Array(cw * ch);
  const hist = new Map<number, number>();
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      hist.clear();
      for (let y = cy * cell; y < Math.min(h, cy * cell + cell); y += 2) {
        for (let x = cx * cell; x < Math.min(w, cx * cell + cell); x += 2) {
          const k = pack(data, (y * w + x) * 4);
          hist.set(k, (hist.get(k) ?? 0) + 1);
        }
      }
      let best = 0;
      let n = -1;
      for (const [k, c] of hist) if (c > n) [best, n] = [k, c];
      modes[cy * cw + cx] = best;
      counts[cy * cw + cx] = n;
    }
  }
  const reach = 3;
  const bgs: RGB[] = new Array(cw * ch);
  const votes = new Map<number, number>();
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      votes.clear();
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
          const k = modes[y * cw + x];
          votes.set(k, (votes.get(k) ?? 0) + counts[y * cw + x]);
        }
      }
      let best = 0;
      let n = -1;
      for (const [k, c] of votes) if (c > n) [best, n] = [k, c];
      bgs[cy * cw + cx] = unpack(best);
    }
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d")!;
  const img = octx.createImageData(w, h);
  const o = img.data;
  for (let y = 0; y < h; y++) {
    const cy = Math.min(ch - 1, (y / cell) | 0);
    for (let x = 0; x < w; x++) {
      const cx = Math.min(cw - 1, (x / cell) | 0);
      const i = (y * w + x) * 4;
      // Of the backgrounds around, the one nearest the pixel's color (so a block of color isn't ink at its edges).
      let d = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= ch) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx;
          if (xx >= 0 && xx < cw) d = Math.min(d, dist2(data, i, bgs[yy * cw + xx]));
        }
      }
      o[i] = o[i + 1] = o[i + 2] = 255 - Math.min(255, Math.sqrt(d) * 2.2);
      o[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/** Colors very near white or black are white or black: anti-aliasing dims thin strokes. */
const snap = (c: RGB): RGB => (c.every((v) => v > 228) ? [255, 255, 255] : c.every((v) => v < 30) ? [0, 0, 0] : c);

/** Letters that go below the baseline. */
const DESCENDS = /[gjpqyQ,;()[\]{}|/\\_@$]/;

/** The lines of text OCR finds in the drawing (dark-on-light copy `ink`). */
async function readLines(ink: HTMLCanvasElement): Promise<RawLine[]> {
  const worker = await createOcrWorker(["eng"], () => {});
  let data;
  try {
    // Sparse text: design pages have text scattered about, not columns of it.
    await worker.setParameters({ tessedit_pageseg_mode: "11" as never });
    data = (await worker.recognize(ink, {}, { blocks: true })).data;
  } finally {
    await worker.terminate();
  }
  const lines: RawLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const words = line.words.filter((w) => w.text.trim());
        // Lines mostly of guesses are pictures, not text; a doubtful word among good ones stays.
        const good = words.filter((w) => w.confidence >= 60 && /[\p{L}\p{N}]/u.test(w.text));
        if (!good.length || good.length < words.length / 2) continue;
        const symbols = words.flatMap((w) => w.symbols);
        const x0 = Math.min(...symbols.map((s) => s.bbox.x0));
        const y0 = Math.min(...symbols.map((s) => s.bbox.y0));
        const x1 = Math.max(...symbols.map((s) => s.bbox.x1));
        const y1 = Math.max(...symbols.map((s) => s.bbox.y1));
        // Text running up or down the page isn't edited.
        if (y1 - y0 > (x1 - x0) * 1.5 && words.every((w) => w.text.length > 1)) continue;
        const flat = symbols.filter((s) => !DESCENDS.test(s.text));
        const bottoms = (flat.length ? flat : symbols).map((s) => s.bbox.y1).sort((a, b) => a - b);
        lines.push({
          text: words.map((w) => w.text.trim()).join(" "),
          x0,
          y0,
          x1,
          y1,
          base: bottoms[bottoms.length >> 1],
          confidence: words.reduce((s, w) => s + w.confidence, 0) / words.length,
        });
      }
    }
  }
  return lines;
}

/** A line's piece of the drawing: its colors and how much each pixel is its text's color. */
interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
  background: RGB;
  /** The background is one color (not a picture or a gradient). */
  plain: boolean;
  color: RGB;
  /** 0 (background) to 1 (text), per pixel. */
  mask: Float32Array;
}

function cropOf(drawing: Drawing, l: RawLine): Crop {
  const pad = Math.max(3, Math.round((l.base - l.y0) * 0.35));
  const x = Math.max(0, Math.floor(l.x0 - pad));
  const y = Math.max(0, Math.floor(l.y0 - pad));
  const w = Math.min(drawing.canvas.width, Math.ceil(l.x1 + pad)) - x;
  const h = Math.min(drawing.canvas.height, Math.ceil(l.y1 + pad)) - y;
  const px = drawing.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, w, h).data;
  // The background: the commonest color along the edges.
  const edge = new Map<number, number>();
  const count = (i: number) => {
    const k = pack(px, i);
    edge.set(k, (edge.get(k) ?? 0) + 1);
  };
  for (let i = 0; i < w; i++) {
    count(i * 4);
    count(((h - 1) * w + i) * 4);
  }
  for (let j = 0; j < h; j++) {
    count(j * w * 4);
    count((j * w + w - 1) * 4);
  }
  const commonest = [...edge.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const edgeAt = (test: (i: number) => boolean) => {
    const sum = [0, 0, 0];
    let n = 0;
    const add = (i: number) => {
      if (!test(i)) return;
      sum[0] += px[i];
      sum[1] += px[i + 1];
      sum[2] += px[i + 2];
      n++;
    };
    for (let i = 0; i < w; i++) {
      add(i * 4);
      add(((h - 1) * w + i) * 4);
    }
    for (let j = 0; j < h; j++) {
      add(j * w * 4);
      add((j * w + w - 1) * 4);
    }
    return n ? ([sum[0] / n, sum[1] / n, sum[2] / n] as RGB) : unpack(commonest);
  };
  const background = edgeAt((i) => pack(px, i) === commonest);
  let near = 0;
  let edges = 0;
  edgeAt((i) => {
    edges++;
    if (dist2(px, i, background) < 14 * 14) near++;
    return false;
  });
  const plain = near >= edges * 0.9;
  // The text's color: the middle of its strokes, the pixels furthest from the background.
  let far = 0;
  for (let i = 0; i < px.length; i += 4) far = Math.max(far, dist2(px, i, background));
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (dist2(px, i, background) < far * 0.8) continue;
    sum[0] += px[i];
    sum[1] += px[i + 1];
    sum[2] += px[i + 2];
    n++;
  }
  const seen: RGB = n ? [sum[0] / n, sum[1] / n, sum[2] / n] : [0, 0, 0];
  const full = Math.sqrt((seen[0] - background[0]) ** 2 + (seen[1] - background[1]) ** 2 + (seen[2] - background[2]) ** 2) || 1;
  const mask = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = Math.min(1, Math.sqrt(dist2(px, i * 4, background)) / full);
  return { x, y, w, h, background, plain, color: snap(seen), mask };
}

/** How much the text leans (italics lean about 0.2): the shear that makes its strokes most upright. */
function lean(c: Crop, base: number): number {
  let best = 0;
  let bestScore = -1;
  for (const k of [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
    const cols = new Float32Array(c.w + c.h * 2);
    for (let y = 0; y < c.h; y++) {
      const shift = Math.round(k * (base - c.y - y)) + c.h;
      for (let x = 0; x < c.w; x++) {
        const m = c.mask[y * c.w + x];
        if (m > 0.5) cols[x - shift + c.h * 2] += 1;
      }
    }
    let score = 0;
    for (const v of cols) score += v * v;
    if (score > bestScore) [best, bestScore] = [k, score];
  }
  return best;
}

const loaded = new Map<string, Promise<boolean>>();

/** Loads a library face for drawing on a canvas; its CSS font. */
async function faceFont(family: FontFamily, file: FontFile): Promise<string | null> {
  const css = cssFamily(family);
  const font = `${file.italic ? "italic" : "normal"} ${file.weight} 100px ${css}`;
  let ok = loaded.get(font);
  if (!ok) loaded.set(font, (ok = document.fonts.load(font).then((f) => f.length > 0, () => false)));
  return (await ok) ? font : null;
}

/** A face drawn over a line: how well it covers the line's letters, and the size and spacing that fit it. */
interface Fit {
  family: FontFamily;
  file: FontFile;
  score: number;
  /** In drawing pixels. */
  size: number;
  spacing: number;
  /** Where the first letter's origin is on the baseline. */
  origin: number;
}

let scratch: HTMLCanvasElement | null = null;

function tryFace(c: Crop, l: RawLine, family: FontFamily, file: FontFile, font: string, sizing = 1): Fit | null {
  scratch ??= document.createElement("canvas");
  const canvas = scratch;
  if (canvas.width < c.w) canvas.width = c.w;
  if (canvas.height < c.h) canvas.height = c.h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = font;
  const chars = [...l.text];
  const m = ctx.measureText(l.text);
  if (!m.actualBoundingBoxAscent) return null;
  // The size that makes it as tall as the line's letters, and the spacing that makes it as wide.
  const size = ((l.base - l.y0) / m.actualBoundingBoxAscent) * 100 * sizing;
  const k = size / 100;
  const natural = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) * k;
  const spacing = chars.length > 1 ? (l.x1 - l.x0 - natural) / (chars.length - 1) : 0;
  if (spacing < -0.08 * size || spacing > 1.2 * size) return null;
  // Centered on the letters: a size off by a little shifts it less.
  const origin = (l.x0 + l.x1) / 2 - (natural + spacing * (chars.length - 1)) / 2 + m.actualBoundingBoxLeft * k;
  ctx.clearRect(0, 0, c.w, c.h);
  ctx.font = font.replace(" 100px ", ` ${size}px `);
  ctx.fillStyle = "#000";
  let prefix = "";
  chars.forEach((ch, i) => {
    ctx.fillText(ch, origin - c.x + ctx.measureText(prefix).width + i * spacing, l.base - c.y);
    prefix += ch;
  });
  const alpha = ctx.getImageData(0, 0, c.w, c.h).data;
  let both = 0;
  let either = 0;
  for (let i = 0; i < c.w * c.h; i++) {
    const a = alpha[i * 4 + 3] / 255;
    const b = c.mask[i];
    both += Math.min(a, b);
    either += Math.max(a, b);
  }
  return { family, file, score: either ? both / either : 0, size, spacing, origin };
}

/** The face of the library most like a line's letters. */
async function bestFace(c: Crop, l: RawLine, families: FontFamily[]): Promise<Fit | null> {
  // Upright or italic, or when it's not clear, both.
  const k = lean(c, l.base);
  const slants = k >= 0.15 ? [true] : k <= 0.05 ? [false] : [false, true];
  const pick = (f: FontFamily, it: boolean) => {
    const same = f.faces.filter((x) => x.italic === it);
    if (!same.length) return null;
    return same.reduce((a, b) => (Math.abs(b.weight - 400) < Math.abs(a.weight - 400) ? b : a));
  };
  const fits: Fit[] = [];
  const tried = new Set<FontFile>();
  const run = async (family: FontFamily, file: FontFile | null) => {
    if (!file || tried.has(file)) return;
    tried.add(file);
    const font = await faceFont(family, file);
    const fit = font && tryFace(c, l, family, file, font);
    if (fit) fits.push(fit);
  };
  for (const f of families) for (const it of slants) await run(f, pick(f, it) ?? (slants.length === 1 ? pick(f, !it) : null));
  const top = [...fits].sort((a, b) => b.score - a.score).slice(0, 3);
  // Every weight (and slant) of the likeliest families.
  for (const t of top) for (const file of t.family.faces) await run(t.family, file);
  const best = fits.sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  // The size that covers the letters best (OCR's boxes are a pixel or so larger than them).
  const font = (await faceFont(best.family, best.file))!;
  let fit = best;
  for (const sizing of [0.94, 0.96, 0.98, 1.02]) {
    const other = tryFace(c, l, best.family, best.file, font, sizing);
    if (other && other.score > fit.score) fit = other;
  }
  return fit;
}

const KIND: Record<string, SeenLook["kind"]> = { serif: "serif", monospace: "monospace" };

/** Groups lines into blocks: lines alike, close and aligned, one under another. */
function blocksOf(lines: SeenLine[], others: SeenLine[]): Omit<SeenBlock, "background">[] {
  const sorted = [...lines].sort((a, b) => b.baseline - a.baseline || a.rect[0] - b.rect[0]);
  const groups: SeenLine[][] = [];
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  const center = (l: SeenLine) => (l.rect[0] + l.rect[2]) / 2;
  for (const l of sorted) {
    const g = groups.find((g) => {
      const last = g[g.length - 1];
      const a = last.look;
      const b = l.look;
      const size = Math.max(a.size, b.size);
      return (
        a.family === b.family &&
        a.italic === b.italic &&
        a.weight === b.weight &&
        Math.abs(a.size - b.size) <= size * 0.12 &&
        last.baseline - l.baseline > 0 &&
        last.baseline - l.baseline <= size * 1.7 &&
        (near(last.rect[0], l.rect[0], size) || near(center(last), center(l), size) || near(last.rect[2], l.rect[2], size))
      );
    });
    if (g) g.push(l);
    else groups.push([l]);
  }
  return groups.map((g) => {
    const rect: PdfRect = [Math.min(...g.map((l) => l.rect[0])), Math.min(...g.map((l) => l.rect[1])), Math.max(...g.map((l) => l.rect[2])), Math.max(...g.map((l) => l.rect[3]))];
    const tol = Math.max(1.5, g[0].look.size * 0.3);
    let align: TextAlign;
    if (g.length > 1) {
      align = g.every((l) => near(l.rect[0], g[0].rect[0], tol)) ? "left" : g.every((l) => near(center(l), center(g[0]), tol)) ? "center" : g.every((l) => near(l.rect[2], g[0].rect[2], tol)) ? "right" : "left";
    } else {
      // One line: aligned as the text around it is, or else centered, as on a card.
      const l = g[0];
      const rest = others.filter((o) => o !== l);
      align = rest.some((o) => near(center(o), center(l), tol)) ? "center" : rest.some((o) => near(o.rect[0], l.rect[0], tol)) ? "left" : rest.some((o) => near(o.rect[2], l.rect[2], tol)) ? "right" : "center";
    }
    return { lines: g, rect, text: g.map((l) => l.text).join("\n"), align };
  });
}

/**
 * What's behind some lines without their letters, for covering them where the background isn't
 * one color: the letters' pixels are filled in from around them, ring by ring.
 */
async function patchOf(drawing: Drawing, ink: HTMLCanvasElement, lines: RawLine[]): Promise<{ png: Uint8Array; rect: PdfRect } | undefined> {
  const tall = Math.max(...lines.map((l) => l.base - l.y0));
  const pad = Math.ceil(tall * 0.6);
  const x = Math.max(0, Math.floor(Math.min(...lines.map((l) => l.x0)) - pad));
  const y = Math.max(0, Math.floor(Math.min(...lines.map((l) => l.y0)) - pad));
  const w = Math.min(drawing.canvas.width, Math.ceil(Math.max(...lines.map((l) => l.x1)) + pad)) - x;
  const h = Math.min(drawing.canvas.height, Math.ceil(Math.max(...lines.map((l) => l.y1)) + pad)) - y;
  if (w < 2 || h < 2) return undefined;
  const img = drawing.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, w, h);
  const px = img.data;
  const marks = ink.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, w, h).data;
  // The lines' letters (and the pixels around them), to fill in.
  const hole = new Uint8Array(w * h);
  const reach = Math.ceil(tall * 0.2);
  for (const l of lines) {
    for (let j = Math.max(0, Math.floor(l.y0 - reach - y)); j < Math.min(h, Math.ceil(l.y1 + reach - y)); j++) {
      for (let i = Math.max(0, Math.floor(l.x0 - reach - x)); i < Math.min(w, Math.ceil(l.x1 + reach - x)); i++) {
        if (marks[(j * w + i) * 4] < 200) hole[j * w + i] = 1;
      }
    }
  }
  for (let k = 0; k < 2; k++) {
    const grown = hole.slice();
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (hole[j * w + i]) continue;
        if ((i > 0 && hole[j * w + i - 1]) || (i < w - 1 && hole[j * w + i + 1]) || (j > 0 && hole[(j - 1) * w + i]) || (j < h - 1 && hole[(j + 1) * w + i])) grown[j * w + i] = 1;
      }
    }
    hole.set(grown);
  }
  // Ring by ring from the edge of the hole: each pixel, the average of its filled neighbors.
  let left = hole.reduce((n, v) => n + v, 0);
  for (let pass = 0; left && pass < 400; pass++) {
    const fill: [number, number, number, number][] = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (!hole[j * w + i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= w || jj >= h || hole[jj * w + ii]) continue;
            const q = (jj * w + ii) * 4;
            r += px[q];
            g += px[q + 1];
            b += px[q + 2];
            n++;
          }
        }
        if (n) fill.push([j * w + i, r / n, g / n, b / n]);
      }
    }
    if (!fill.length) break;
    for (const [at, r, g, b] of fill) {
      px[at * 4] = r;
      px[at * 4 + 1] = g;
      px[at * 4 + 2] = b;
      px[at * 4 + 3] = 255;
      hole[at] = 0;
    }
    left -= fill.length;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) return undefined;
  const [ax, ay] = drawing.toPdf(x, y + h);
  const [bx, by] = drawing.toPdf(x + w, y);
  return { png: new Uint8Array(await blob.arrayBuffer()), rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] };
}

/** Finds the text in a page's pictures (and outlines), with how it looks. */
export async function recognizeText(pdf: PDFDocumentProxy, pageIndex: number, onProgress?: (p: number) => void): Promise<SeenBlock[]> {
  const drawing = await draw(pdf, pageIndex);
  onProgress?.(0.1);
  const ink = inkOf(drawing.canvas);
  const raw = await readLines(ink);
  onProgress?.(0.6);
  const families = [...(await fontLibrary()).values()];
  const lines: SeenLine[] = [];
  const crops = new Map<SeenLine, { crop: Crop; raw: RawLine }>();
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    const crop = cropOf(drawing, l);
    const fit = await bestFace(crop, l, families);
    onProgress?.(0.6 + (0.4 * (i + 1)) / raw.length);
    if (!fit) continue;
    const s = drawing.scale;
    const [x0, y0] = drawing.toPdf(l.x0, l.y1);
    const [x1, y1] = drawing.toPdf(l.x1, l.y0);
    const line: SeenLine = {
      text: l.text,
      rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
      baseline: drawing.toPdf(fit.origin, l.base)[1],
      left: drawing.toPdf(fit.origin, l.base)[0],
      look: {
        family: fit.family.family,
        kind: KIND[fit.family.category] ?? "sans-serif",
        weight: fit.file.weight,
        italic: fit.file.italic,
        size: Math.round((fit.size / s) * 10) / 10,
        spacing: Math.round((fit.spacing / s) * 100) / 100,
        color: rgbToHex(...(crop.color.map((v) => Math.round(v)) as RGB)),
      },
      confidence: l.confidence,
    };
    lines.push(line);
    crops.set(line, { crop, raw: l });
  }
  const blocks: SeenBlock[] = [];
  for (const b of blocksOf(lines, lines)) {
    const seen = b.lines.map((l) => crops.get(l)!);
    const bg = seen[0].crop.background;
    // Text on a picture or a gradient is covered with what's behind it, not with one color.
    const patch = seen.every((c) => c.crop.plain) ? undefined : await patchOf(drawing, ink, seen.map((c) => c.raw)).catch(() => undefined);
    blocks.push({ ...b, background: rgbToHex(...(bg.map((v) => Math.round(v)) as RGB)), patch });
  }
  drawing.canvas.width = drawing.canvas.height = 0;
  ink.width = ink.height = 0;
  return blocks;
}
