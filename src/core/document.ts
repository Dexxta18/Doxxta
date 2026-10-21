import { openPdf, pdfjs, PasswordCancelled, type PDFDocumentProxy } from "../lib/pdfjs";
import { getRuntime, runtimes, type DocSnapshot } from "../state/runtime";
import { DEFAULT_VIEW, EMPTY_FIND, getApp, getDoc, openDialog, toast, updateDoc, useApp } from "../state/store";
import type { DocMetadata, DocState, PageMeta, SecurityInfo } from "../state/types";
import { errorMessage, isPdfBytes, readFileBytes, uid } from "../lib/util";
import { useSettings } from "../state/settings";
import { pushHistory, syncHistoryFlags } from "../state/annotActions";
import { addRecentFile } from "../lib/recent";
import { desktopHandleFor } from "../lib/desktop";
import type { Annotation } from "../annotations/types";

/** Files up to this size are checked for a damaged page tree when opened (reading them takes a moment). */
const TREE_CHECK_LIMIT = 50 * 1024 * 1024;

/** Annotation subtypes that are lifted out of the file into the editable model. */
export const IMPORTABLE_PDFJS_TYPES = [
  pdfjs.AnnotationType.TEXT,
  pdfjs.AnnotationType.FREETEXT,
  pdfjs.AnnotationType.LINE,
  pdfjs.AnnotationType.SQUARE,
  pdfjs.AnnotationType.CIRCLE,
  pdfjs.AnnotationType.POLYGON,
  pdfjs.AnnotationType.POLYLINE,
  pdfjs.AnnotationType.HIGHLIGHT,
  pdfjs.AnnotationType.UNDERLINE,
  pdfjs.AnnotationType.SQUIGGLY,
  pdfjs.AnnotationType.STRIKEOUT,
  pdfjs.AnnotationType.INK,
  pdfjs.AnnotationType.STAMP,
  pdfjs.AnnotationType.REDACT,
];

/** Asks the user for a password through the password dialog. */
export function promptPassword(fileName: string) {
  return (reason: "need" | "incorrect") =>
    new Promise<string | null>((resolve) => {
      openDialog("password", { fileName, reason, resolve });
    });
}

async function readPageMetas(pdf: PDFDocumentProxy): Promise<PageMeta[]> {
  const labels = await pdf.getPageLabels().catch(() => null);
  const metas: PageMeta[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    metas.push({ id: uid("p"), view: [...page.view], rotate: page.rotate, userUnit: page.userUnit ?? 1, label: labels?.[i] ?? undefined });
  }
  return metas;
}

/** Re-reads page geometry after the bytes changed, keeping the given page ids. */
async function refreshPageMetas(pdf: PDFDocumentProxy, ids: string[]): Promise<PageMeta[]> {
  const fresh = await readPageMetas(pdf);
  return fresh.map((m, i) => ({ ...m, id: ids[i] ?? m.id }));
}

export async function readMetadata(pdf: PDFDocumentProxy): Promise<DocMetadata> {
  const { info, metadata } = (await pdf.getMetadata()) as { info: Record<string, unknown>; metadata: { get(k: string): string | null } | null };
  const markInfo = await pdf.getMarkInfo().catch(() => null);
  const str = (k: string) => (typeof info?.[k] === "string" ? (info[k] as string) : "");
  const xmp = (k: string) => metadata?.get(k) ?? "";
  return {
    title: str("Title") || xmp("dc:title"),
    author: str("Author") || xmp("dc:creator"),
    subject: str("Subject") || xmp("dc:description"),
    keywords: str("Keywords") || xmp("pdf:keywords"),
    creator: str("Creator") || xmp("xmp:creatortool"),
    producer: str("Producer") || xmp("pdf:producer"),
    creationDate: pdfDate(str("CreationDate")),
    modDate: pdfDate(str("ModDate")),
    pdfVersion: str("PDFFormatVersion") || "?",
    isLinearized: !!info?.IsLinearized,
    isTagged: !!markInfo?.Marked,
    encryptFilter: (info?.EncryptFilterName as string) || null,
    isAcroForm: !!info?.IsAcroFormPresent,
    isXfa: !!info?.IsXFAPresent,
    isSignatures: !!info?.IsSignaturesPresent,
    language: str("Language"),
  };
}

function pdfDate(s: string): string | null {
  if (!s) return null;
  const d = pdfjs.PDFDateString.toDateObject(s);
  return d ? d.toISOString() : null;
}

function newDocState(id: string, name: string, size: number): DocState {
  const settings = useSettings.getState();
  return {
    id,
    name,
    fileSize: size,
    version: 0,
    status: "loading",
    loadingMessage: "Opening…",
    pages: [],
    annotations: [],
    selection: [],
    dirty: false,
    formDirty: false,
    view: { ...DEFAULT_VIEW, scaleValue: settings.defaultZoom },
    mode: "view",
    outline: null,
    outlineDirty: false,
    metadata: null,
    metadataDirty: false,
    attachments: null,
    attachmentsDirty: false,
    security: { encrypted: false, filter: null, permissions: null },
    canUndo: false,
    canRedo: false,
    hasForms: false,
    find: { ...EMPTY_FIND },
    lockedAnnotationCount: 0,
    canSaveInPlace: false,
  };
}

export interface OpenOptions {
  fileHandle?: FileSystemFileHandle | null;
  /** Don't add to the recent files list (e.g. generated documents). */
  transient?: boolean;
  /** Start as modified (documents produced by tools that were never saved). */
  dirty?: boolean;
  activate?: boolean;
  password?: string;
}

export async function openFile(file: File, opts: OpenOptions = {}): Promise<string | null> {
  const bytes = await readFileBytes(file);
  // In the desktop app a dropped file is saved back to where it came from.
  return openBytes(bytes, file.name, { ...opts, fileHandle: opts.fileHandle ?? desktopHandleFor(file) });
}

/**
 * Opens PDF bytes in a new tab:
 *  1. pdf.js parses it (asking for a password if needed);
 *  2. if the file carries markup annotations (or is encrypted), they are
 *     lifted into the editable model and stripped from the working copy;
 *  3. the working copy is shown in the viewer.
 */
export async function openBytes(bytes: Uint8Array, name: string, opts: OpenOptions = {}): Promise<string | null> {
  if (!isPdfBytes(bytes)) {
    toast(`"${name}" is not a PDF file.`, "error");
    return null;
  }
  const id = uid("doc");
  const app = getApp();
  useApp.setState({
    docs: { ...app.docs, [id]: newDocState(id, name, bytes.length) },
    order: [...app.order, id],
    activeId: opts.activate === false ? app.activeId : id,
  });
  try {
    const { pdf: firstPdf, password } = await openPdf(bytes, { password: opts.password, onPassword: promptPassword(name) });
    let pdf = firstPdf;
    let workBytes = bytes;
    const statedPages = firstPdf.numPages;
    let annotations: Annotation[] = [];
    let lockedAnnotationCount = 0;

    const metadata = await readMetadata(pdf);
    const permissions = await pdf.getPermissions().catch(() => null);
    const security: SecurityInfo = {
      encrypted: !!metadata.encryptFilter,
      filter: metadata.encryptFilter,
      password: metadata.encryptFilter ? (password ?? "") : undefined,
      permissions: permissions ? [...permissions] : null,
    };

    const hasImportable = await pdf
      .getAnnotationsByType(new Set(IMPORTABLE_PDFJS_TYPES), new Set())
      .then((a) => a.length > 0)
      .catch(() => true);

    let pageIndexToId: string[] = [];
    if (hasImportable || security.encrypted) {
      updateDoc(id, { loadingMessage: security.encrypted ? "Decrypting…" : "Reading comments…" });
      const { importAnnotations } = await import("../annotations/importer");
      try {
        const res = await importAnnotations(bytes, security.encrypted ? (password ?? "") : undefined);
        if (res.changed) {
          workBytes = res.bytes;
          await pdf.loadingTask.destroy();
          pdf = (await openPdf(workBytes)).pdf;
        }
        pageIndexToId = Array.from({ length: pdf.numPages }, () => uid("p"));
        annotations = res.annotations.map((a) => ({ ...a.annot, pageId: pageIndexToId[a.pageIndex] }) as Annotation);
        lockedAnnotationCount = res.skipped;
      } catch (e) {
        console.warn("Annotation import failed; existing annotations stay read-only.", e);
        lockedAnnotationCount = -1;
      }
    } else if (bytes.length <= TREE_CHECK_LIMIT) {
      // pdf.js shows as many pages as the page tree says there are: repair a tree that counts too few.
      const { withRepairedPageTree } = await import("../lib/pdflib");
      const repaired = await withRepairedPageTree(bytes).catch(() => null);
      if (repaired) {
        const fixed = (await openPdf(repaired)).pdf;
        if (fixed.numPages !== pdf.numPages) {
          await pdf.loadingTask.destroy();
          pdf = fixed;
          workBytes = repaired;
        } else await fixed.loadingTask.destroy();
      }
    }

    const pages = await readPageMetas(pdf);
    if (pageIndexToId.length === pages.length) pages.forEach((p, i) => (p.id = pageIndexToId[i]));

    const fieldObjects = await pdf.getFieldObjects().catch(() => null);
    const hasForms = !!fieldObjects && fieldObjects.size > 0;

    runtimes.set(id, {
      bytes: workBytes,
      originalBytes: bytes,
      pdf,
      history: { undo: [], redo: [] },
      viewer: null,
      fileHandle: opts.fileHandle ?? null,
      scripting: null,
      cache: new Map(),
    });
    trackFormChanges(id, pdf);

    const last = useSettings.getState().restoreLastView ? useSettings.getState().lastViews[fingerprint(pdf, name)] : undefined;
    updateDoc(id, (d) => ({
      status: "ready",
      loadingMessage: undefined,
      pages,
      annotations,
      metadata,
      security,
      hasForms,
      lockedAnnotationCount,
      dirty: !!opts.dirty,
      canSaveInPlace: !!opts.fileHandle,
      view: last ? { ...d.view, page: Math.min(last.page, pages.length), scaleValue: last.scaleValue } : d.view,
      version: d.version + 1,
    }));
    if (!opts.transient) {
      addRecentFile({ name, bytes, fileHandle: opts.fileHandle ?? null, pageCount: pages.length, pdf }).catch((e) => console.warn("recent", e));
    }
    if (pages.length > statedPages) {
      toast(`“${name}” has ${pages.length} pages, but its page list was damaged and counted only ${statedPages} (other apps may show only those). Quillmark repaired it: save the file to keep the repair.`, "info", { timeout: 12000 });
    }
    return id;
  } catch (e) {
    if (e instanceof PasswordCancelled) {
      removeDoc(id);
      return null;
    }
    console.error(e);
    updateDoc(id, { status: "error", error: friendlyLoadError(e) });
    return id;
  }
}

function friendlyLoadError(e: unknown): string {
  const msg = errorMessage(e);
  if (/Invalid PDF/i.test(msg)) return "This file is damaged or is not a valid PDF.";
  if (/password/i.test(msg)) return "The document could not be decrypted.";
  return msg;
}

export function fingerprint(pdf: PDFDocumentProxy, name: string): string {
  return pdf.fingerprints?.[0] ?? name;
}

function trackFormChanges(id: string, pdf: PDFDocumentProxy) {
  (pdf.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => updateDoc(id, { formDirty: true, dirty: true });
}

function removeDoc(id: string) {
  useApp.setState((s) => {
    const docs = { ...s.docs };
    delete docs[id];
    const order = s.order.filter((d) => d !== id);
    let activeId = s.activeId;
    if (activeId === id) {
      const idx = s.order.indexOf(id);
      activeId = order[Math.min(idx, order.length - 1)] ?? null;
    }
    return { docs, order, activeId };
  });
}

export async function closeDocument(id: string, force = false): Promise<boolean> {
  const doc = getDoc(id);
  if (!doc) return true;
  if (!force && doc.dirty) {
    const choice = await new Promise<"save" | "discard" | "cancel">((resolve) =>
      openDialog("confirm-close", { name: doc.name, resolve }),
    );
    if (choice === "cancel") return false;
    if (choice === "save") {
      const { saveDocument } = await import("./save");
      const ok = await saveDocument(id);
      if (!ok) return false;
    }
  }
  const rt = getRuntime(id);
  if (rt) {
    try {
      rememberView(id);
      await rt.pdf.loadingTask.destroy();
    } catch {
      /* ignore */
    }
    runtimes.delete(id);
  }
  removeDoc(id);
  return true;
}

export function rememberView(id: string) {
  const doc = getDoc(id);
  const rt = getRuntime(id);
  if (!doc || !rt) return;
  const key = fingerprint(rt.pdf, doc.name);
  const views = { ...useSettings.getState().lastViews, [key]: { page: doc.view.page, scaleValue: doc.view.scaleValue } };
  const keys = Object.keys(views);
  if (keys.length > 200) delete views[keys[0]];
  useSettings.getState().set({ lastViews: views });
}

/**
 * Writes pending form-field values into the working bytes (pdf.js
 * `saveDocument`). Needed before any operation that reloads the document.
 */
export async function commitForms(id: string): Promise<Uint8Array> {
  const rt = getRuntime(id)!;
  const doc = getDoc(id)!;
  if (!doc.formDirty && rt.pdf.annotationStorage.size === 0) return rt.bytes;
  const bytes = await rt.pdf.saveDocument();
  rt.bytes = new Uint8Array(bytes);
  updateDoc(id, { formDirty: false });
  return rt.bytes;
}

/**
 * Replaces the document bytes (after a structural edit or undo) and reloads
 * the viewer, keeping page ids stable as described by `pageIds`.
 */
export async function reloadDocument(id: string, bytes: Uint8Array, pageIds: string[], extra: Partial<DocState> = {}) {
  const rt = getRuntime(id);
  if (!rt) return;
  const { pdf } = await openPdf(bytes);
  const old = rt.pdf;
  rt.bytes = bytes;
  rt.pdf = pdf;
  rt.cache.clear();
  trackFormChanges(id, pdf);
  const pages = await refreshPageMetas(pdf, pageIds);
  const fieldObjects = await pdf.getFieldObjects().catch(() => null);
  updateDoc(id, (d) => ({
    pages,
    hasForms: !!fieldObjects && fieldObjects.size > 0,
    formDirty: false,
    version: d.version + 1,
    view: { ...d.view, page: Math.min(d.view.page, pages.length) },
    ...extra,
  }));
  // Destroy the previous document after the viewer has switched over.
  setTimeout(() => old.loadingTask.destroy().catch(() => {}), 1000);
}

export function snapshot(id: string): DocSnapshot {
  const rt = getRuntime(id)!;
  const d = getDoc(id)!;
  return { bytes: rt.bytes, pages: d.pages, annotations: d.annotations, outline: d.outline, outlineDirty: d.outlineDirty };
}

export async function restoreSnapshot(id: string, s: DocSnapshot) {
  await reloadDocument(id, s.bytes, s.pages.map((p) => p.id), {
    annotations: s.annotations,
    outline: s.outline,
    outlineDirty: s.outlineDirty,
    selection: [],
    dirty: true,
  });
}

export interface StructuralResult {
  bytes: Uint8Array;
  pageIds: string[];
  annotations?: Annotation[];
  extra?: Partial<DocState>;
}

/**
 * Runs an operation that rewrites the PDF (organize pages, watermark, crop…):
 * form values are committed first, the result is loaded, and an undo step
 * holding both snapshots is recorded.
 */
export async function applyDocumentChange(
  id: string,
  label: string,
  op: (input: { bytes: Uint8Array; pageIds: string[]; annotations: Annotation[]; doc: DocState }) => Promise<StructuralResult>,
): Promise<boolean> {
  const doc = getDoc(id);
  if (!doc) return false;
  const committed = await commitForms(id);
  const before = { ...snapshot(id), bytes: committed };
  const res = await op({ bytes: committed, pageIds: doc.pages.map((p) => p.id), annotations: doc.annotations, doc });
  const kept = new Set(res.pageIds);
  const annotations = (res.annotations ?? doc.annotations).filter((a) => kept.has(a.pageId));
  await reloadDocument(id, res.bytes, res.pageIds, { annotations, dirty: true, selection: [], ...res.extra });
  const after = snapshot(id);
  pushHistory(id, { kind: "doc", label, before, after, at: Date.now() });
  return true;
}

export async function undo(id: string) {
  const rt = getRuntime(id);
  const entry = rt?.history.undo.pop();
  if (!rt || !entry) return;
  if (entry.kind === "annots") {
    updateDoc(id, (d) => ({ annotations: entry.before, dirty: true, selection: d.selection.filter((s) => entry.before.some((a) => a.id === s)) }));
  } else {
    await restoreSnapshot(id, entry.before);
  }
  rt.history.redo.push(entry);
  syncHistoryFlags(id);
}

export async function redo(id: string) {
  const rt = getRuntime(id);
  const entry = rt?.history.redo.pop();
  if (!rt || !entry) return;
  if (entry.kind === "annots") {
    updateDoc(id, (d) => ({ annotations: entry.after, dirty: true, selection: d.selection.filter((s) => entry.after.some((a) => a.id === s)) }));
  } else {
    await restoreSnapshot(id, entry.after);
  }
  rt.history.undo.push(entry);
  syncHistoryFlags(id);
}

/** Opens the bytes of a generated document (merge, split, conversions) in a new tab. */
export function openGenerated(bytes: Uint8Array, name: string) {
  return openBytes(bytes, name, { transient: true, dirty: true });
}

export async function revertDocument(id: string) {
  const rt = getRuntime(id);
  const doc = getDoc(id);
  if (!rt || !doc) return;
  const name = doc.name;
  const handle = rt.fileHandle;
  const original = rt.originalBytes;
  await closeDocument(id, true);
  await openBytes(original, name, { fileHandle: handle, transient: true });
}
