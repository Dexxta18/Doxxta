import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, FontCache, addContentStream, addPageResource, loadPdfLib, setPageContent, type PDFDocument, type PDFObject } from "../lib/pdflib";
import { PName, parseContent, serializeContent, type Op } from "../lib/contentStream";
import { applyDocumentChange, readMetadata } from "../core/document";
import { getDoc, updateDoc } from "../state/store";
import { getRuntime } from "../state/runtime";
import type { Annotation } from "../annotations/types";
import { pageContent, redactPage } from "./contentRedact";

/** "Remove hidden information" (Acrobat's Sanitize) and flattening. */

export interface SanitizeOptions {
  metadata: boolean;
  attachments: boolean;
  comments: boolean;
  formFields: boolean;
  hiddenText: boolean;
  hiddenLayers: boolean;
  bookmarks: boolean;
  scripts: boolean;
  thumbnails: boolean;
  privateData: boolean;
}

export interface SanitizeReport {
  removed: string[];
}

const lookup = (doc: PDFDocument, o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : undefined);

const SCRIPT_ACTIONS = new Set(["JavaScript", "Launch", "ImportData", "SubmitForm", "ResetForm", "Rendition", "Sound", "Movie", "RichMediaExecute", "GoToR", "GoToE"]);

function isScriptAction(doc: PDFDocument, a: PDFObject | undefined): boolean {
  const d = lookup(doc, a);
  return d instanceof PDFDict && SCRIPT_ACTIONS.has(nameOf(lookup(doc, d.get(PDFName.of("S")))) ?? "");
}

/** Removes content inside optional-content layers that are hidden by default. */
function removeHiddenLayerContent(doc: PDFDocument, off: Set<string>): number {
  let removed = 0;
  const strip = (ops: Op[], resources: PDFDict | undefined): Op[] => {
    const props = resources ? lookup(doc, resources.get(PDFName.of("Properties"))) : undefined;
    const xobjects = resources ? lookup(doc, resources.get(PDFName.of("XObject"))) : undefined;
    const out: Op[] = [];
    let skipDepth = 0;
    let depth = 0;
    for (const o of ops) {
      if (o.op === "BDC" || o.op === "BMC") {
        depth++;
        if (!skipDepth && o.op === "BDC" && o.args[0] instanceof PName && o.args[0].name === "OC") {
          const p = o.args[1];
          const ref = p instanceof PName && props instanceof PDFDict ? props.get(PDFName.of(p.name)) : undefined;
          if (ref instanceof PDFRef && off.has(ref.tag)) {
            skipDepth = depth;
            removed++;
            continue;
          }
        }
      } else if (o.op === "EMC") {
        if (skipDepth && depth === skipDepth) {
          skipDepth = 0;
          depth--;
          continue;
        }
        depth--;
      }
      if (skipDepth) continue;
      if (o.op === "Do" && o.args[0] instanceof PName && xobjects instanceof PDFDict) {
        const x = lookup(doc, xobjects.get(PDFName.of(o.args[0].name)));
        const oc = x instanceof PDFStream ? x.dict.get(PDFName.of("OC")) : undefined;
        if (oc instanceof PDFRef && off.has(oc.tag)) {
          removed++;
          continue;
        }
      }
      out.push(o);
    }
    return out;
  };
  for (const page of doc.getPages()) {
    const data = pageContent(doc, page);
    if (!data) continue;
    const before = removed;
    const ops = strip(parseContent(data), page.node.Resources());
    if (removed !== before) setPageContent(doc, page, doc.context.register(doc.context.flateStream(serializeContent(ops))));
  }
  return removed;
}

/** Applies the selected cleanups to a pdf-lib document. */
export async function sanitizeDoc(doc: PDFDocument, opts: SanitizeOptions): Promise<SanitizeReport> {
  const removed: string[] = [];
  const ctx = doc.context;
  const catalog = doc.catalog;
  const names = lookup(doc, catalog.get(PDFName.of("Names")));

  if (opts.metadata) {
    ctx.trailerInfo.Info = ctx.register(ctx.obj({}));
    catalog.delete(PDFName.of("Metadata"));
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      d?.delete(PDFName.of("Metadata"));
    }
    removed.push("metadata");
  }
  if (opts.privateData) {
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      d?.delete(PDFName.of("PieceInfo"));
      d?.delete(PDFName.of("LastModified"));
    }
    removed.push("private application data");
  }
  if (opts.attachments) {
    if (names instanceof PDFDict) names.delete(PDFName.of("EmbeddedFiles"));
    catalog.delete(PDFName.of("AF"));
    catalog.delete(PDFName.of("Collection"));
    removed.push("attachments");
  }
  if (opts.bookmarks) {
    catalog.delete(PDFName.of("Outlines"));
    removed.push("bookmarks");
  }
  if (opts.scripts) {
    if (names instanceof PDFDict) names.delete(PDFName.of("JavaScript"));
    if (isScriptAction(doc, catalog.get(PDFName.of("OpenAction")))) catalog.delete(PDFName.of("OpenAction"));
    catalog.delete(PDFName.of("AA"));
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      obj.delete(PDFName.of("AA"));
      if (isScriptAction(doc, obj.get(PDFName.of("A")))) obj.delete(PDFName.of("A"));
    }
    const acro = lookup(doc, catalog.get(PDFName.of("AcroForm")));
    if (acro instanceof PDFDict) acro.delete(PDFName.of("CO"));
    removed.push("scripts and actions");
  }
  if (opts.hiddenLayers) {
    const ocp = lookup(doc, catalog.get(PDFName.of("OCProperties")));
    if (ocp instanceof PDFDict) {
      const d = lookup(doc, ocp.get(PDFName.of("D")));
      const offArr = d instanceof PDFDict ? lookup(doc, d.get(PDFName.of("OFF"))) : undefined;
      const off = new Set<string>();
      if (offArr instanceof PDFArray) for (const r of offArr.asArray()) if (r instanceof PDFRef) off.add(r.tag);
      if (off.size) removeHiddenLayerContent(doc, off);
      catalog.delete(PDFName.of("OCProperties"));
      removed.push("hidden layers");
    }
  }
  for (const page of doc.getPages()) {
    if (opts.thumbnails) page.node.delete(PDFName.of("Thumb"));
    const annots = lookup(doc, page.node.get(PDFName.of("Annots")));
    if (annots instanceof PDFArray && (opts.comments || opts.attachments)) {
      const keep = annots.asArray().filter((ref) => {
        const d = lookup(doc, ref);
        const subtype = d instanceof PDFDict ? nameOf(lookup(doc, d.get(PDFName.of("Subtype")))) : undefined;
        if (subtype === "FileAttachment") return !opts.attachments && !opts.comments;
        if (subtype === "Link" || subtype === "Widget") return true;
        return !opts.comments;
      });
      if (keep.length !== annots.size()) {
        if (keep.length) page.node.set(PDFName.of("Annots"), ctx.obj(keep));
        else page.node.delete(PDFName.of("Annots"));
      }
    }
    if (opts.hiddenText) await redactPage(doc, page, [], { text: true, images: false, graphics: false, removeInvisible: true });
  }
  if (opts.thumbnails) removed.push("page thumbnails");
  if (opts.comments) removed.push("comments");
  if (opts.hiddenText) removed.push("hidden text");
  if (opts.formFields) {
    try {
      const form = doc.getForm();
      if (form.getFields().length) {
        form.flatten();
        removed.push("form fields");
      }
    } catch (e) {
      console.warn("flatten during sanitize", e);
    }
    const acro = lookup(doc, catalog.get(PDFName.of("AcroForm")));
    if (acro instanceof PDFDict) acro.delete(PDFName.of("XFA"));
  }
  return { removed };
}

/** Removes hidden information from an open document (undoable). */
export async function sanitize(docId: string, opts: SanitizeOptions): Promise<SanitizeReport | null> {
  const d = getDoc(docId);
  if (!d) return null;
  let report: SanitizeReport = { removed: [] };
  await applyDocumentChange(docId, "Remove hidden information", async ({ bytes, pageIds, annotations }) => {
    const doc = await loadPdfLib(bytes);
    let kept: Annotation[] = annotations;
    const fields = annotations.filter((a) => a.kind === "field");
    if (opts.formFields && fields.length) {
      // Fields created in this session are written first so they flatten with the rest.
      const { writeFormFields } = await import("./formFields");
      await writeFormFields(doc, fields as never, pageIds, new FontCache(doc));
      kept = kept.filter((a) => a.kind !== "field");
    }
    if (opts.comments) kept = kept.filter((a) => a.kind === "field" || a.kind === "link" || a.kind === "textedit" || a.kind === "redact");
    report = await sanitizeDoc(doc, opts);
    const extra: Record<string, unknown> = {};
    if (opts.bookmarks) Object.assign(extra, { outline: [], outlineDirty: true });
    if (opts.attachments) Object.assign(extra, { attachments: null, attachmentsDirty: false });
    if (opts.metadata) Object.assign(extra, { metadataDirty: false });
    return { bytes: await doc.save({ useObjectStreams: true }), pageIds, annotations: kept, extra };
  });
  const rt = getRuntime(docId);
  if (rt && opts.metadata) updateDoc(docId, { metadata: await readMetadata(rt.pdf) });
  return report;
}

/** Burns comments and/or form fields into the page content (undoable). */
export async function flattenDocument(docId: string, opts: { comments: boolean; forms: boolean; pageIds?: string[] }) {
  await applyDocumentChange(docId, "Flatten", async ({ bytes, pageIds, annotations }) => {
    const doc = await loadPdfLib(bytes);
    const fonts = new FontCache(doc);
    const onPage = (a: Annotation) => !opts.pageIds || opts.pageIds.includes(a.pageId);
    let kept = annotations;
    if (opts.forms) {
      const fields = annotations.filter((a) => a.kind === "field" && onPage(a));
      if (fields.length) {
        const { writeFormFields } = await import("./formFields");
        await writeFormFields(doc, fields as never, pageIds, fonts);
        kept = kept.filter((a) => !fields.includes(a));
      }
      try {
        doc.getForm().flatten();
      } catch (e) {
        console.warn("form flatten", e);
      }
    }
    if (opts.comments) {
      const comments = kept.filter((a) => onPage(a) && a.kind !== "field" && a.kind !== "link" && a.kind !== "textedit" && a.kind !== "redact");
      if (comments.length) {
        const { writeAnnotations } = await import("../annotations/writer");
        await writeAnnotations(doc, comments, pageIds, { flattenAll: true, fonts });
        kept = kept.filter((a) => !comments.includes(a));
      }
      // Foreign annotations that stayed in the file are flattened from their appearance streams.
      flattenFileAnnotations(doc, opts.pageIds ? pageIds.map((id, i) => (opts.pageIds!.includes(id) ? i : -1)).filter((i) => i >= 0) : null);
    }
    return { bytes: await doc.save({ useObjectStreams: true }), pageIds, annotations: kept };
  });
}

/** Draws the normal appearance of the file's own (non-widget, non-link) annotations into the pages. */
function flattenFileAnnotations(doc: PDFDocument, pageIndexes: number[] | null) {
  const ctx = doc.context;
  doc.getPages().forEach((page, i) => {
    if (pageIndexes && !pageIndexes.includes(i)) return;
    const annots = lookup(doc, page.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) return;
    const keep: PDFObject[] = [];
    const ops: string[] = [];
    for (const ref of annots.asArray()) {
      const d = lookup(doc, ref);
      const subtype = d instanceof PDFDict ? nameOf(lookup(doc, d.get(PDFName.of("Subtype")))) : undefined;
      if (!(d instanceof PDFDict) || subtype === "Link" || subtype === "Widget" || subtype === "Popup") {
        if (subtype !== "Popup") keep.push(ref);
        continue;
      }
      const flags = lookup(doc, d.get(PDFName.of("F")));
      const hidden = flags && "asNumber" in flags && ((flags as unknown as { asNumber(): number }).asNumber() & 2) !== 0;
      const ap = lookup(doc, d.get(PDFName.of("AP")));
      let n = ap instanceof PDFDict ? lookup(doc, ap.get(PDFName.of("N"))) : undefined;
      if (n instanceof PDFDict && !(n instanceof PDFStream)) {
        const as = nameOf(lookup(doc, d.get(PDFName.of("AS"))));
        n = as ? lookup(doc, n.get(PDFName.of(as))) : undefined;
      }
      const rect = lookup(doc, d.get(PDFName.of("Rect")));
      if (!hidden && n instanceof PDFRawStream && rect instanceof PDFArray) {
        const [x0, y0, x1, y1] = rect.asArray().map((v) => (lookup(doc, v) as unknown as { asNumber(): number }).asNumber());
        const bbArr = lookup(doc, n.dict.get(PDFName.of("BBox")));
        const bb = bbArr instanceof PDFArray ? bbArr.asArray().map((v) => (lookup(doc, v) as unknown as { asNumber(): number }).asNumber()) : [0, 0, x1 - x0, y1 - y0];
        const mArr = lookup(doc, n.dict.get(PDFName.of("Matrix")));
        const mm = mArr instanceof PDFArray ? mArr.asArray().map((v) => (lookup(doc, v) as unknown as { asNumber(): number }).asNumber()) : [1, 0, 0, 1, 0, 0];
        // Map the transformed BBox onto Rect (ISO 32000-1, 12.5.5), axis-aligned case.
        const tx = [bb[0], bb[2]].flatMap((x) => [bb[1], bb[3]].map((y) => [mm[0] * x + mm[2] * y + mm[4], mm[1] * x + mm[3] * y + mm[5]]));
        const bx0 = Math.min(...tx.map((p) => p[0])),
          bx1 = Math.max(...tx.map((p) => p[0])),
          by0 = Math.min(...tx.map((p) => p[1])),
          by1 = Math.max(...tx.map((p) => p[1]));
        const sx = bx1 - bx0 ? (Math.abs(x1 - x0) || 1) / (bx1 - bx0) : 1;
        const sy = by1 - by0 ? (Math.abs(y1 - y0) || 1) / (by1 - by0) : 1;
        const name = addPageResource(page, "XObject", "FFl", ctx.getObjectRef(n) ?? ctx.register(n));
        ops.push(`q ${sx} 0 0 ${sy} ${Math.min(x0, x1) - bx0 * sx} ${Math.min(y0, y1) - by0 * sy} cm /${name} Do Q`);
      }
    }
    if (ops.length) addContentStream(doc, page, ctx.register(ctx.flateStream(`q\n${ops.join("\n")}\nQ`)));
    if (keep.length) page.node.set(PDFName.of("Annots"), ctx.obj(keep));
    else page.node.delete(PDFName.of("Annots"));
  });
}
