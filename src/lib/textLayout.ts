import type { PDFDocumentProxy } from "./pdfjs";
import { getPageTextContent } from "./pdfjs";
import type { PdfRect } from "./geometry";

/**
 * Reconstructs reading structure (runs → lines → blocks) from pdf.js text
 * items. Used by Edit Text, exports (Word/Excel/HTML/Markdown), compare and
 * search-based redaction.
 */

export interface TextRun {
  str: string;
  /** Baseline origin in PDF user space. */
  x: number;
  y: number;
  width: number;
  size: number;
  angle: number;
  rect: PdfRect;
  fontName: string;
  family: "serif" | "sans-serif" | "monospace";
  bold: boolean;
  italic: boolean;
  /** Index of the pdf.js text item (for mapping back to the text layer). */
  itemIndex: number;
}

export interface TextLine {
  runs: TextRun[];
  text: string;
  rect: PdfRect;
  baseline: number;
  size: number;
  angle: number;
}

export interface TextBlock {
  lines: TextLine[];
  /** What joins each line to the next in `text`: " ", "\n" or "" (after a hyphen). */
  seps: string[];
  rect: PdfRect;
  size: number;
  family: TextRun["family"];
  bold: boolean;
  italic: boolean;
  /** pdf.js name of the block's main font; once pdf.js has loaded it, also a CSS font family. */
  fontName: string;
  /** Text with soft line breaks joined by spaces, hard breaks kept as "\n". */
  text: string;
}

export interface PageLayout {
  runs: TextRun[];
  lines: TextLine[];
  blocks: TextBlock[];
  view: number[];
}

interface FontInfo {
  name?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  isSerifFont?: boolean;
  isMonospace?: boolean;
}

function fontInfo(page: { commonObjs: { has(id: string): boolean; get(id: string): unknown } }, id: string): FontInfo | null {
  try {
    return page.commonObjs.has(id) ? (page.commonObjs.get(id) as FontInfo) : null;
  } catch {
    return null;
  }
}

const layoutCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageLayout>>>();

export function analyzePage(pdf: PDFDocumentProxy, pageIndex: number): Promise<PageLayout> {
  let m = layoutCache.get(pdf);
  if (!m) {
    m = new Map();
    layoutCache.set(pdf, m);
  }
  let p = m.get(pageIndex);
  if (!p) {
    p = computeLayout(pdf, pageIndex);
    m.set(pageIndex, p);
  }
  return p;
}

async function computeLayout(pdf: PDFDocumentProxy, pageIndex: number): Promise<PageLayout> {
  const page = await pdf.getPage(pageIndex + 1);
  const { items, styles } = await getPageTextContent(pdf, pageIndex);
  // Font details arrive with the page's drawing instructions: get them if the page hasn't been drawn yet.
  if (items.some((it) => it.str.trim() && !page.commonObjs.has(it.fontName))) await page.getOperatorList().catch(() => null);
  const runs: TextRun[] = [];
  items.forEach((it, itemIndex) => {
    if (!it.str || !it.str.trim()) return;
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;
    const angle = Math.atan2(b, a);
    const st = styles[it.fontName] ?? { ascent: 0.8, descent: -0.2, fontFamily: "sans-serif", vertical: false };
    const asc = st.ascent && st.ascent > 0.3 ? st.ascent : 0.8;
    const desc = st.descent && st.descent < 0 ? st.descent : -0.2;
    const cos = Math.cos(angle),
      sin = Math.sin(angle);
    const w = it.width;
    const corners = [
      [e + -sin * desc * size, f + cos * desc * size],
      [e + cos * w + -sin * desc * size, f + sin * w + cos * desc * size],
      [e + -sin * asc * size, f + cos * asc * size],
      [e + cos * w + -sin * asc * size, f + sin * w + cos * asc * size],
    ];
    const xs = corners.map((q) => q[0]);
    const ys = corners.map((q) => q[1]);
    const info = fontInfo(page as never, it.fontName);
    const lname = (info?.name ?? "").toLowerCase();
    const family: TextRun["family"] = info?.isMonospace || /mono|courier|consol/.test(lname)
      ? "monospace"
      : info?.isSerifFont || /times|serif|roman|garamond|georgia|cambria|minion|book/.test(lname) || st.fontFamily === "serif"
        ? "serif"
        : st.fontFamily === "monospace"
          ? "monospace"
          : "sans-serif";
    runs.push({
      str: it.str,
      x: e,
      y: f,
      width: w,
      size,
      angle,
      rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      fontName: it.fontName,
      family,
      bold: !!(info?.bold || info?.black || /bold|black|heavy|semibold|demi/.test(lname)),
      italic: !!(info?.italic || /italic|oblique/.test(lname)),
      itemIndex,
    });
  });
  const lines = buildLines(runs);
  const blocks = buildBlocks(lines);
  return { runs, lines, blocks, view: [...page.view] };
}

function buildLines(runs: TextRun[]): TextLine[] {
  const horizontal = runs.filter((r) => Math.abs(r.angle) < 0.02);
  const others = runs.filter((r) => Math.abs(r.angle) >= 0.02);
  // Bucket by baseline (top to bottom).
  const sorted = [...horizontal].sort((a, b) => b.y - a.y || a.x - b.x);
  const buckets: TextRun[][] = [];
  for (const r of sorted) {
    const last = buckets[buckets.length - 1];
    if (last) {
      const ref = last[0];
      const tol = Math.min(ref.size, r.size) * 0.35;
      if (Math.abs(ref.y - r.y) <= tol) {
        last.push(r);
        continue;
      }
    }
    buckets.push([r]);
  }
  const lines: TextLine[] = [];
  for (const bucket of buckets) {
    bucket.sort((a, b) => a.x - b.x);
    let cur: TextRun[] = [];
    const flush = () => {
      if (cur.length) lines.push(makeLine(cur));
      cur = [];
    };
    for (const r of bucket) {
      const prev = cur[cur.length - 1];
      if (prev) {
        const gap = r.rect[0] - prev.rect[2];
        if (gap > Math.max(2.5 * Math.max(prev.size, r.size), 18)) flush();
      }
      cur.push(r);
    }
    flush();
  }
  for (const r of others) lines.push(makeLine([r]));
  return lines;
}

function makeLine(runs: TextRun[]): TextLine {
  let text = "";
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (i > 0) {
      const prev = runs[i - 1];
      const gap = r.rect[0] - prev.rect[2];
      if (gap > Math.min(prev.size, r.size) * 0.15 && !/\s$/.test(text) && !/^\s/.test(r.str)) text += " ";
    }
    text += r.str;
  }
  const rect: PdfRect = [
    Math.min(...runs.map((r) => r.rect[0])),
    Math.min(...runs.map((r) => r.rect[1])),
    Math.max(...runs.map((r) => r.rect[2])),
    Math.max(...runs.map((r) => r.rect[3])),
  ];
  const size = runs.reduce((s, r) => s + r.size * r.str.length, 0) / Math.max(1, runs.reduce((s, r) => s + r.str.length, 0));
  return { runs, text: text.replace(/\s+/g, " ").trim(), rect, baseline: runs[0].y, size, angle: runs[0].angle };
}

/** A list bullet or dash starting a line. */
const BULLET = /^\s*([•▪◦‣●○■□➢►✓✔–—*-]|\d{1,2}[.)])\s/;

/** The style most of a line's text is in. */
function lineStyle(l: TextLine) {
  const counts = new Map<string, { n: number; run: TextRun }>();
  for (const r of l.runs) {
    const key = `${r.family}|${r.bold}|${r.italic}`;
    const c = counts.get(key) ?? { n: 0, run: r };
    c.n += r.str.length;
    counts.set(key, c);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0].run;
}

/**
 * Groups lines into paragraphs. Lines join a paragraph only when they are in the same style
 * (family, weight, slant, size), closely and evenly spaced, and aligned on the left (a first
 * line may be indented, and lines after a bullet may hang). A bullet, a change of style or
 * extra space before a line starts a new paragraph.
 */
export function buildBlocks(lines: TextLine[]): TextBlock[] {
  const sorted = [...lines].sort((a, b) => b.baseline - a.baseline || a.rect[0] - b.rect[0]);
  const blocks: TextLine[][] = [];
  for (const line of sorted) {
    let target: TextLine[] | null = null;
    const style = lineStyle(line);
    for (let i = blocks.length - 1; i >= Math.max(0, blocks.length - 6); i--) {
      const blk = blocks[i];
      const last = blk[blk.length - 1];
      if (Math.abs(line.angle - last.angle) > 0.02) continue;
      const ls = lineStyle(last);
      const size = Math.max(last.size, line.size);
      const styleOk = ls.family === style.family && ls.bold === style.bold && ls.italic === style.italic && Math.abs(line.size - last.size) <= size * 0.08;
      const spacing = last.baseline - line.baseline;
      let spacingOk = spacing > 0 && spacing <= size * 1.5;
      if (spacingOk && blk.length > 1) {
        const usual = (blk[0].baseline - last.baseline) / (blk.length - 1);
        spacingOk = Math.abs(spacing - usual) <= Math.max(0.6, size * 0.12);
      }
      const dx = line.rect[0] - last.rect[0];
      const indentOk =
        Math.abs(dx) <= size * 0.8 ||
        (blk.length === 1 && dx < 0 && -dx <= size * 3) ||
        (blk.length === 1 && dx > 0 && dx <= size * 3 && BULLET.test(last.text));
      // A clearly short line ends its paragraph (paragraphs end on one; they don't start with one).
      const widest = Math.max(line.rect[2] - line.rect[0], ...blk.map((l) => l.rect[2] - l.rect[0]));
      const ended = last.rect[2] - last.rect[0] < widest * 0.7;
      if (styleOk && spacingOk && indentOk && !ended && !BULLET.test(line.text)) {
        target = blk;
        break;
      }
    }
    if (target) target.push(line);
    else blocks.push([line]);
  }
  return blocks.map((ls) => {
    const rect: PdfRect = [
      Math.min(...ls.map((l) => l.rect[0])),
      Math.min(...ls.map((l) => l.rect[1])),
      Math.max(...ls.map((l) => l.rect[2])),
      Math.max(...ls.map((l) => l.rect[3])),
    ];
    const width = rect[2] - rect[0];
    const seps = ls.slice(0, -1).map((l) => (l.rect[2] - l.rect[0] < width * 0.72 ? "\n" : /-$/.test(l.text) ? "" : " "));
    const text = ls.map((l, i) => l.text + (seps[i] ?? "")).join("");
    const runs = ls.flatMap((l) => l.runs);
    const major = <T,>(f: (r: TextRun) => T) => {
      const counts = new Map<T, number>();
      for (const r of runs) counts.set(f(r), (counts.get(f(r)) ?? 0) + r.str.length);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };
    return {
      lines: ls,
      seps,
      rect,
      size: ls.reduce((s, l) => s + l.size, 0) / ls.length,
      family: major((r) => r.family),
      bold: major((r) => r.bold),
      italic: major((r) => r.italic),
      fontName: major((r) => r.fontName),
      text,
    };
  });
}

/** Reading-order text for a page from its layout (blocks top-to-bottom, left-to-right). */
export function layoutText(layout: PageLayout): string {
  return layout.blocks.map((b) => b.lines.map((l) => l.text).join("\n")).join("\n\n");
}
