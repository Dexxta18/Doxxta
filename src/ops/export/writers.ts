import { zipSync, strToU8 } from "fflate";
import type { Element, PageStructure, StyledText } from "./structure";
import { escapeHtml, escapeXml } from "../../lib/util";

// ---------------- Word ----------------

export async function toDocx(pages: PageStructure[], meta: { title: string; author?: string }): Promise<Uint8Array> {
  const d = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun, Table, TableRow, TableCell, WidthType, LevelFormat, BorderStyle } = d;
  const twip = (pt: number) => Math.round(pt * 20);
  const runs = (spans: StyledText[], scale = 1) =>
    spans.flatMap((s) =>
      s.text.split("\n").map(
        (part, i) =>
          new TextRun({
            text: part,
            break: i > 0 ? 1 : undefined,
            bold: s.bold || undefined,
            italics: s.italic || undefined,
            size: Math.max(2, Math.round(s.size * 2 * scale)),
            font: s.font,
          }),
      ),
    );
  const align = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED } as const;
  const heading = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
  let listId = 0;
  const numberingConfig: { reference: string; levels: { level: number; format: (typeof LevelFormat)[keyof typeof LevelFormat]; text: string; alignment: (typeof AlignmentType)[keyof typeof AlignmentType]; style: { paragraph: { indent: { left: number; hanging: number } } } }[] }[] = [];
  const sections = pages.map((p) => {
    const content = p.elements.filter((e) => e.kind !== "image" || e.rect[2] - e.rect[0] < p.width * 0.98 || e.rect[3] - e.rect[1] < p.height * 0.98 || p.elements.length === 1);
    const xs = content.flatMap((e) => [e.rect[0], e.rect[2]]);
    const ys = content.flatMap((e) => [e.rect[1], e.rect[3]]);
    const clamp = (v: number) => Math.min(72, Math.max(18, v));
    const margin = xs.length
      ? { left: clamp(Math.min(...xs) - p.view[0]), right: clamp(p.view[2] - Math.max(...xs)), top: clamp(p.view[3] - Math.max(...ys)), bottom: clamp(Math.min(...ys) - p.view[1]) }
      : { left: 72, right: 72, top: 72, bottom: 72 };
    const usable = p.width - margin.left - margin.right;
    const children = content.flatMap((e: Element) => {
      switch (e.kind) {
        case "heading":
          return [new Paragraph({ heading: heading[e.level], children: runs(e.spans) })];
        case "paragraph":
          return [new Paragraph({ alignment: align[e.align], spacing: { after: 120 }, children: runs(e.spans) })];
        case "list": {
          if (e.ordered) {
            const reference = `num${listId++}`;
            numberingConfig.push({ reference, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] });
            return e.items.map((it) => new Paragraph({ numbering: { reference, level: 0 }, children: runs(it) }));
          }
          return e.items.map((it) => new Paragraph({ bullet: { level: 0 }, children: runs(it) }));
        }
        case "table": {
          const cols = Math.max(...e.rows.map((r) => r.length));
          const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
          return [
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: e.rows.map(
                (r, ri) =>
                  new TableRow({
                    children: Array.from({ length: cols }, (_, c) => new TableCell({ borders: { top: border, bottom: border, left: border, right: border }, children: [new Paragraph({ children: [new TextRun({ text: r[c] ?? "", bold: ri === 0 || undefined })] })] })),
                  }),
              ),
            }),
            new Paragraph({ children: [] }),
          ];
        }
        case "image": {
          let w = e.rect[2] - e.rect[0],
            h = e.rect[3] - e.rect[1];
          if (w > usable) {
            h *= usable / w;
            w = usable;
          }
          return [new Paragraph({ children: [new ImageRun({ type: "png", data: e.png, transformation: { width: Math.round((w * 96) / 72), height: Math.round((h * 96) / 72) } })] })];
        }
      }
    });
    return {
      properties: { page: { size: { width: twip(p.width), height: twip(p.height) }, margin: { left: twip(margin.left), right: twip(margin.right), top: twip(margin.top), bottom: twip(margin.bottom) } } },
      children: children.length ? children : [new Paragraph({ children: [] })],
    };
  });
  const doc = new Document({ title: meta.title, creator: meta.author || "Folio", numbering: { config: numberingConfig }, sections });
  return new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
}

// ---------------- Excel ----------------

function colName(n: number): string {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Numbers like "1,234.50", "$12", "(45)", "12%" become numeric cells. */
function asNumber(v: string): number | null {
  const t = v.trim();
  if (!/^[-+(]?[$€£¥]?\s?[-+]?\d[\d,. ]*%?\)?$/.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const pct = t.endsWith("%");
  let digits = t.replace(/[^\d.,]/g, "");
  // Codes with leading zeros (zip codes, IDs) stay text.
  if (/^0\d/.test(digits)) return null;
  // "1.234,56" uses a decimal comma; "1,234.56" a thousands comma.
  if (digits.lastIndexOf(",") > digits.lastIndexOf(".") && /,\d{1,2}$/.test(digits)) digits = digits.replace(/\./g, "").replace(",", ".");
  else digits = digits.replace(/,/g, "");
  const n = parseFloat(digits);
  if (!Number.isFinite(n)) return null;
  return (neg ? -n : n) / (pct ? 100 : 1);
}

export function toXlsx(sheets: { name: string; rows: string[][]; headerRows?: number[] }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const names = sheets.map((s) => {
    let n = s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
    let k = 2;
    while (used.has(n.toLowerCase())) n = `${s.name.slice(0, 27)} (${k++})`;
    used.add(n.toLowerCase());
    return n;
  });
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
  );
  sheets.forEach((s, i) => {
    const header = new Set(s.headerRows ?? []);
    const widths: number[] = [];
    const rows = s.rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            widths[ci] = Math.max(widths[ci] ?? 6, Math.min(60, v.length + 2));
            if (!v) return "";
            const ref = `${colName(ci)}${ri + 1}`;
            const style = header.has(ri) ? ' s="1"' : "";
            const n = header.has(ri) ? null : asNumber(v);
            return n !== null ? `<c r="${ref}"${style}><v>${n}</v></c>` : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    const cols = widths.length ? `<cols>${widths.map((w, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`);
  });
  return zipSync(files, { level: 6 });
}

/** Spreadsheet rows for a page: its tables, or its lines split into cells. */
export function pageRows(p: PageStructure): { rows: string[][]; headerRows: number[] } {
  const tables = p.elements.filter((e): e is Element & { kind: "table" } => e.kind === "table");
  if (tables.length) {
    const rows: string[][] = [];
    const headerRows: number[] = [];
    for (const t of tables) {
      if (rows.length) rows.push([]);
      headerRows.push(rows.length);
      rows.push(...t.rows);
    }
    return { rows, headerRows };
  }
  const byLine = [...p.lines].sort((a, b) => b.baseline - a.baseline || a.rect[0] - b.rect[0]);
  const rows: string[][] = [];
  let last: number | null = null;
  for (const l of byLine) {
    if (last !== null && Math.abs(last - l.baseline) <= l.size * 0.4) rows[rows.length - 1].push(l.text);
    else rows.push([l.text]);
    last = l.baseline;
  }
  return { rows, headerRows: [] };
}

// ---------------- PowerPoint ----------------

export async function toPptx(
  pages: { structure: PageStructure | null; image: string | null; width: number; height: number }[],
  meta: { title: string; author?: string },
  mode: "images" | "editable",
): Promise<Uint8Array> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const first = pages[0];
  const W = 10;
  const H = first ? Math.min(56, (W * first.height) / first.width) : 7.5;
  pptx.defineLayout({ name: "PDF", width: W, height: H });
  pptx.layout = "PDF";
  pptx.title = meta.title;
  if (meta.author) pptx.author = meta.author;
  for (const p of pages) {
    const slide = pptx.addSlide();
    // Fit the page into the slide, centered.
    const scale = Math.min(W / (p.width / 72), H / (p.height / 72)) / 72;
    const ox = (W - p.width * scale) / 2,
      oy = (H - p.height * scale) / 2;
    if (mode === "images" && p.image) {
      slide.addImage({ data: p.image, x: ox, y: oy, w: p.width * scale, h: p.height * scale });
      if (p.structure?.text) slide.addNotes(p.structure.text);
      continue;
    }
    const s = p.structure;
    if (!s) continue;
    const pos = (r: number[]) => ({ x: ox + (r[0] - s.view[0]) * scale, y: oy + (s.view[3] - r[3]) * scale, w: Math.max(0.2, (r[2] - r[0]) * scale), h: Math.max(0.2, (r[3] - r[1]) * scale) });
    for (const e of s.elements) {
      if (e.kind === "image") {
        slide.addImage({ data: `data:image/png;base64,${base64(e.png)}`, ...pos(e.rect) });
      } else if (e.kind === "table") {
        slide.addTable(
          e.rows.map((r) => r.map((text) => ({ text }))),
          { ...pos(e.rect), fontSize: 10, border: { type: "solid", color: "BFBFBF", pt: 0.5 } },
        );
      } else {
        const spans = e.kind === "list" ? e.items.flatMap((it, i) => it.map((sp, k) => ({ ...sp, text: (k === 0 ? (e.ordered ? `${i + 1}. ` : "• ") : "") + sp.text + (k === it.length - 1 && i < e.items.length - 1 ? "\n" : "") }))) : e.spans;
        const textRuns = spans.map((sp) => ({ text: sp.text, options: { bold: sp.bold, italic: sp.italic, fontSize: Math.max(6, sp.size * scale * 72), fontFace: sp.font } }));
        const box = pos(e.rect);
        slide.addText(textRuns, { ...box, w: box.w * 1.06, h: box.h * 1.15, margin: 0, valign: "top", align: e.kind === "paragraph" ? (e.align === "justify" ? "justify" : e.align) : "left" });
      }
    }
    if (s.text) slide.addNotes(s.text);
  }
  const out = await pptx.write({ outputType: "uint8array" });
  return out as Uint8Array;
}

// ---------------- HTML & Markdown ----------------

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function htmlSpans(spans: StyledText[]): string {
  return spans
    .map((s) => {
      let t = escapeHtml(s.text).replace(/\n/g, "<br>");
      if (s.bold) t = `<strong>${t}</strong>`;
      if (s.italic) t = `<em>${t}</em>`;
      return t;
    })
    .join("");
}

export function toHtml(pages: PageStructure[], meta: { title: string }, opts: { images: boolean }): string {
  const body = pages
    .map((p) => {
      const parts = p.elements.map((e) => {
        switch (e.kind) {
          case "heading":
            return `<h${e.level}>${htmlSpans(e.spans)}</h${e.level}>`;
          case "paragraph":
            return `<p${e.align !== "left" ? ` style="text-align:${e.align}"` : ""}>${htmlSpans(e.spans)}</p>`;
          case "list": {
            const tag = e.ordered ? "ol" : "ul";
            return `<${tag}>${e.items.map((it) => `<li>${htmlSpans(it)}</li>`).join("")}</${tag}>`;
          }
          case "table":
            return `<table><thead><tr>${e.rows[0].map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${e.rows
              .slice(1)
              .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
              .join("")}</tbody></table>`;
          case "image":
            return opts.images ? `<figure><img alt="" src="data:image/png;base64,${base64(e.png)}" style="width:${Math.round(e.rect[2] - e.rect[0])}pt;max-width:100%"></figure>` : "";
        }
      });
      return `<section class="page" id="page-${p.index + 1}" aria-label="Page ${p.index + 1}">\n${parts.filter(Boolean).join("\n")}\n</section>`;
    })
    .join("\n<hr>\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1b2230; background: #fff; max-width: 820px; margin: 0 auto; padding: 32px 20px; }
  h1, h2, h3 { line-height: 1.25; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 14px; }
  th, td { border: 1px solid #cfd5df; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f5f8; }
  figure { margin: 1em 0; }
  img { height: auto; }
  hr { border: 0; border-top: 1px dashed #cfd5df; margin: 40px 0; }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e6e9ef; } th { background: #252931; } th, td, hr { border-color: #3a404b; } }
  @media print { hr { page-break-after: always; border: 0; } }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function mdSpans(spans: StyledText[]): string {
  return spans
    .map((s) => {
      const t = s.text.replace(/([\\`*_[\]#|<>])/g, "\\$1");
      const lead = t.match(/^\s*/)![0],
        trail = t.match(/\s*$/)![0];
      let core = t.trim();
      if (!core) return t;
      if (s.bold) core = `**${core}**`;
      if (s.italic) core = `_${core}_`;
      return lead + core + trail;
    })
    .join("")
    .replace(/\n/g, "  \n");
}

export function toMarkdown(pages: PageStructure[], meta: { title: string }, opts: { images: boolean }): string {
  const out: string[] = [];
  for (const p of pages) {
    for (const e of p.elements) {
      switch (e.kind) {
        case "heading":
          out.push(`${"#".repeat(e.level)} ${mdSpans(e.spans).replace(/\s*\n\s*/g, " ")}`);
          break;
        case "paragraph":
          out.push(mdSpans(e.spans));
          break;
        case "list":
          out.push(e.items.map((it, i) => `${e.ordered ? `${i + 1}.` : "-"} ${mdSpans(it).replace(/\n/g, " ")}`).join("\n"));
          break;
        case "table": {
          const cols = Math.max(...e.rows.map((r) => r.length));
          const cell = (v?: string) => (v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
          const row = (r: string[]) => `| ${Array.from({ length: cols }, (_, c) => cell(r[c])).join(" | ")} |`;
          out.push([row(e.rows[0]), `| ${Array(cols).fill("---").join(" | ")} |`, ...e.rows.slice(1).map(row)].join("\n"));
          break;
        }
        case "image":
          if (opts.images) out.push(`![](data:image/png;base64,${base64(e.png)})`);
          break;
      }
    }
    out.push("---");
  }
  if (out[out.length - 1] === "---") out.pop();
  return `${meta.title ? `<!-- ${meta.title.replace(/--/g, "–")} -->\n\n` : ""}${out.join("\n\n")}\n`;
}

// ---------------- Plain text ----------------

/** Text that keeps the page's spatial layout using spaces (monospace approximation). */
export function layoutTextOf(p: PageStructure): string {
  const lines = [...p.lines].filter((l) => Math.abs(l.angle) < 0.02).sort((a, b) => b.baseline - a.baseline || a.rect[0] - b.rect[0]);
  if (!lines.length) return "";
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const charW = (sizes[Math.floor(sizes.length / 2)] || 10) * 0.5;
  const rows: { y: number; text: string; size: number }[] = [];
  for (const l of lines) {
    const col = Math.max(0, Math.round((l.rect[0] - p.view[0]) / charW));
    let row = rows[rows.length - 1];
    if (!row || Math.abs(row.y - l.baseline) > l.size * 0.4) {
      // Blank lines for large vertical gaps.
      if (row) for (let g = Math.floor((row.y - l.baseline) / (row.size * 1.4)) - 1; g > 0 && g < 4; g--) rows.push({ y: row.y, text: "", size: row.size });
      row = { y: l.baseline, text: "", size: l.size };
      rows.push(row);
    }
    if (row.text.length < col) row.text = row.text.padEnd(col, " ");
    else if (row.text) row.text += " ";
    row.text += l.text;
  }
  return rows.map((r) => r.text.trimEnd()).join("\n");
}
