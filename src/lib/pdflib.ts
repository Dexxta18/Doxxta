import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from "@cantoo/pdf-lib";

export * from "@cantoo/pdf-lib";

/**
 * Loads a document with pdf-lib, decrypting it when a password is given, and
 * removing leftovers of the original encryption (old xref streams and the
 * /Encrypt dictionary) so the result saves as a clean, unencrypted file.
 */
export async function loadPdfLib(bytes: Uint8Array, password?: string): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, {
    password: password ?? undefined,
    updateMetadata: false,
    throwOnInvalidObject: false,
  } as never);
  collectGarbage(doc);
  return doc;
}

/** Deletes every indirect object that can't be reached from the trailer. */
export function collectGarbage(doc: PDFDocument): number {
  const ctx = doc.context;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo as { Root?: PDFObject; Info?: PDFObject; Encrypt?: PDFObject };
  if (t.Root) stack.push(t.Root);
  if (t.Info) stack.push(t.Info);
  if (t.Encrypt) stack.push(t.Encrypt);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const tag = o.tag;
      if (reachable.has(tag)) continue;
      reachable.add(tag);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      for (const [, v] of o.dict.entries()) stack.push(v);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

/** PDF text string that preserves Unicode (UTF-16BE hex when needed). */
export function pdfText(s: string): PDFString | PDFHexString {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e\n\r\t]*$/.test(s) ? PDFString.of(escapeLiteral(s)) : PDFHexString.fromText(s);
}

function escapeLiteral(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/** Decodes a PDF text string/hex string object into a JS string. */
export function decodeText(o: PDFObject | undefined | null): string {
  if (!o) return "";
  if (o instanceof PDFString || o instanceof PDFHexString) {
    try {
      return o.decodeText();
    } catch {
      return o.asString();
    }
  }
  if (o instanceof PDFName) return o.decodeText();
  return "";
}

export function num(o: PDFObject | undefined | null, fallback = 0): number {
  return o instanceof PDFNumber ? o.asNumber() : fallback;
}

export function numbers(o: PDFObject | undefined | null): number[] {
  if (!(o instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < o.size(); i++) {
    const v = o.get(i);
    if (v instanceof PDFNumber) out.push(v.asNumber());
  }
  return out;
}

export function nameOf(o: PDFObject | undefined | null): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}

/**
 * Appends (or prepends, for backgrounds/watermarks behind content) a content
 * stream to a page. Existing content is isolated in q/Q so its graphics state
 * can't leak into ours.
 */
export function addPageContent(doc: PDFDocument, page: PDFPage, ops: string, opts: { behind?: boolean } = {}) {
  const ctx = doc.context;
  page.node.normalize();
  const stream = ctx.flateStream(ops);
  const ref = ctx.register(stream);
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) {
    if (opts.behind) contents.insert(0, ref);
    else contents.push(ref);
  } else {
    page.node.set(PDFName.of("Contents"), ctx.obj(opts.behind ? [ref] : [ref]));
  }
}

/** Adds a named resource (Font/XObject/ExtGState) to a page and returns its name. */
export function addPageResource(page: PDFPage, kind: "Font" | "XObject" | "ExtGState", prefix: string, ref: PDFObject): string {
  page.node.normalize();
  const resources = page.node.Resources()!;
  const ctx = page.doc.context;
  let dict = resources.lookupMaybe(PDFName.of(kind), PDFDict);
  if (!dict) {
    dict = ctx.obj({});
    resources.set(PDFName.of(kind), dict);
  }
  let i = 1;
  while (dict.has(PDFName.of(`${prefix}${i}`))) i++;
  const name = `${prefix}${i}`;
  dict.set(PDFName.of(name), ref);
  return name;
}

export function addAnnotRef(page: PDFPage, ref: PDFRef) {
  const ctx = page.doc.context;
  let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) {
    annots = ctx.obj([]);
    page.node.set(PDFName.of("Annots"), annots);
  }
  annots.push(ref);
}

// ----- Fonts -----

export type FontKey = "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique" | "Times-Roman" | "Times-Bold" | "Times-Italic" | "Times-BoldItalic" | "Courier" | "Courier-Bold" | "Courier-Oblique" | "Courier-BoldOblique";

const STD: Record<FontKey, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  "Helvetica-Bold": StandardFonts.HelveticaBold,
  "Helvetica-Oblique": StandardFonts.HelveticaOblique,
  "Helvetica-BoldOblique": StandardFonts.HelveticaBoldOblique,
  "Times-Roman": StandardFonts.TimesRoman,
  "Times-Bold": StandardFonts.TimesRomanBold,
  "Times-Italic": StandardFonts.TimesRomanItalic,
  "Times-BoldItalic": StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier,
  "Courier-Bold": StandardFonts.CourierBold,
  "Courier-Oblique": StandardFonts.CourierOblique,
  "Courier-BoldOblique": StandardFonts.CourierBoldOblique,
};

let unicodeFontBytes: Promise<{ regular: Uint8Array; bold: Uint8Array }> | null = null;

/** Liberation Sans (metric-compatible with Helvetica) for text outside WinAnsi. */
function loadUnicodeFonts() {
  if (!unicodeFontBytes) {
    const base = new URL(`${import.meta.env.BASE_URL}vendor/pdfjs/standard_fonts/`, document.baseURI).href;
    unicodeFontBytes = Promise.all([
      fetch(base + "LiberationSans-Regular.ttf").then((r) => r.arrayBuffer()),
      fetch(base + "LiberationSans-Bold.ttf").then((r) => r.arrayBuffer()),
    ]).then(([a, b]) => ({ regular: new Uint8Array(a), bold: new Uint8Array(b) }));
  }
  return unicodeFontBytes;
}

/** Per-document font cache: standard 14 fonts plus an embedded Unicode fallback. */
export class FontCache {
  private std = new Map<string, PDFFont>();
  private uni = new Map<string, PDFFont>();
  constructor(private doc: PDFDocument) {}

  get(name: FontKey): PDFFont {
    let f = this.std.get(name);
    if (!f) {
      f = this.doc.embedStandardFont(STD[name]);
      this.std.set(name, f);
    }
    return f;
  }

  /** A font able to encode `text`: the requested standard font, or Liberation Sans. */
  async forText(name: FontKey, text: string): Promise<PDFFont> {
    const std = this.get(name);
    if (canEncode(std, text)) return std;
    const bold = /Bold/.test(name);
    const key = bold ? "bold" : "regular";
    let f = this.uni.get(key);
    if (!f) {
      const fontkit = (await import("@cantoo/fontkit")).default;
      this.doc.registerFontkit(fontkit as never);
      const bytes = await loadUnicodeFonts();
      f = await this.doc.embedFont(bold ? bytes.bold : bytes.regular, { subset: true });
      this.uni.set(key, f);
    }
    return f;
  }
}

function canEncode(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text.replace(/[\r\n\t]/g, " "));
    return true;
  } catch {
    return false;
  }
}

export function fontKeyFor(family: "Helvetica" | "Times" | "Courier", bold: boolean, italic: boolean): FontKey {
  if (family === "Times") return bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
  if (family === "Courier") return bold && italic ? "Courier-BoldOblique" : bold ? "Courier-Bold" : italic ? "Courier-Oblique" : "Courier";
  return bold && italic ? "Helvetica-BoldOblique" : bold ? "Helvetica-Bold" : italic ? "Helvetica-Oblique" : "Helvetica";
}

/** Hex-encoded text operand for a pdf-lib font. */
export function encodeForFont(font: PDFFont, text: string): string {
  return font.encodeText(text).toString();
}
