import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, decodeText, loadPdfLib, nameOf, numbers, type PDFDocument, type PDFObject } from "../lib/pdflib";
import { pdfjs } from "../lib/pdfjs";
import { getRuntime, getViewer } from "../state/runtime";
import { getDoc, toast, updateDoc } from "../state/store";
import { commitForms, reloadDocument } from "../core/document";
import type { DocState } from "../state/types";
import type { LinkAnnot, LinkHighlight, LinkTarget } from "../annotations/types";
import { createLink } from "../annotations/factory";
import { borderWidth, colorOf, pageView, quadsOf, readQuillmarkData, rectOf } from "../annotations/importer";

const get = (d: PDFDict, k: string) => d.get(PDFName.of(k));
const lookup = (doc: PDFDocument, o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);

const HIGHLIGHT: Record<string, LinkHighlight> = { N: "none", I: "invert", O: "outline", P: "push" };

// ---------------- Destinations ----------------

function searchNameTree(doc: PDFDocument, node: PDFDict, key: string, depth = 0): PDFObject | undefined {
  if (depth > 32) return undefined;
  const names = lookup(doc, get(node, "Names"));
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      if (decodeText(lookup(doc, names.get(i))) === key) return lookup(doc, names.get(i + 1));
    }
  }
  const kids = lookup(doc, get(node, "Kids"));
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = lookup(doc, kids.get(i));
      if (!(kid instanceof PDFDict)) continue;
      const found = searchNameTree(doc, kid, key, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function namedDestination(doc: PDFDocument, name: string): PDFObject | undefined {
  const catalog = doc.catalog;
  const dests = lookup(doc, catalog.get(PDFName.of("Dests")));
  let value: PDFObject | undefined;
  if (dests instanceof PDFDict) value = lookup(doc, dests.get(PDFName.of(name)));
  if (!value) {
    const names = lookup(doc, catalog.get(PDFName.of("Names")));
    const tree = names instanceof PDFDict ? lookup(doc, get(names, "Dests")) : undefined;
    if (tree instanceof PDFDict) value = searchNameTree(doc, tree, name);
  }
  // Values are either the destination array or a dictionary holding it in /D.
  return value instanceof PDFDict ? lookup(doc, get(value, "D")) : value;
}

const numOrNull = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : null);

/** Resolves a destination (explicit array or name) to a page of this document. */
export function resolveDestination(doc: PDFDocument, dest: PDFObject | undefined, pageIndexByRef: Map<string, number>, pageIds: string[]): LinkTarget | null {
  let arr = dest;
  if (!(arr instanceof PDFArray)) {
    const name = decodeText(arr as PDFObject);
    if (!name) return null;
    arr = namedDestination(doc, name);
  }
  if (!(arr instanceof PDFArray) || arr.size() < 2) return null;
  const pageObj = arr.get(0);
  const index = pageObj instanceof PDFRef ? pageIndexByRef.get(pageObj.tag) : pageObj instanceof PDFNumber ? pageObj.asNumber() : undefined;
  if (index === undefined || !pageIds[index]) return null;
  const type = nameOf(arr.get(1));
  const at = (i: number) => (i < arr.size() ? numOrNull(lookup(doc, arr.get(i))) : null);
  const target: LinkTarget = { type: "page", pageId: pageIds[index] };
  if (type === "XYZ") {
    target.left = at(2);
    target.top = at(3);
    target.zoom = at(4) || null;
  } else if (type === "FitH" || type === "FitBH") target.top = at(2);
  else if (type === "FitV" || type === "FitBV") target.left = at(2);
  else if (type === "FitR") {
    target.left = at(2);
    target.top = at(5);
  }
  return target;
}

// ---------------- Lifting existing links into the model ----------------

/**
 * Removes the web and page links of `doc` and returns them as editable link
 * annotations. Links with other actions (scripts, named actions, files…)
 * stay in the document untouched.
 */
export function extractLinks(doc: PDFDocument, pageIds: string[]): LinkAnnot[] {
  const pages = doc.getPages();
  const pageIndexByRef = new Map(pages.map((p, i) => [p.ref.tag, i]));
  const out: LinkAnnot[] = [];
  pages.forEach((page, pi) => {
    const annots = lookup(doc, page.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) return;
    const keep: PDFObject[] = [];
    let removed = 0;
    const rotation = page.getRotation().angle;
    const view = pageView(page);
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const d = lookup(doc, ref);
      const link = d instanceof PDFDict && nameOf(get(d, "Subtype")) === "Link" ? convertLink(doc, d, pageIds[pi], rotation, view, pageIndexByRef, pageIds) : null;
      if (link) {
        out.push(link);
        removed++;
      } else keep.push(ref);
    }
    if (!removed) return;
    if (keep.length) page.node.set(PDFName.of("Annots"), doc.context.obj(keep));
    else page.node.delete(PDFName.of("Annots"));
  });
  return out;
}

function convertLink(doc: PDFDocument, d: PDFDict, pageId: string, rotation: number, view: number[], pageIndexByRef: Map<string, number>, pageIds: string[]): LinkAnnot | null {
  let target: LinkTarget | null = null;
  const action = lookup(doc, get(d, "A"));
  if (action instanceof PDFDict) {
    if (get(action, "Next")) return null; // chained actions: leave to the viewer
    const s = nameOf(get(action, "S"));
    if (s === "URI") {
      const url = decodeText(lookup(doc, get(action, "URI"))).trim();
      if (url) target = { type: "url", url };
    } else if (s === "GoTo") target = resolveDestination(doc, lookup(doc, get(action, "D")), pageIndexByRef, pageIds);
  } else if (get(d, "Dest")) {
    target = resolveDestination(doc, lookup(doc, get(d, "Dest")), pageIndexByRef, pageIds);
  }
  if (!target) return null;

  const rect = rectOf(d);
  if (rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0) return null;
  const color = colorOf(d);
  const width = borderWidth(doc, d, 1);
  const bs = lookup(doc, get(d, "BS"));
  const style = bs instanceof PDFDict ? nameOf(get(bs, "S")) : null;
  const quads = numbers(get(d, "QuadPoints")).length >= 8 ? quadsOf(d, rotation, view) : undefined;

  const saved = readQuillmarkData(doc, d);
  return createLink(pageId, rect, rotation, target, {
    ...(saved?.kind === "link" ? saved : {}),
    pageId,
    rect,
    color: color ?? "#000000",
    showBorder: width > 0 && !!color,
    borderWidth: Math.max(1, Math.min(3, Math.round(width))) || 1,
    borderStyle: style === "D" ? "dashed" : style === "U" ? "underline" : "solid",
    highlight: HIGHLIGHT[nameOf(get(d, "H")) ?? "I"] ?? "invert",
    quads,
  });
}

const lifting = new Map<string, Promise<number>>();

/**
 * Makes the document's existing links editable (Acrobat's "Edit link" mode):
 * they move from the page into Quillmark's model, where they can be selected,
 * changed and deleted, and are written back on save.
 */
export function liftLinks(docId: string): Promise<number> {
  let p = lifting.get(docId);
  if (!p) {
    p = doLift(docId)
      .catch((e) => {
        console.warn("Could not make links editable", e);
        return 0;
      })
      .finally(() => lifting.delete(docId));
    lifting.set(docId, p);
  }
  return p;
}

async function doLift(docId: string): Promise<number> {
  const rt = getRuntime(docId);
  const d = getDoc(docId);
  if (!rt || !d || d.status !== "ready") return 0;
  const found = await rt.pdf.getAnnotationsByType(new Set([pdfjs.AnnotationType.LINK]), new Set()).catch(() => []);
  if (!found.some((a) => (a as { url?: string }).url || (a as { dest?: unknown }).dest)) return 0;
  const bytes = await commitForms(docId);
  const pageIds = d.pages.map((p) => p.id);
  const doc = await loadPdfLib(bytes);
  const links = extractLinks(doc, pageIds);
  if (!links.length) return 0;
  const out = await doc.save({ useObjectStreams: true });
  const current = getDoc(docId);
  // The document changed while we worked: try again next time.
  if (!current || rt.bytes !== bytes || current.pages.map((p) => p.id).join() !== pageIds.join()) return 0;
  await reloadDocument(docId, out, pageIds);
  // Merge into the latest annotations: the user may have added some while the document reloaded.
  updateDoc(docId, (d) => ({ annotations: [...d.annotations, ...links] }));
  return links.length;
}

// ---------------- Following & describing ----------------

export function followLink(docId: string, a: LinkAnnot) {
  const t = a.target;
  if (t.type === "url") {
    const url = normalizeUrl(t.url);
    if (!url) return toast("This link has no valid address", "warning");
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const doc = getDoc(docId);
  const v = getViewer(docId);
  const index = doc?.pages.findIndex((p) => p.id === t.pageId) ?? -1;
  if (!v || index < 0) return toast("The linked page no longer exists", "warning");
  v.goToDestination(index, { left: t.left ?? null, top: t.top ?? null, zoom: t.zoom ?? null });
}

/** Adds a scheme to bare web addresses; rejects script URLs. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^(javascript|data|vbscript):/i.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(s)) return `mailto:${s}`;
  return `https://${s}`;
}

export function describeLink(doc: DocState, a: LinkAnnot): string {
  if (a.target.type === "url") return a.target.url.replace(/^mailto:/i, "Email ");
  const pageId = a.target.pageId;
  const i = doc.pages.findIndex((p) => p.id === pageId);
  if (i < 0) return "Missing page";
  const label = doc.pages[i].label;
  return `Go to page ${label && label !== String(i + 1) ? `${label} (${i + 1})` : i + 1}`;
}
