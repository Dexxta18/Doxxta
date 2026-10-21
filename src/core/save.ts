import { getRuntime } from "../state/runtime";
import { getDoc, toast, updateDoc, withBusy } from "../state/store";
import type { OutlineNode, SecurityInfo } from "../state/types";
import { FontCache, PDFName, PDFRef, loadPdfLib, pdfText, type PDFDocument } from "../lib/pdflib";
import { writeAnnotations } from "../annotations/writer";
import { hexToPdf } from "../lib/colors";
import { downloadBytes, errorMessage, withExt } from "../lib/util";
import { pdfjs } from "../lib/pdfjs";

export interface BuildOptions {
  /** Draw annotations into the page content. */
  flattenAnnotations?: boolean;
  /** Draw form fields into the page content. */
  flattenForms?: boolean;
  /** Leave Folio annotations out entirely (e.g. "print document only"). */
  omitAnnotations?: boolean;
  /** Keep only these pages (0-based, in this order). */
  pageIndices?: number[];
  /** Override protection: "keep" (default) re-applies the original security. */
  security?: "keep" | "none" | SecurityInfo["pending"];
}

/** Bytes with the current form-field values written in (pdf.js), without touching rt.bytes. */
async function formBytes(docId: string): Promise<Uint8Array> {
  const rt = getRuntime(docId)!;
  const doc = getDoc(docId)!;
  if (!doc.formDirty && rt.pdf.annotationStorage.size === 0) return rt.bytes;
  return new Uint8Array(await rt.pdf.saveDocument());
}

/** Produces the final PDF for saving/exporting with all edits applied. */
export async function buildPdf(docId: string, opts: BuildOptions = {}): Promise<Uint8Array> {
  const doc = getDoc(docId);
  const rt = getRuntime(docId);
  if (!doc || !rt) throw new Error("Document is not open");
  const pdfDoc = await loadPdfLib(await formBytes(docId));
  const fonts = new FontCache(pdfDoc);
  const pageIds = doc.pages.map((p) => p.id);

  const edits = doc.annotations.filter((a) => a.kind === "textedit");
  if (edits.length) {
    const { applyTextEdits } = await import("../ops/textEdit");
    await applyTextEdits(pdfDoc, edits as never, pageIds, fonts);
  }
  const fields = doc.annotations.filter((a) => a.kind === "field");
  if (fields.length) {
    const { writeFormFields } = await import("../ops/formFields");
    await writeFormFields(pdfDoc, fields as never, pageIds, fonts);
  }
  if (!opts.omitAnnotations) {
    await writeAnnotations(pdfDoc, doc.annotations, pageIds, { flattenAll: opts.flattenAnnotations, fonts });
  }
  if (doc.outlineDirty && doc.outline) writeOutline(pdfDoc, doc.outline, pageIds);
  if (doc.metadataDirty && doc.metadata) {
    const m = doc.metadata;
    pdfDoc.setTitle(m.title);
    pdfDoc.setAuthor(m.author);
    pdfDoc.setSubject(m.subject);
    pdfDoc.setKeywords(m.keywords ? m.keywords.split(/\s*[,;]\s*/).filter(Boolean) : []);
    pdfDoc.setCreator(m.creator);
    if (m.language) pdfDoc.setLanguage(m.language);
    // The XMP packet would otherwise contradict the edited Info dictionary.
    pdfDoc.catalog.delete(PDFName.of("Metadata"));
    if (m.pageLayout) pdfDoc.catalog.set(PDFName.of("PageLayout"), PDFName.of(m.pageLayout));
    if (m.pageMode) pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of(m.pageMode));
  }
  if (doc.attachmentsDirty && doc.attachments) {
    for (const a of doc.attachments) {
      if (a.removed && !a.pending) {
        try {
          pdfDoc.detach(a.filename);
        } catch (e) {
          console.warn("detach failed", e);
        }
      }
      if (a.pending && !a.removed && a.content) await pdfDoc.attach(a.content, a.filename, { description: a.description, creationDate: new Date(), modificationDate: new Date() });
    }
  }
  if (opts.flattenForms) {
    try {
      pdfDoc.getForm().flatten();
    } catch (e) {
      console.warn("form flatten failed", e);
    }
  }
  if (opts.pageIndices) {
    const keep = new Set(opts.pageIndices);
    for (let i = pdfDoc.getPageCount() - 1; i >= 0; i--) if (!keep.has(i)) pdfDoc.removePage(i);
    reorderPages(pdfDoc, opts.pageIndices.filter((i, n, arr) => arr.indexOf(i) === n));
  }
  pdfDoc.setModificationDate(new Date());
  if (!pdfDoc.getProducer()) pdfDoc.setProducer("Folio PDF");

  applySecurity(pdfDoc, doc.security, opts.security ?? "keep");
  return pdfDoc.save({ useObjectStreams: true });
}

/** After removing pages, put the remaining ones in the requested order. */
function reorderPages(pdfDoc: PDFDocument, order: number[]) {
  const sorted = [...order].sort((a, b) => a - b);
  if (sorted.every((v, i) => v === order[i])) return;
  const pages = pdfDoc.getPages();
  const byOriginal = new Map(sorted.map((orig, i) => [orig, pages[i]]));
  for (let i = pages.length - 1; i >= 0; i--) pdfDoc.removePage(i);
  for (const orig of order) {
    const p = byOriginal.get(orig);
    if (p) pdfDoc.addPage(p);
  }
}

const PERM = (pdfjs as unknown as { PermissionFlag: Record<string, number> }).PermissionFlag;

function applySecurity(pdfDoc: PDFDocument, sec: SecurityInfo, mode: BuildOptions["security"]) {
  const pending = mode === "keep" ? sec.pending : mode === "none" ? { kind: "remove" as const } : mode;
  if (pending?.kind === "remove") return;
  if (pending?.kind === "encrypt") {
    pdfDoc.encrypt({
      userPassword: pending.userPassword,
      ownerPassword: pending.ownerPassword || pending.userPassword || randomPassword(),
      permissions: pending.permissions as never,
      algorithm: pending.algorithm as never,
    });
    return;
  }
  if (!sec.encrypted) return;
  // Re-apply the original protection with the same open password and restrictions.
  const allowed = sec.permissions ? new Set(sec.permissions) : null;
  const has = (flag: string) => !allowed || allowed.has(PERM[flag]);
  pdfDoc.encrypt({
    userPassword: sec.password ?? "",
    ownerPassword: allowed ? randomPassword() : sec.password || randomPassword(),
    permissions: {
      printing: has("PRINT") ? (has("PRINT_HIGH_QUALITY") ? "highResolution" : "lowResolution") : false,
      modifying: has("MODIFY_CONTENTS"),
      copying: has("COPY"),
      annotating: has("MODIFY_ANNOTATIONS"),
      fillingForms: has("FILL_INTERACTIVE_FORMS"),
      contentAccessibility: has("COPY_FOR_ACCESSIBILITY"),
      documentAssembly: has("ASSEMBLE"),
    },
  });
}

function randomPassword() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a));
}

export function writeOutline(pdfDoc: PDFDocument, nodes: OutlineNode[], pageIds: string[]) {
  const ctx = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const pageRef = new Map(pageIds.map((id, i) => [id, pages[i]?.ref]));
  if (!nodes.length) {
    pdfDoc.catalog.delete(PDFName.of("Outlines"));
    return;
  }
  const rootRef = ctx.nextRef();
  const count = (ns: OutlineNode[]): number => ns.reduce((s, n) => s + 1 + count(n.children), 0);
  const writeLevel = (ns: OutlineNode[], parent: PDFRef): { first: PDFRef; last: PDFRef } => {
    const refs = ns.map(() => ctx.nextRef());
    ns.forEach((n, i) => {
      const dict: Record<string, unknown> = { Title: pdfText(n.title), Parent: parent };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < ns.length - 1) dict.Next = refs[i + 1];
      if (n.children.length) {
        const { first, last } = writeLevel(n.children, refs[i]);
        dict.First = first;
        dict.Last = last;
        dict.Count = count(n.children);
      }
      const pr = n.pageId ? pageRef.get(n.pageId) : undefined;
      if (pr) dict.Dest = [pr, PDFName.of("XYZ"), null, n.top ?? null, null];
      else if (n.url) dict.A = { Type: "Action", S: "URI", URI: pdfText(n.url) };
      if (n.color) dict.C = hexToPdf(n.color);
      const flags = (n.italic ? 1 : 0) | (n.bold ? 2 : 0);
      if (flags) dict.F = flags;
      ctx.assign(refs[i], ctx.obj(dict as never));
    });
    return { first: refs[0], last: refs[refs.length - 1] };
  };
  const { first, last } = writeLevel(nodes, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: first, Last: last, Count: count(nodes) }));
  pdfDoc.catalog.set(PDFName.of("Outlines"), rootRef);
}

function markSaved(docId: string, bytes: Uint8Array, name?: string) {
  const rt = getRuntime(docId);
  if (rt) rt.originalBytes = bytes;
  updateDoc(docId, (d) => ({
    dirty: false,
    savedAt: new Date().toISOString(),
    fileSize: bytes.length,
    name: name ?? d.name,
    security: { ...d.security, pending: undefined, ...(d.security.pending?.kind === "remove" ? { encrypted: false, permissions: null, password: undefined } : {}), ...(d.security.pending?.kind === "encrypt" ? { encrypted: true, password: d.security.pending.userPassword } : {}) },
  }));
}

async function writeToHandle(handle: FileSystemFileHandle, bytes: Uint8Array) {
  const h = handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream>; requestPermission?(o: object): Promise<string> };
  if (h.requestPermission) {
    const perm = await h.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") throw new Error("Permission to write the file was denied");
  }
  const w = await h.createWritable();
  await w.write(bytes as unknown as FileSystemWriteChunkType);
  await w.close();
}

/** Save: writes back to the opened file when possible, otherwise downloads. */
export async function saveDocument(docId: string): Promise<boolean> {
  const doc = getDoc(docId);
  const rt = getRuntime(docId);
  if (!doc || !rt) return false;
  const ok = await withBusy("Saving…", async () => {
    const bytes = await buildPdf(docId);
    if (rt.fileHandle) {
      try {
        await writeToHandle(rt.fileHandle, bytes);
        markSaved(docId, bytes);
        toast(`Saved “${doc.name}”`, "success");
        return true;
      } catch (e) {
        console.warn("In-place save failed, downloading instead", e);
      }
    }
    downloadBytes(bytes, doc.name);
    markSaved(docId, bytes);
    toast(`Downloaded “${doc.name}”`, "success");
    return true;
  });
  return !!ok;
}

/** Save as: lets the user pick a location (or downloads under a new name). */
export async function saveDocumentAs(docId: string, name: string, opts: BuildOptions = {}): Promise<boolean> {
  const doc = getDoc(docId);
  const rt = getRuntime(docId);
  if (!doc || !rt) return false;
  const fileName = /\.pdf$/i.test(name) ? name : withExt(name, "pdf");
  const w = window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> };
  let handle: FileSystemFileHandle | null = null;
  if (w.showSaveFilePicker) {
    try {
      handle = await w.showSaveFilePicker({ suggestedName: fileName, types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }] });
    } catch (e) {
      if ((e as Error).name === "AbortError") return false;
    }
  }
  const ok = await withBusy("Saving…", async () => {
    const bytes = await buildPdf(docId, opts);
    if (handle) {
      try {
        await writeToHandle(handle, bytes);
        rt.fileHandle = handle;
        markSaved(docId, bytes, handle.name);
        updateDoc(docId, { canSaveInPlace: true });
        toast(`Saved as “${handle.name}”`, "success");
        return true;
      } catch (e) {
        toast(`Couldn't write the file: ${errorMessage(e)}. Downloading instead.`, "warning");
      }
    }
    downloadBytes(bytes, fileName);
    markSaved(docId, bytes, fileName);
    return true;
  });
  return !!ok;
}
