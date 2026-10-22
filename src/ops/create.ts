import { PDFDocument, StandardFonts, rgb } from "../lib/pdflib";
import { loadImageFile } from "../lib/images";
import { dataUrlToBytes } from "../lib/util";
import { openGenerated } from "../core/document";
import { toast, withBusy } from "../state/store";

export const PAPER: Record<string, [number, number]> = {
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
  A3: [842, 1191],
  A4: [595, 842],
  A5: [420, 595],
  B5: [499, 709],
  Executive: [522, 756],
};

export interface ImagesToPdfOptions {
  /** "fit" = page matches each image; otherwise a paper name. */
  pageSize: "fit" | keyof typeof PAPER | string;
  orientation?: "auto" | "portrait" | "landscape";
  /** Margin in points around images on paper-size pages. */
  margin: number;
  jpegQuality?: number;
}

/** Builds a PDF with one image per page. */
export async function imagesToPdf(files: Blob[], opts: ImagesToPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const f of files) {
    const img = await loadImageFile(f, 4000);
    const bytes = dataUrlToBytes(img.dataUrl);
    const embedded = img.mime === "image/jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    // 96 dpi images map to 72 pt per inch.
    const iw = (img.width * 72) / 96;
    const ih = (img.height * 72) / 96;
    if (opts.pageSize === "fit") {
      const page = doc.addPage([iw + opts.margin * 2, ih + opts.margin * 2]);
      page.drawImage(embedded, { x: opts.margin, y: opts.margin, width: iw, height: ih });
      continue;
    }
    let [pw, ph] = PAPER[opts.pageSize] ?? PAPER.Letter;
    const landscape = opts.orientation === "landscape" || (opts.orientation !== "portrait" && img.width > img.height);
    if (landscape) [pw, ph] = [ph, pw];
    const page = doc.addPage([pw, ph]);
    const aw = pw - opts.margin * 2,
      ah = ph - opts.margin * 2;
    const s = Math.min(aw / iw, ah / ih, 1e9);
    const w = iw * s,
      h = ih * s;
    page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  doc.setCreator("Doxxta");
  return doc.save();
}

export interface TextToPdfOptions {
  font: "Courier" | "Helvetica" | "Times";
  size: number;
  paper: string;
  margin: number;
}

/** Typesets a plain-text file onto pages. */
export async function textToPdf(text: string, opts: TextToPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontName = opts.font === "Courier" ? StandardFonts.Courier : opts.font === "Times" ? StandardFonts.TimesRoman : StandardFonts.Helvetica;
  let font = await doc.embedFont(fontName);
  let needsUnicode = false;
  try {
    font.encodeText(text.replace(/[\r\n\t]/g, " "));
  } catch {
    needsUnicode = true;
  }
  if (needsUnicode) {
    const fontkit = (await import("@cantoo/fontkit")).default;
    doc.registerFontkit(fontkit as never);
    const url = new URL(`${import.meta.env.BASE_URL}vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf`, document.baseURI).href;
    font = await doc.embedFont(new Uint8Array(await (await fetch(url)).arrayBuffer()), { subset: true });
  }
  const [pw, ph] = PAPER[opts.paper] ?? PAPER.Letter;
  const lh = opts.size * 1.35;
  const maxW = pw - opts.margin * 2;
  const lines: string[] = [];
  for (const raw of text.replace(/\t/g, "    ").split(/\r?\n/)) {
    if (!raw) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(/(\s+)/)) {
      const t = line + word;
      if (font.widthOfTextAtSize(t, opts.size) > maxW && line.trim()) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else line = t;
      // Hard-break very long words.
      while (font.widthOfTextAtSize(line, opts.size) > maxW && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), opts.size) > maxW) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  const perPage = Math.max(1, Math.floor((ph - opts.margin * 2) / lh));
  for (let i = 0; i < Math.max(1, lines.length); i += perPage) {
    const page = doc.addPage([pw, ph]);
    lines.slice(i, i + perPage).forEach((l, k) => {
      if (l) page.drawText(l, { x: opts.margin, y: ph - opts.margin - opts.size - k * lh, size: opts.size, font, color: rgb(0.08, 0.08, 0.1) });
    });
  }
  doc.setCreator("Doxxta");
  return doc.save();
}

export async function blankPdf(paper: string, count: number, orientation: "portrait" | "landscape"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  let [w, h] = PAPER[paper] ?? PAPER.Letter;
  if (orientation === "landscape") [w, h] = [h, w];
  for (let i = 0; i < Math.max(1, count); i++) doc.addPage([w, h]);
  doc.setCreator("Doxxta");
  return doc.save();
}

export async function createFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    const blobs: Blob[] = [];
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith("image/"));
      if (type) blobs.push(await it.getType(type));
    }
    if (!blobs.length) {
      const text = await navigator.clipboard.readText().catch(() => "");
      if (text.trim()) {
        await withBusy("Creating PDF…", async () => {
          const bytes = await textToPdf(text, { font: "Helvetica", size: 11, paper: "Letter", margin: 54 });
          await openGenerated(bytes, "Clipboard.pdf");
        });
        return;
      }
      toast("The clipboard has no image or text", "warning");
      return;
    }
    await withBusy("Creating PDF…", async () => {
      const bytes = await imagesToPdf(blobs, { pageSize: "fit", margin: 0 });
      await openGenerated(bytes, "Clipboard.pdf");
    });
  } catch {
    toast("Clipboard access was denied by the browser", "error");
  }
}
