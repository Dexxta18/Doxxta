import { PDFName, addPageContent, addPageResource, loadPdfLib, type PDFDocument, type PDFPage, type PDFRef } from "../lib/pdflib";
import { applyDocumentChange } from "../core/document";
import { getRuntime } from "../state/runtime";
import { getDoc, toast } from "../state/store";
import { getPageTextContent, pdfjs } from "../lib/pdfjs";
import { fmt } from "../lib/colors";
import { rotationMatrix } from "../lib/geometry";

export interface OcrOptions {
  languages: string[];
  /** 0-based pages, null = all. */
  pages: number[] | null;
  dpi: number;
  /** Skip pages that already contain real text. */
  skipTextPages?: boolean;
}

export const OCR_LANGUAGES: { code: string; label: string }[] = [
  { code: "eng", label: "English" },
  { code: "fra", label: "French" },
  { code: "deu", label: "German" },
  { code: "spa", label: "Spanish" },
  { code: "por", label: "Portuguese" },
  { code: "ita", label: "Italian" },
  { code: "nld", label: "Dutch" },
  { code: "pol", label: "Polish" },
  { code: "rus", label: "Russian" },
  { code: "ukr", label: "Ukrainian" },
  { code: "tur", label: "Turkish" },
  { code: "ara", label: "Arabic" },
  { code: "heb", label: "Hebrew" },
  { code: "hin", label: "Hindi" },
  { code: "chi_sim", label: "Chinese (Simplified)" },
  { code: "chi_tra", label: "Chinese (Traditional)" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
  { code: "yor", label: "Yoruba" },
  { code: "swa", label: "Swahili" },
];

interface OcrWord {
  text: string;
  /** Box in display pixels of the rendered page (y down). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface PageResult {
  index: number;
  words: OcrWord[][]; // lines of words
  scale: number;
  rotation: number;
  view: number[];
}

const vendor = (p: string) => new URL(`${import.meta.env.BASE_URL}vendor/tesseract/${p}`, document.baseURI).href;

async function createOcrWorker(languages: string[], onProgress: (status: string, p: number) => void) {
  const Tesseract = await import("tesseract.js");
  const onlyEnglish = languages.length === 1 && languages[0] === "eng";
  return Tesseract.createWorker(languages, Tesseract.OEM.LSTM_ONLY, {
    workerPath: vendor("worker.min.js"),
    corePath: vendor("core"),
    // English ships with the app; without a langPath tesseract.js fetches each
    // language from its own @tesseract.js-data package on jsDelivr.
    langPath: onlyEnglish ? vendor("lang") : undefined,
    gzip: true,
    logger: (m: { status: string; progress: number }) => onProgress(m.status, m.progress),
  } as never);
}

/** Runs OCR on pages, adding an invisible text layer so scanned pages become searchable and selectable. */
export async function runOcr(docId: string, opts: OcrOptions, progress?: (p: number, detail?: string) => void): Promise<number> {
  const rt = getRuntime(docId);
  const doc = getDoc(docId);
  if (!rt || !doc) return 0;
  const all = opts.pages ?? doc.pages.map((_, i) => i);
  let targets = all;
  if (opts.skipTextPages) {
    targets = [];
    for (const i of all) {
      const { items } = await getPageTextContent(rt.pdf, i);
      const len = items.reduce((s, it) => s + it.str.trim().length, 0);
      if (len < 20) targets.push(i);
    }
    if (!targets.length) {
      toast("All selected pages already contain searchable text", "info");
      return 0;
    }
  }
  // Tesseract downloads per-language data; with several languages use one worker per language set.
  const languages = opts.languages.length ? opts.languages : ["eng"];
  let stage = "Loading OCR engine";
  progress?.(0, stage);
  const worker = await createOcrWorker(languages, (status, p) => {
    if (/load|initializ/i.test(status)) progress?.(0, `${status} ${Math.round(p * 100)}%`);
  });
  const results: PageResult[] = [];
  try {
    for (let k = 0; k < targets.length; k++) {
      const i = targets[k];
      stage = `Recognizing page ${i + 1} (${k + 1} of ${targets.length})`;
      progress?.(k / targets.length, stage);
      const page = await rt.pdf.getPage(i + 1);
      const scale = opts.dpi / 72;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE, background: "#ffffff" }).promise;
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const lines: OcrWord[][] = [];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            const words = line.words
              .filter((w) => w.text.trim() && w.confidence > 25)
              .map((w) => ({ text: w.text.trim(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
            if (words.length) lines.push(words);
          }
        }
      }
      results.push({ index: i, words: lines, scale, rotation: page.rotate, view: [...page.view] });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } finally {
    await worker.terminate();
  }
  const wordCount = results.reduce((s, r) => s + r.words.flat().length, 0);
  if (!wordCount) {
    toast("No text was recognized on the selected pages", "warning");
    return 0;
  }
  progress?.(1, "Adding text layer");
  await applyDocumentChange(docId, "Recognize text (OCR)", async ({ bytes, pageIds }) => {
    const pdfDoc = await loadPdfLib(bytes);
    for (const r of results) addTextLayer(pdfDoc, pdfDoc.getPage(r.index), r);
    return { bytes: await pdfDoc.save(), pageIds };
  });
  return wordCount;
}

/** Converts a display-pixel point of the rendered page to PDF user space. */
function toUser(r: PageResult, x: number, y: number): [number, number] {
  // Inverse of pdf.js PageViewport (rotation + flip) at the render scale.
  const [x0, y0, x1, y1] = r.view;
  const px = x / r.scale,
    py = y / r.scale;
  switch (((r.rotation % 360) + 360) % 360) {
    case 90:
      return [x0 + py, y0 + px];
    case 180:
      return [x1 - px, y0 + py];
    case 270:
      return [x1 - py, y1 - px];
    default:
      return [x0 + px, y1 - py];
  }
}

/**
 * Adds invisible text (render mode 3) using small Type3 fonts with empty
 * glyphs and a ToUnicode map, so any script copies and searches correctly.
 */
function addTextLayer(doc: PDFDocument, page: PDFPage, r: PageResult) {
  const ctx = doc.context;
  const chars = new Set<string>();
  for (const line of r.words) for (const w of line) for (const ch of w.text + " ") chars.add(ch);
  const list = [...chars];
  // Up to 255 glyphs per simple font.
  const fonts: { name: string; map: Map<string, number> }[] = [];
  const empty = ctx.register(ctx.flateStream("500 0 d0"));
  for (let start = 0; start < list.length; start += 255) {
    const slice = list.slice(start, start + 255);
    const map = new Map<string, number>();
    const names: PDFName[] = [];
    const procs: Record<string, PDFRef> = {};
    let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Doxxta-OCR def /CMapType 2 def 1 begincodespacerange <01> <FF> endcodespacerange\n";
    const entries: string[] = [];
    slice.forEach((ch, k) => {
      const code = k + 1;
      map.set(ch, code);
      const gname = `g${code}`;
      names.push(PDFName.of(gname));
      procs[gname] = empty;
      let utf16 = "";
      for (const unit of ch.split("")) utf16 += unit.charCodeAt(0).toString(16).padStart(4, "0");
      entries.push(`<${code.toString(16).padStart(2, "0")}> <${utf16}>`);
    });
    for (let k = 0; k < entries.length; k += 100) {
      const chunk = entries.slice(k, k + 100);
      cmap += `${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar\n`;
    }
    cmap += "endcmap CMapName currentdict /CMap defineresource pop end end";
    const toUnicode = ctx.register(ctx.flateStream(cmap));
    const font = ctx.obj({
      Type: "Font",
      Subtype: "Type3",
      FontBBox: [0, 0, 500, 1000],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: procs,
      Encoding: { Type: "Encoding", Differences: [1, ...names] },
      FirstChar: 1,
      LastChar: slice.length,
      Widths: slice.map(() => 500),
      Resources: {},
      ToUnicode: toUnicode,
    } as never);
    const name = addPageResource(page, "Font", "DoxxtaOCR", ctx.register(font));
    fonts.push({ name, map });
  }
  const fontFor = (ch: string) => fonts.find((f) => f.map.has(ch))!;
  const rot = rotationMatrix(r.rotation);
  const ops: string[] = ["q", "BT", "3 Tr"];
  for (const line of r.words) {
    // Use one size per line for stable selection boxes.
    const h = Math.max(...line.map((w) => w.y1 - w.y0)) / r.scale;
    const size = Math.max(1, h * 0.92);
    line.forEach((w, k) => {
      const text = k < line.length - 1 ? `${w.text} ` : w.text;
      const widthPt = ((k < line.length - 1 ? line[k + 1].x0 : w.x1) - w.x0) / r.scale;
      const [ox, oy] = toUser(r, w.x0, w.y1 - (w.y1 - w.y0) * 0.18);
      // Split runs where the font changes.
      const runs: { font: string; codes: number[] }[] = [];
      for (const ch of text) {
        const f = fontFor(ch);
        const last = runs[runs.length - 1];
        if (last && last.font === f.name) last.codes.push(f.map.get(ch)!);
        else runs.push({ font: f.name, codes: [f.map.get(ch)!] });
      }
      const natural = [...text].length * 0.5 * size;
      const tz = natural > 0 ? Math.max(1, (100 * widthPt) / natural) : 100;
      ops.push(`${fmt(tz)} Tz`, `${fmt(rot[0])} ${fmt(rot[1])} ${fmt(rot[2])} ${fmt(rot[3])} ${fmt(ox)} ${fmt(oy)} Tm`);
      for (const run of runs) ops.push(`/${run.font} ${fmt(size)} Tf <${run.codes.map((c) => c.toString(16).padStart(2, "0")).join("")}> Tj`);
    });
  }
  ops.push("ET", "Q");
  addPageContent(doc, page, ops.join("\n"));
}
