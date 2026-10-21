// Builds cv.pdf, a résumé page like the ones people edit most: bold section headings, bold job
// titles with dates right-aligned on a tab stop, a regular line under each, paragraphs with
// space after them (one justified), and bullets that start with a bold label. Written as .docx, then converted to PDF by LibreOffice (like Word's
// own export: embedded font subsets). Run: node tests/assets/make-cv.mjs (needs soffice).
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AlignmentType, Document, LevelFormat, Packer, Paragraph, TabStopType, TextRun } from "docx";

const here = dirname(fileURLToPath(import.meta.url));
const width = 12240 - 2 * 1080; // Letter, 0.75" margins (twips)
const body = { font: "Liberation Sans", size: 20 }; // 10 pt
const title = (role, dates) =>
  new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: width }],
    spacing: { before: 120, after: 20 },
    children: [new TextRun({ ...body, size: 21, bold: true, text: role }), new TextRun({ ...body, size: 21, bold: true, text: `\t${dates}` })],
  });
const line = (text) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ ...body, text })] });
const point = (text) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ ...body, text })] });
const heading = (text, before = 0) => new Paragraph({ spacing: { before, after: 120 }, children: [new TextRun({ font: "Carlito", size: 26, bold: true, text })] });
const bullet = (label, text) =>
  new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 60 }, children: [new TextRun({ ...body, bold: true, text: label }), new TextRun({ ...body, text })] });

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } } } }],
      },
    ],
  },
  sections: [
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      children: [
        heading("PROFESSIONAL EXPERIENCE"),
        title("Senior Analyst, Financial Planning", "Apr 2025 to Present"),
        line("Northwind Traders | Remote | Full-time"),
        point("Build monthly forecasts and budget models covering revenue, operating costs, headcount and capital spending across four business units."),
        point("Review spreadsheet models for broken references, hardcoded values, inconsistent formulas and unsupported assumptions."),
        point("Prepare variance commentary and scenario analysis for the leadership team, linking results with their operating drivers."),
        title("Financial Analyst, Business Planning", "Feb 2022 to Mar 2025"),
        line("Contoso Group | Lisbon, Portugal"),
        point("Redesigned planning templates with dynamic summaries and data checks, cutting monthly reporting time by 40%."),
        point("Supported operating expense budgeting and three-year projections linked to revenue growth and operational KPIs."),
        new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 80 }, children: [new TextRun({ ...body, text: "Worked with finance, sales and operations teams to align assumptions, explain variances and improve forecast accuracy, presenting findings in clear dashboards and short written summaries for managers who needed decisions quickly." })] }),
        heading("SKILLS", 200),
        bullet("Tools: ", "Excel (Power Query, pivot tables), Power BI, SQL and Python"),
        bullet("Languages: ", "English (native), Portuguese (fluent)"),
      ],
    },
  ],
});

const dir = mkdtempSync(join(tmpdir(), "cv-"));
writeFileSync(join(dir, "cv.docx"), await Packer.toBuffer(doc));
execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, join(dir, "cv.docx")], { stdio: "ignore" });
renameSync(join(dir, "cv.pdf"), join(here, "cv.pdf"));
console.log("Wrote", join(here, "cv.pdf"));
