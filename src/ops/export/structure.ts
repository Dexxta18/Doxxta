import { analyzePage, buildBlocks, type TextBlock, type TextLine, type TextRun } from "../../lib/textLayout";
import { pdfjs, type PDFDocumentProxy, type PDFPageProxy } from "../../lib/pdfjs";
import { apply, multiply, type Matrix, type PdfRect } from "../../lib/geometry";
import { canvasToBlob } from "../../lib/util";

/**
 * Reading-order structure of a page (headings, paragraphs, lists, tables,
 * images) shared by the Word, Excel, PowerPoint, HTML and Markdown exports.
 */

export interface StyledText {
  /** May contain "\n" (line break) and "\t" (tab, see TabStop). */
  text: string;
  bold: boolean;
  italic: boolean;
  /** Points. */
  size: number;
  font: string;
  family: TextRun["family"];
  /** Text color (#rrggbb), when known. */
  color?: string;
}

interface Placed {
  /** PDF user space. */
  rect: PdfRect;
}

export type Align = "left" | "center" | "right" | "justify";

/** Where a text element's lines are (PDF user space), to space and indent it as on the page. */
export interface TextGeometry {
  /** Baselines of the first and last lines, and the distance between lines (0 for one line). */
  first: number;
  last: number;
  pitch: number;
  /** Left edge of the first line, and of the lines after it. */
  firstLeft: number;
  left: number;
  /** Font sizes of the first and last lines. */
  size: number;
  lastSize: number;
}

/** A tab stop, where text after a tab starts (left) or ends (right). */
export interface TabStop {
  x: number;
  align: "left" | "right";
}

export type Element =
  | (Placed & { kind: "heading"; level: 1 | 2 | 3; spans: StyledText[]; align: Align; geo: TextGeometry })
  | (Placed & { kind: "paragraph"; spans: StyledText[]; align: Align; geo: TextGeometry; tabs?: TabStop[] })
  | (Placed & {
      kind: "list";
      ordered: boolean;
      items: StyledText[][];
      geos: TextGeometry[];
      /** The bullet, or the numbering format ("1." or "1)") and the first number; where it is. */
      marker: { text: string; start: number; x: number };
    })
  | (Placed & {
      kind: "table";
      rows: string[][];
      /** Whether each cell's text is bold; where the columns start; distance between rows; the table's font. */
      bold: boolean[][];
      columns: number[];
      rowPitch: number;
      font?: Omit<StyledText, "text" | "bold">;
      /** Whether the page draws lines around or between its cells. */
      ruled?: boolean;
    })
  | (Placed & { kind: "image"; png: Uint8Array; pxWidth: number; pxHeight: number });

/** The color a text run is drawn in, when known. */
export type RunColor = (run: TextRun) => string | undefined;

export interface PageStructure {
  index: number;
  /** Page box (PDF user space) and size in points. */
  view: number[];
  width: number;
  height: number;
  elements: Element[];
  /** Plain reading-order text. */
  text: string;
  /** Lines of text with their positions, for layout-preserving text and spreadsheets. */
  lines: TextLine[];
}

// ---------- fonts ----------

/** Open fonts made to stand in for common Windows and Mac fonts, and their names there. */
const STAND_INS: Record<string, string> = {
  "liberation sans": "Arial",
  arimo: "Arial",
  helvetica: "Arial",
  "liberation serif": "Times New Roman",
  tinos: "Times New Roman",
  times: "Times New Roman",
  "times roman": "Times New Roman",
  "liberation mono": "Courier New",
  cousine: "Courier New",
  courier: "Courier New",
  carlito: "Calibri",
  caladea: "Cambria",
};

function fontNameOf(page: PDFPageProxy, run: TextRun): string {
  try {
    const objs = (page as unknown as { commonObjs: { has(id: string): boolean; get(id: string): { name?: string } } }).commonObjs;
    const raw = objs.has(run.fontName) ? objs.get(run.fontName)?.name : undefined;
    if (raw) {
      const clean = raw.replace(/^[A-Z]{6}\+/, "").split(/[,-]/)[0].replace(/(MT|PS|PSMT|Std|LT)$/, "");
      if (clean && !/^(g_|f\d|F\d|T\d)/.test(clean)) {
        const name = clean.replace(/([a-z])([A-Z])/g, "$1 $2");
        return STAND_INS[name.toLowerCase()] ?? name;
      }
    }
  } catch {
    /* fall through */
  }
  return run.family === "serif" ? "Times New Roman" : run.family === "monospace" ? "Courier New" : "Arial";
}

// ---------- tables ----------

interface Row {
  baseline: number;
  segments: TextLine[];
}

function rowsOf(lines: TextLine[]): Row[] {
  const sorted = lines.filter((l) => Math.abs(l.angle) < 0.02).sort((a, b) => b.baseline - a.baseline);
  const rows: Row[] = [];
  for (const l of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.baseline - l.baseline) <= Math.min(l.size, last.segments[0].size) * 0.4) last.segments.push(l);
    else rows.push({ baseline: l.baseline, segments: [l] });
  }
  for (const r of rows) r.segments.sort((a, b) => a.rect[0] - b.rect[0]);
  return rows;
}

/** Finds simple grid tables: consecutive rows split into aligned columns. */
function detectTables(page: PDFPageProxy, lines: TextLine[], color?: RunColor): { table: Element & { kind: "table" }; used: Set<TextLine> }[] {
  const rows = rowsOf(lines);
  const out: { table: Element & { kind: "table" }; used: Set<TextLine> }[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].segments.length < 2) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < rows.length && rows[j].segments.length >= 2 && rows[j - 1].baseline - rows[j].baseline <= rows[j].segments[0].size * 3) j++;
    const group = rows.slice(i, j);
    // Column starts: clusters of segment left edges.
    const lefts = group.flatMap((r) => r.segments.map((s) => s.rect[0])).sort((a, b) => a - b);
    const cols: number[] = [];
    for (const x of lefts) if (!cols.length || x - cols[cols.length - 1] > 10) cols.push(x);
    const colOf = (x: number) => {
      let c = 0;
      for (let k = 0; k < cols.length; k++) if (cols[k] <= x + 10) c = k;
      return c;
    };
    const bold = group.map(() => new Array<boolean>(cols.length).fill(false));
    const cells = group.map((r, ri) => {
      const row = new Array<string>(cols.length).fill("");
      for (const s of r.segments) {
        const c = colOf(s.rect[0]);
        row[c] = row[c] ? `${row[c]} ${s.text}` : s.text;
        bold[ri][c] ||= s.runs.every((run) => run.bold);
      }
      return row;
    });
    const aligned = cells.filter((r) => r.filter(Boolean).length >= 2).length;
    if (group.length >= 2 && cols.length >= 2 && cols.length <= 20 && aligned >= Math.max(2, group.length * 0.6) && (group.length >= 3 || cols.length >= 3)) {
      const used = new Set(group.flatMap((r) => r.segments));
      const segs = [...used];
      const rect: PdfRect = [Math.min(...segs.map((s) => s.rect[0])), Math.min(...segs.map((s) => s.rect[1])), Math.max(...segs.map((s) => s.rect[2])), Math.max(...segs.map((s) => s.rect[3]))];
      // Drop columns that ended up empty.
      const keep = cols.map((_, c) => cells.some((r) => r[c]));
      const run = segs.flatMap((s) => s.runs).find((r) => !r.bold) ?? segs[0].runs[0];
      out.push({
        table: {
          kind: "table",
          rows: cells.map((r) => r.filter((_, c) => keep[c])),
          bold: bold.map((r) => r.filter((_, c) => keep[c])),
          columns: cols.filter((_, c) => keep[c]),
          rowPitch: group.length > 1 ? (group[0].baseline - group[group.length - 1].baseline) / (group.length - 1) : run.size * 1.2,
          font: { italic: run.italic, size: Math.round(run.size * 2) / 2, font: fontNameOf(page, run), family: run.family, color: color?.(run) },
          rect,
        },
        used,
      });
      i = j;
    } else i++;
  }
  return out;
}

// ---------- blocks → elements ----------

// Bullets, including the Symbol and Wingdings ones Word uses (private-use characters).
const BULLET = /^\s*([•●○◦▪■□➢►▶✓✔\-–—*\uf000-\uf0ff])\s+/;
const NUMBERED = /^\s*(\(?(\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,5})[.)])\s+/;

function spansOf(page: PDFPageProxy, lines: TextLine[], blockWidth: number, color?: RunColor): StyledText[] {
  const spans: StyledText[] = [];
  const add = (s: StyledText) => {
    const last = spans[spans.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic && Math.abs(last.size - s.size) < 0.6 && last.font === s.font && last.color === s.color) last.text += s.text;
    else spans.push({ ...s });
  };
  lines.forEach((l, li) => {
    l.runs.forEach((r, ri) => {
      let text = r.str;
      if (ri > 0) {
        const prev = l.runs[ri - 1];
        if (r.rect[0] - prev.rect[2] > Math.min(prev.size, r.size) * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(text)) text = " " + text;
      }
      add({ text, bold: r.bold, italic: r.italic, size: Math.round(r.size * 2) / 2, font: fontNameOf(page, r), family: r.family, color: color?.(r) });
    });
    if (li < lines.length - 1) {
      const short = l.rect[2] - l.rect[0] < blockWidth * 0.72;
      const last = spans[spans.length - 1];
      if (short) last.text += "\n";
      else if (/-$/.test(last.text)) last.text = last.text.slice(0, -1);
      else if (!/\s$/.test(last.text)) last.text += " ";
    }
  });
  for (const s of spans) s.text = s.text.replace(/[ \t]+/g, " ");
  return spans;
}

/** The left and right edges of a page's text. */
interface Bounds {
  left: number;
  right: number;
}

function alignmentOf(block: TextBlock, bounds: Bounds): Align {
  const ls = block.lines;
  const tol = 3;
  const mid = (bounds.left + bounds.right) / 2;
  if (ls.length >= 2) {
    const body = ls.slice(0, -1);
    const lefts = ls.map((l) => l.rect[0]);
    const rights = body.map((l) => l.rect[2]);
    const centers = ls.map((l) => (l.rect[0] + l.rect[2]) / 2);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const leftAligned = spread(lefts) < tol;
    const rightAligned = rights.length > 0 && spread(rights) < tol;
    const lastShort = ls[ls.length - 1].rect[2] < Math.max(...rights) - tol;
    if (leftAligned && rightAligned && lastShort && (ls.length >= 3 || Math.abs(rights[0] - bounds.right) < 1.5)) return "justify";
    if (!leftAligned && spread(centers) < tol) return "center";
    if (!leftAligned && spread(ls.map((l) => l.rect[2])) < tol) return "right";
    return "left";
  }
  const l = ls[0];
  const width = l.rect[2] - l.rect[0];
  if (Math.abs((l.rect[0] + l.rect[2]) / 2 - mid) < 8 && width < (bounds.right - bounds.left) * 0.7 && l.rect[0] > bounds.left + 20) return "center";
  if (Math.abs(l.rect[2] - bounds.right) < tol && l.rect[0] > mid) return "right";
  return "left";
}

function geometryOf(lines: TextLine[], firstLeft = lines[0].rect[0]): TextGeometry {
  const n = lines.length;
  return {
    first: lines[0].baseline,
    last: lines[n - 1].baseline,
    pitch: n > 1 ? (lines[0].baseline - lines[n - 1].baseline) / (n - 1) : 0,
    firstLeft,
    left: n > 1 ? Math.min(...lines.slice(1).map((l) => l.rect[0])) : firstLeft,
    size: lines[0].size,
    lastSize: lines[n - 1].size,
  };
}

/** Removes the first `count` characters from spans. */
function dropStart(spans: StyledText[], count: number): StyledText[] {
  const out = spans.map((s) => ({ ...s }));
  while (count > 0 && out.length) {
    const take = Math.min(count, out[0].text.length);
    out[0].text = out[0].text.slice(take);
    count -= take;
    if (!out[0].text) out.shift();
  }
  if (out[0]) out[0].text = out[0].text.replace(/^\s+/, "");
  return out.filter((s) => s.text);
}

/** Where the text after a list marker starts on a line. */
function textStart(line: TextLine, marker: string): number {
  const [first, second] = line.runs;
  if (second && first.str.trim() === marker.trim()) return second.rect[0];
  // Marker and text in one run: estimate from the share of its characters.
  const lead = first.str.match(/^\s*\S+\s*/)?.[0].length ?? 0;
  return first.rect[0] + ((first.rect[2] - first.rect[0]) * lead) / Math.max(1, first.str.length);
}

function blockElements(page: PDFPageProxy, block: TextBlock, bodySize: number, bounds: Bounds, color?: RunColor): Element[] {
  const width = block.rect[2] - block.rect[0];
  const first = block.lines[0]?.text ?? "";
  const bullet = BULLET.exec(first) || NUMBERED.exec(first);
  if (bullet && block.lines.length >= 1) {
    const ordered = !BULLET.test(first);
    const re = ordered ? NUMBERED : BULLET;
    const items: TextLine[][] = [];
    for (const l of block.lines) {
      if (BULLET.test(l.text) || NUMBERED.test(l.text) || !items.length) items.push([l]);
      else items[items.length - 1].push(l);
    }
    if (items.length >= 2 || block.lines.length === 1) {
      const mark = bullet[1];
      return [
        {
          kind: "list",
          ordered,
          items: items.map((ls) => {
            const spans = spansOf(page, ls, width, color);
            const m = re.exec(spans.map((s) => s.text).join(""));
            return m ? dropStart(spans, m[0].length) : spans;
          }),
          geos: items.map((ls) => geometryOf(ls, textStart(ls[0], re.exec(ls[0].text)?.[1] ?? mark))),
          marker: ordered
            ? { text: /\)$/.test(mark) ? "%1)" : "%1.", start: Number.parseInt(mark.replace(/\D/g, ""), 10) || 1, x: block.lines[0].rect[0] }
            : { text: /[\uf000-\uf0ff]/.test(mark) ? "•" : mark, start: 1, x: block.lines[0].rect[0] },
          rect: block.rect,
        },
      ];
    }
  }
  const spans = spansOf(page, block.lines, width, color);
  const ratio = block.size / (bodySize || block.size);
  const align = alignmentOf(block, bounds);
  const geo = geometryOf(block.lines);
  if (block.lines.length <= 3 && ratio >= 1.25 && block.text.length < 200) {
    return [{ kind: "heading", level: ratio >= 1.8 ? 1 : ratio >= 1.45 ? 2 : 3, spans, align, geo, rect: block.rect }];
  }
  return [{ kind: "paragraph", spans, align, geo, rect: block.rect }];
}

/**
 * Lines that share a baseline across a wide gap, like a job title with its dates at the right
 * margin, become one paragraph with tab stops. Not when the gap is the gutter between two
 * columns: a line close by must run across it.
 */
function tabbedRows(blocks: TextBlock[], lines: TextLine[]): { rows: TextBlock[][]; rest: TextBlock[] } {
  const single = blocks.filter((b) => b.lines.length === 1 && Math.abs(b.lines[0].angle) < 0.02);
  const sorted = [...single].sort((a, b) => b.lines[0].baseline - a.lines[0].baseline || a.rect[0] - b.rect[0]);
  const groups: TextBlock[][] = [];
  for (const b of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].lines[0].baseline - b.lines[0].baseline) <= Math.min(g[0].size, b.size) * 0.4) g.push(b);
    else groups.push([b]);
  }
  const rows: TextBlock[][] = [];
  const merged = new Set<TextBlock>();
  for (const g of groups) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.rect[0] - b.rect[0]);
    const y = g[0].lines[0].baseline;
    const size = Math.max(...g.map((b) => b.size));
    const own = new Set(g.map((b) => b.lines[0]));
    const near = lines.filter((l) => !own.has(l) && Math.abs(l.baseline - y) <= size * 4 && Math.abs(l.angle) < 0.02);
    const crossed = g.slice(1).every((b, i) => {
      const [gl, gr] = [g[i].rect[2], b.rect[0]];
      return near.some((l) => Math.min(l.rect[2], gr) - Math.max(l.rect[0], gl) >= (gr - gl) * 0.5);
    });
    if (!crossed) continue;
    rows.push(g);
    for (const b of g) merged.add(b);
  }
  return { rows, rest: blocks.filter((b) => !merged.has(b)) };
}

function rowElement(page: PDFPageProxy, row: TextBlock[], bounds: Bounds, color?: RunColor): Element {
  const spans: StyledText[] = [];
  const tabs: TabStop[] = [];
  row.forEach((b, i) => {
    const own = spansOf(page, b.lines, b.rect[2] - b.rect[0], color);
    if (i > 0) {
      spans.push({ ...own[0], text: "\t" });
      tabs.push(Math.abs(b.rect[2] - bounds.right) < 3 ? { x: b.rect[2], align: "right" } : { x: b.rect[0], align: "left" });
    }
    spans.push(...own);
  });
  const rect: PdfRect = [Math.min(...row.map((b) => b.rect[0])), Math.min(...row.map((b) => b.rect[1])), Math.max(...row.map((b) => b.rect[2])), Math.max(...row.map((b) => b.rect[3]))];
  return { kind: "paragraph", spans, align: "left", geo: geometryOf(row[0].lines), tabs, rect };
}

// ---------- images ----------

async function imageToPng(img: { width: number; height: number; kind?: number; data?: Uint8ClampedArray | Uint8Array; bitmap?: ImageBitmap }): Promise<Uint8Array | null> {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const out = ctx.createImageData(img.width, img.height);
    const d = img.data;
    const n = img.width * img.height;
    if (img.kind === 3) out.data.set(d.subarray(0, n * 4));
    else if (img.kind === 2) for (let i = 0; i < n; i++) (out.data[i * 4] = d[i * 3]), (out.data[i * 4 + 1] = d[i * 3 + 1]), (out.data[i * 4 + 2] = d[i * 3 + 2]), (out.data[i * 4 + 3] = 255);
    else if (img.kind === 1) {
      const rowBytes = (img.width + 7) >> 3;
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const v = (d[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          const i = (y * img.width + x) * 4;
          out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
          out.data[i + 3] = 255;
        }
    } else return null;
    ctx.putImageData(out, 0, 0);
  } else return null;
  return new Uint8Array(await (await canvasToBlob(canvas, "image/png")).arrayBuffer());
}

function getObj(page: PDFPageProxy, id: string): Promise<unknown> {
  const store = id.startsWith("g_") ? (page as unknown as { commonObjs: { get(id: string, cb: (v: unknown) => void): void } }).commonObjs : (page as unknown as { objs: { get(id: string, cb: (v: unknown) => void): void } }).objs;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 4000);
    store.get(id, (v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

/** The images of a page, and the straight lines it draws (as thin boxes), such as table rules. */
async function pageGraphics(page: PDFPageProxy, withImages: boolean): Promise<{ images: (Element & { kind: "image" })[]; rules: PdfRect[] }> {
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const out: (Element & { kind: "image" })[] = [];
  const rules: PdfRect[] = [];
  const box = (m: Matrix, x0: number, y0: number, x1: number, y1: number): PdfRect => {
    const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
    return [Math.min(...pts.map((q) => q.x)), Math.min(...pts.map((q) => q.y)), Math.max(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.y))];
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args[0]) && args[0].length === 6) ctm = multiply(ctm, args[0] as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const [paint, , minMax] = args as [number, unknown, ArrayLike<number> | null];
      if (!minMax || paint === OPS.endPath) continue;
      const r = box(ctm, minMax[0], minMax[1], minMax[2], minMax[3]);
      const [w, h] = [r[2] - r[0], r[3] - r[1]];
      if ((h <= 2.5 && w >= 8) || (w <= 2.5 && h >= 8)) rules.push(r);
      else if ((paint === OPS.stroke || paint === OPS.closeStroke) && w >= 8 && h >= 8) {
        // An outlined box: its sides.
        rules.push([r[0], r[1], r[2], r[1]], [r[0], r[3], r[2], r[3]], [r[0], r[1], r[0], r[3]], [r[2], r[1], r[2], r[3]]);
      }
    } else if (withImages && (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject)) {
      const corners = [
        [ctm[4], ctm[5]],
        [ctm[0] + ctm[4], ctm[1] + ctm[5]],
        [ctm[2] + ctm[4], ctm[3] + ctm[5]],
        [ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5]],
      ];
      const xs = corners.map((c) => c[0]),
        ys = corners.map((c) => c[1]);
      const rect: PdfRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (rect[2] - rect[0] < 12 || rect[3] - rect[1] < 12) continue;
      const img = (fn === OPS.paintImageXObject ? await getObj(page, args[0] as string) : args[0]) as Parameters<typeof imageToPng>[0] | null;
      if (!img?.width || !img.height) continue;
      const png = await imageToPng(img).catch(() => null);
      if (png) out.push({ kind: "image", png, pxWidth: img.width, pxHeight: img.height, rect });
    }
  }
  return { images: out, rules };
}

/** Whether lines run along a table's rows: at least two that span most of its width. */
function isRuled(table: Element & { kind: "table" }, rules: PdfRect[]): boolean {
  const [x0, y0, x1, y1] = table.rect;
  const pad = table.rowPitch;
  const across = rules.filter((r) => r[3] - r[1] <= 2.5 && r[1] >= y0 - pad && r[3] <= y1 + pad && Math.min(r[2], x1) - Math.max(r[0], x0) >= (x1 - x0) * 0.6);
  return across.length >= 2;
}

// ---------- reading order ----------

function xyCut<T extends { rect: PdfRect }>(items: T[], depth = 0): T[] {
  if (items.length <= 1 || depth > 40) return items;
  const gaps = (lo: (t: T) => number, hi: (t: T) => number, desc: boolean) => {
    const sorted = [...items].sort((a, b) => (desc ? hi(b) - hi(a) : lo(a) - lo(b)));
    const groups: T[][] = [];
    let edge = desc ? Infinity : -Infinity;
    let best = 0;
    for (const t of sorted) {
      const start = desc ? hi(t) : lo(t);
      const gap = desc ? edge - start : start - edge;
      if (!groups.length || gap > 2) {
        if (groups.length) best = Math.max(best, gap);
        groups.push([t]);
        edge = desc ? lo(t) : hi(t);
      } else {
        groups[groups.length - 1].push(t);
        edge = desc ? Math.min(edge, lo(t)) : Math.max(edge, hi(t));
      }
    }
    return { groups, best };
  };
  const rows = gaps((t) => t.rect[1], (t) => t.rect[3], true);
  const cols = gaps((t) => t.rect[0], (t) => t.rect[2], false);
  const useCols = cols.groups.length > 1 && (rows.groups.length === 1 || cols.best > rows.best * 1.2);
  const split = useCols ? cols.groups : rows.groups;
  if (split.length === 1) return [...items].sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
  return split.flatMap((g) => xyCut(g, depth + 1));
}

/** Analyzes one page. `color` tells the colors of its text, when known. */
export async function pageStructure(pdf: PDFDocumentProxy, index: number, opts: { images: boolean; color?: RunColor }): Promise<PageStructure> {
  const page = await pdf.getPage(index + 1);
  const { images, rules } = await pageGraphics(page, opts.images).catch(() => ({ images: [], rules: [] }));
  const layout = await analyzePage(pdf, index);
  const view = layout.view;
  const tables = detectTables(page, layout.lines, opts.color);
  for (const t of tables) t.table.ruled = isRuled(t.table, rules);
  const used = new Set(tables.flatMap((t) => [...t.used]));
  const free = layout.lines.filter((l) => !used.has(l));
  const { rows, rest } = tabbedRows(buildBlocks(free), free);
  const sizes = layout.runs.flatMap((r) => Array(Math.min(50, r.str.length)).fill(r.size) as number[]).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 11;
  const flat = layout.lines.filter((l) => Math.abs(l.angle) < 0.02);
  const bounds: Bounds = flat.length ? { left: Math.min(...flat.map((l) => l.rect[0])), right: Math.max(...flat.map((l) => l.rect[2])) } : { left: view[0], right: view[2] };
  const elements: Element[] = xyCut([
    ...rest.flatMap((b) => blockElements(page, b, bodySize, bounds, opts.color)),
    ...rows.map((r) => rowElement(page, r, bounds, opts.color)),
    ...tables.map((t) => t.table),
    ...images,
  ]);
  const text = elements
    .map((e) =>
      e.kind === "table"
        ? e.rows.map((r) => r.join("\t")).join("\n")
        : e.kind === "list"
          ? e.items.map((it, i) => `${e.ordered ? `${e.marker.start + i}.` : "•"} ${it.map((s) => s.text).join("")}`).join("\n")
          : e.kind === "image"
            ? ""
            : e.spans.map((s) => s.text).join(""),
    )
    .filter(Boolean)
    .join("\n\n");
  return { index, view, width: view[2] - view[0], height: view[3] - view[1], elements, text, lines: layout.lines };
}
