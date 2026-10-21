// Export to Word (formatting kept) and the other formats.
import { strFromU8, unzipSync } from "fflate";

export const title = "Export to Word and other formats";

export default async function run({ page, check, open }) {
  await open("cv.pdf");
  const exported = (format, opts = {}) =>
    page.evaluate(
      async ({ format, opts }) => {
        const { exportDocument, EXPORT_DEFAULTS } = await import("/src/ops/export/index.ts");
        const res = await exportDocument(window.__quillmark.useApp.getState().activeId, format, { ...EXPORT_DEFAULTS, ...opts });
        return { name: res.name, bytes: Array.from(res.bytes) };
      },
      { format, opts },
    );

  const docx = await exported("docx");
  const xml = strFromU8(unzipSync(new Uint8Array(docx.bytes))["word/document.xml"]);
  const paragraphs = xml.split("</w:p>").map((p) => ({ xml: p, text: [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("") }));
  const para = (text) => paragraphs.find((p) => p.text.includes(text))?.xml ?? "";

  const title = para("Senior Analyst, Financial Planning");
  check(/<w:tab w:val="right"/.test(title) && /<w:tab\/>/.test(title) && title.includes("Apr 2025 to Present"), "a title and its dates stay on one line, the dates at a right tab stop");
  check(/<w:b\/>/.test(title) && /w:ascii="Arial"/.test(title) && /<w:sz w:val="21"\/>/.test(title), "the title keeps its font (Liberation Sans as Arial), size and bold");
  const heading = para("PROFESSIONAL EXPERIENCE");
  check(/w:ascii="Calibri"/.test(heading) && /<w:color w:val="000000"\/>/.test(heading) && /<w:sz w:val="26"\/>/.test(heading), "the section heading keeps its font (Carlito as Calibri), size and color");
  check(/<w:jc w:val="both"\/>/.test(para("Worked with finance")), "the justified paragraph stays justified");
  check(/w:lineRule="exact"/.test(para("Build monthly forecasts")) && /w:before="\d+"/.test(para("Review spreadsheet")), "line and paragraph spacing come from the page");
  const bullet = para("Excel (Power Query");
  check(/<w:numPr>/.test(bullet) && !/•/.test(paragraphs.find((p) => p.text.includes("Excel (Power Query"))?.text ?? "•") && /<w:b\/>[^]*Tools:/.test(bullet), "bullets become a Word list, keeping the bold label and dropping the typed bullet");

  for (const format of ["html", "md", "txt", "xlsx", "pptx"]) {
    const out = await exported(format, format === "pptx" ? { pptxMode: "editable" } : {});
    const text = format === "xlsx" || format === "pptx" ? Object.values(unzipSync(new Uint8Array(out.bytes))).map((f) => strFromU8(f)).join("") : strFromU8(new Uint8Array(out.bytes));
    check(text.includes("Business Planning"), `exports to ${format.toUpperCase()}`);
  }
}
