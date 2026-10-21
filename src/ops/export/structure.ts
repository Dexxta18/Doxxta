import { analyzePage, buildBlocks, type TextBlock, type TextLine, type TextRun } from "../../lib/textLayout";
import { pdfjs, type PDFDocumentProxy, type PDFPageProxy } from "../../lib/pdfjs";
import { multiply, type Matrix, type PdfRect } from "../../lib/geometry";
import { canvasToBlob } from "../../lib/util";

/**
 * Reading-order structure of a page (headings, paragraphs, lists, tables,
 * images) shared by the Word, Excel, PowerPoint, HTML and Markdown exports.
 */

export interface StyledText {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Points. */
  size: number;
  font: string;
  family: TextRun["family"];
}

interface Placed {
  /** PDF user space. */
  rect: PdfRect;
}

export type Element =
  | (Placed & { kind: "heading"; level: 1 | 2 | 3; spans: StyledText[] })
  | (Placed & { kind: "paragraph"; spans: StyledText[]; align: "left" | "center" | "right" | "justify" })
  | (Placed & { kind: "list"; ordered: boolean; items: StyledText[][] })
  | (Placed & { kind: "table"; rows: string[][] })
  | (Placed & { kind: "image"; png: Uint8Array; pxWidth: number; pxHeight: number });

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

function fontNameOf(page: PDFPageProxy, run: TextRun): string {
  try {
    const objs = (page as unknown as { commonObjs: { has(id: string): boolean; get(id: string): { name?: string } } }).commonObjs;
    const raw = objs.has(run.fontName) ? objs.get(run.fontName)?.name : undefined;
    if (raw) {
      const clean = raw.replace(/^[A-Z]{6}\+/, "").split(/[,-]/)[0].replace(/(MT|PS|PSMT|Std|LT)$/, "");
      if (clean && !/^(g_|f\d|F\d|T\d)/.test(clean)) return clean.replace(/([a-z])([A-Z])/g, "$1 $2");
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
function detectTables(lines: TextLine[]): { table: Element & { kind: "table" }; used: Set<TextLine> }[] {
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
    const cells = group.map((r) => {
      const row = new Array<string>(cols.length).fill("");
      for (const s of r.segments) {
        const c = colOf(s.rect[0]);
        row[c] = row[c] ? `${row[c]} ${s.text}` : s.text;
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
      out.push({ table: { kind: "table", rows: cells.map((r) => r.filter((_, c) => keep[c])), rect }, used });
      i = j;
    } else i++;
  }
  return out;
}

// ---------- blocks → elements ----------

const BULLET = /^\s*([•●○◦▪■□➢►▶✓✔\-–—*])\s+/;
const NUMBERED = /^\s*(\(?(\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,5})[.)])\s+/;

function spansOf(page: PDFPageProxy, lines: TextLine[], blockWidth: number): StyledText[] {
  const spans: StyledText[] = [];
  const add = (s: StyledText) => {
    const last = spans[spans.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic && Math.abs(last.size - s.size) < 0.6 && last.font === s.font) last.text += s.text;
    else spans.push({ ...s });
  };
  lines.forEach((l, li) => {
    l.runs.forEach((r, ri) => {
      let text = r.str;
      if (ri > 0) {
        const prev = l.runs[ri - 1];
        if (r.rect[0] - prev.rect[2] > Math.min(prev.size, r.size) * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(text)) text = " " + text;
      }
      add({ text, bold: r.bold, italic: r.italic, size: Math.round(r.size * 2) / 2, font: fontNameOf(page, r), family: r.family });
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

function alignmentOf(block: TextBlock, view: number[]): "left" | "center" | "right" | "justify" {
  const ls = block.lines;
  const tol = 3;
  if (ls.length >= 2) {
    const body = ls.slice(0, -1);
    const lefts = ls.map((l) => l.rect[0]);
    const rights = body.map((l) => l.rect[2]);
    const centers = ls.map((l) => (l.rect[0] + l.rect[2]) / 2);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const leftAligned = spread(lefts) < tol;
    const rightAligned = rights.length > 0 && spread(rights) < tol;
    if (leftAligned && rightAligned && ls.length >= 3) return "justify";
    if (!leftAligned && spread(centers) < tol) return "center";
    if (!leftAligned && spread(ls.map((l) => l.rect[2])) < tol) return "right";
    return "left";
  }
  const l = ls[0];
  const pageCenter = (view[0] + view[2]) / 2;
  const width = l.rect[2] - l.rect[0];
  if (Math.abs((l.rect[0] + l.rect[2]) / 2 - pageCenter) < 8 && width < (view[2] - view[0]) * 0.7) return "center";
  return "left";
}

function blockElements(page: PDFPageProxy, block: TextBlock, bodySize: number, view: number[]): Element[] {
  const width = block.rect[2] - block.rect[0];
  const first = block.lines[0]?.text ?? "";
  const bullet = BULLET.exec(first) || NUMBERED.exec(first);
  if (bullet && block.lines.length >= 1) {
    const ordered = !BULLET.test(first);
    const items: TextLine[][] = [];
    for (const l of block.lines) {
      if (BULLET.test(l.text) || NUMBERED.test(l.text) || !items.length) items.push([l]);
      else items[items.length - 1].push(l);
    }
    if (items.length >= 2 || block.lines.length === 1) {
      return [
        {
          kind: "list",
          ordered,
          items: items.map((ls) => {
            const spans = spansOf(page, ls, width);
            if (spans[0]) spans[0].text = spans[0].text.replace(ordered ? NUMBERED : BULLET, "");
            return spans.filter((s) => s.text);
          }),
          rect: block.rect,
        },
      ];
    }
  }
  const spans = spansOf(page, block.lines, width);
  const ratio = block.size / (bodySize || block.size);
  if (block.lines.length <= 3 && ratio >= 1.25 && block.text.length < 200) {
    return [{ kind: "heading", level: ratio >= 1.8 ? 1 : ratio >= 1.45 ? 2 : 3, spans, rect: block.rect }];
  }
  return [{ kind: "paragraph", spans, align: alignmentOf(block, view), rect: block.rect }];
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

async function pageImages(page: PDFPageProxy): Promise<(Element & { kind: "image" })[]> {
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const out: (Element & { kind: "image" })[] = [];
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
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
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
  return out;
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

/** Analyzes one page. */
export async function pageStructure(pdf: PDFDocumentProxy, index: number, opts: { images: boolean }): Promise<PageStructure> {
  const page = await pdf.getPage(index + 1);
  const images = opts.images ? await pageImages(page).catch(() => []) : [];
  const layout = await analyzePage(pdf, index);
  const view = layout.view;
  const tables = detectTables(layout.lines);
  const used = new Set(tables.flatMap((t) => [...t.used]));
  const blocks = buildBlocks(layout.lines.filter((l) => !used.has(l)));
  const sizes = layout.runs.flatMap((r) => Array(Math.min(50, r.str.length)).fill(r.size) as number[]).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 11;
  const elements: Element[] = xyCut([...blocks.flatMap((b) => blockElements(page, b, bodySize, view)), ...tables.map((t) => t.table), ...images]);
  const text = elements
    .map((e) =>
      e.kind === "table"
        ? e.rows.map((r) => r.join("\t")).join("\n")
        : e.kind === "list"
          ? e.items.map((it, i) => `${e.ordered ? `${i + 1}.` : "•"} ${it.map((s) => s.text).join("")}`).join("\n")
          : e.kind === "image"
            ? ""
            : e.spans.map((s) => s.text).join(""),
    )
    .filter(Boolean)
    .join("\n\n");
  return { index, view, width: view[2] - view[0], height: view[3] - view[1], elements, text, lines: layout.lines };
}
