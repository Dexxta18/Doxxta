import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFPageLeaf,
  PDFPageTree,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from "@cantoo/pdf-lib";
import { rotationMatrix, type Matrix } from "./geometry";

export * from "@cantoo/pdf-lib";

/** Display frame of a page: width/height as shown and the display → user matrix (y up). */
export function displayFrame(page: PDFPage): { w: number; h: number; m: Matrix } {
  const cb = page.getCropBox();
  const x0 = cb.x,
    y0 = cb.y,
    x1 = cb.x + cb.width,
    y1 = cb.y + cb.height;
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const rot = rotationMatrix(r);
  const t = r === 90 ? [x1, y0] : r === 180 ? [x1, y1] : r === 270 ? [x0, y1] : [x0, y0];
  const swap = r === 90 || r === 270;
  return { w: swap ? cb.height : cb.width, h: swap ? cb.width : cb.height, m: [rot[0], rot[1], rot[2], rot[3], t[0], t[1]] };
}

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
  // pdf-lib inserts and removes pages by following the page tree's /Count and /Parent entries,
  // which some PDFs get wrong; it also overlooks pages without /Type.
  if (!pageTreeIsSound(doc)) repairPageTree(doc);
  collectGarbage(doc);
  return doc;
}

const KIDS = PDFName.of("Kids");
const COUNT = PDFName.of("Count");
const PARENT = PDFName.of("Parent");
const TYPE = PDFName.of("Type");
const PAGE = PDFName.of("Page");

/** Page attributes a page can inherit from the page tree above it. */
const INHERITED = ["Resources", "MediaBox", "CropBox", "Rotate"].map((k) => PDFName.of(k));

const copyValue = (doc: PDFDocument, v: PDFObject) => (v instanceof PDFDict || v instanceof PDFArray ? v.clone(doc.context) : v);

/**
 * Makes `pages` the document's pages, in this order, under one new page tree node. Use it
 * instead of pdf-lib's insertPage/removePage, which rely on the tree's /Count entries. Pages
 * missing from the list are removed.
 */
export function setPageOrder(doc: PDFDocument, pages: PDFPage[]) {
  // The old tree goes away, so each page keeps its own copy of what it inherited from it.
  for (const page of pages) {
    for (const name of INHERITED) {
      if (page.node.get(name) !== undefined) continue;
      const value = page.node.getInheritableAttribute(name);
      if (value !== undefined) page.node.set(name, copyValue(doc, value));
    }
  }
  rebuildPageTree(doc, pages.map((p) => p.ref));
}

function rebuildPageTree(doc: PDFDocument, refs: PDFRef[]) {
  const ctx = doc.context;
  const tree = PDFPageTree.withContext(ctx);
  const treeRef = ctx.register(tree);
  tree.set(KIDS, ctx.obj(refs));
  tree.set(COUNT, PDFNumber.of(refs.length));
  for (const ref of refs) ctx.lookup(ref, PDFDict).set(PARENT, treeRef);
  doc.catalog.set(PDFName.of("Pages"), treeRef);
  // pdf-lib caches the page list and count.
  const cache = doc as unknown as { pageCache: { invalidate(): void }; pageCount: number | undefined };
  cache.pageCache.invalidate();
  cache.pageCount = undefined;
}

/** True when every node of the page tree has a correct /Count and /Parent, every page has /Type, and there are no loops. */
function pageTreeIsSound(doc: PDFDocument): boolean {
  const ctx = doc.context;
  const seen = new Set<PDFDict>();
  const visit = (node: PDFDict): number | null => {
    if (seen.has(node)) return null;
    seen.add(node);
    if (node.get(TYPE) === PAGE) return node instanceof PDFPageLeaf ? 1 : null;
    const kids = node.lookupMaybe(KIDS, PDFArray);
    if (!kids) return null;
    let total = 0;
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookupMaybe(i, PDFDict);
      if (!kid || ctx.lookup(kid.get(PARENT)) !== node) return null;
      const n = visit(kid);
      if (n === null) return null;
      total += n;
    }
    return node.lookupMaybe(COUNT, PDFNumber)?.asNumber() === total ? total : null;
  };
  const root = doc.catalog.lookupMaybe(PDFName.of("Pages"), PDFDict);
  return !!root && visit(root) !== null;
}

/**
 * Rebuilds a damaged page tree as one flat list of the pages actually found in it, in
 * document order. Inherited attributes are copied down along the real ancestry, and pages
 * missing /Type become proper pages again.
 */
function repairPageTree(doc: PDFDocument) {
  const ctx = doc.context;
  const refs: PDFRef[] = [];
  const seen = new Set<string>();
  const walk = (ref: PDFObject | undefined, inherited: Map<PDFName, PDFObject>) => {
    if (!(ref instanceof PDFRef) || seen.has(ref.tag)) return;
    seen.add(ref.tag);
    const node = ctx.lookup(ref);
    if (!(node instanceof PDFDict)) return;
    const kids = node.get(TYPE) === PAGE ? undefined : node.lookupMaybe(KIDS, PDFArray);
    if (kids) {
      const next = new Map(inherited);
      for (const name of INHERITED) {
        const v = node.get(name);
        if (v !== undefined) next.set(name, v);
      }
      for (let i = 0; i < kids.size(); i++) walk(kids.get(i), next);
      return;
    }
    let leaf = node;
    if (!(leaf instanceof PDFPageLeaf)) {
      leaf = PDFPageLeaf.fromMapWithContext(new Map(node.entries()), ctx);
      ctx.assign(ref, leaf);
    }
    leaf.set(TYPE, PAGE);
    for (const [name, v] of inherited) if (leaf.get(name) === undefined) leaf.set(name, copyValue(doc, v));
    refs.push(ref);
  };
  walk(doc.catalog.get(PDFName.of("Pages")), new Map());
  if (refs.length) rebuildPageTree(doc, refs);
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
  const ref = doc.context.register(doc.context.flateStream(ops));
  addContentStream(doc, page, ref, opts.behind);
}

/** Adds a content stream before or after a page's existing content, whatever form /Contents has. */
export function addContentStream(doc: PDFDocument, page: PDFPage, ref: PDFRef, behind = false) {
  page.node.normalize();
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) {
    if (behind) contents.insert(0, ref);
    else contents.push(ref);
    return;
  }
  const existing = page.node.get(PDFName.of("Contents"));
  const list = existing ? (behind ? [ref, existing] : [existing, ref]) : [ref];
  page.node.set(PDFName.of("Contents"), doc.context.obj(list));
}

/** Replaces a page's content with one stream (kept as an array so later additions append). */
export function setPageContent(doc: PDFDocument, page: PDFPage, ref: PDFRef) {
  page.node.set(PDFName.of("Contents"), doc.context.obj([ref]));
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
