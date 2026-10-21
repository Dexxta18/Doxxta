import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, degrees, loadPdfLib, type PDFPage } from "../lib/pdflib";
import { applyDocumentChange, openGenerated } from "../core/document";
import { getDoc, openDialog, toast, withBusy } from "../state/store";
import type { Annotation } from "../annotations/types";
import { baseName, nowIso, uid } from "../lib/util";
import { buildPdf } from "../core/save";
import { formatPageRanges } from "../lib/pageRanges";
import { importAnnotations } from "../annotations/importer";
import { openPdf, PasswordCancelled } from "../lib/pdfjs";

const sortDesc = (a: number[]) => [...new Set(a)].sort((x, y) => y - x);

export async function rotatePages(docId: string, indices: number[], delta: number) {
  if (!indices.length) return;
  await applyDocumentChange(docId, indices.length > 1 ? `Rotate ${indices.length} pages` : "Rotate page", async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    for (const i of new Set(indices)) {
      const p = doc.getPage(i);
      p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
    }
    return { bytes: await doc.save(), pageIds };
  });
}

export async function deletePages(docId: string, indices: number[]) {
  const d = getDoc(docId);
  if (!d || !indices.length) return;
  if (new Set(indices).size >= d.pages.length) {
    toast("A document must keep at least one page", "warning");
    return;
  }
  await applyDocumentChange(docId, indices.length > 1 ? `Delete ${indices.length} pages` : "Delete page", async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    for (const i of sortDesc(indices)) doc.removePage(i);
    const gone = new Set(indices);
    return { bytes: await doc.save(), pageIds: pageIds.filter((_, i) => !gone.has(i)) };
  });
}

/** Rebuilds the page order. `order[k]` is the old index of the page that ends up at position k. */
function applyOrder(doc: PDFDocument, order: number[]) {
  const pages = doc.getPages();
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  for (const i of order) doc.addPage(pages[i]);
}

/** Moves the given pages so they start at `target` (an index in the current order). */
export async function movePages(docId: string, indices: number[], target: number) {
  const d = getDoc(docId);
  if (!d || !indices.length) return;
  const moving = [...new Set(indices)].sort((a, b) => a - b);
  const set = new Set(moving);
  const rest = d.pages.map((_, i) => i).filter((i) => !set.has(i));
  // Position among the remaining pages.
  const insertAt = rest.filter((i) => i < target).length;
  const order = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
  if (order.every((v, i) => v === i)) return;
  await reorderPages(docId, order, moving.length > 1 ? `Move ${moving.length} pages` : "Move page");
}

export async function reorderPages(docId: string, order: number[], label = "Reorder pages") {
  await applyDocumentChange(docId, label, async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    applyOrder(doc, order);
    return { bytes: await doc.save(), pageIds: order.map((i) => pageIds[i]) };
  });
}

export async function reversePages(docId: string) {
  const d = getDoc(docId);
  if (!d) return;
  await reorderPages(docId, d.pages.map((_, i) => d.pages.length - 1 - i), "Reverse pages");
}

function pageSizeOf(doc: PDFDocument, index: number): [number, number] {
  const p = doc.getPage(Math.max(0, Math.min(index, doc.getPageCount() - 1)));
  const { width, height } = p.getSize();
  const r = p.getRotation().angle % 180 !== 0;
  return r ? [height, width] : [width, height];
}

export async function insertBlankPages(docId: string, at: number, count = 1, size?: [number, number]) {
  await applyDocumentChange(docId, count > 1 ? `Insert ${count} blank pages` : "Insert blank page", async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    const sz = size ?? pageSizeOf(doc, at > 0 ? at - 1 : 0);
    const ids = [...pageIds];
    for (let k = 0; k < count; k++) {
      doc.insertPage(at + k, sz);
      ids.splice(at + k, 0, uid("p"));
    }
    return { bytes: await doc.save(), pageIds: ids };
  });
}

function cloneAnnotsForPage(annots: Annotation[], fromPageId: string, toPageId: string): Annotation[] {
  const now = nowIso();
  return annots
    .filter((a) => a.pageId === fromPageId)
    .map((a) => ({ ...structuredClone(a), id: uid("a"), pageId: toPageId, createdAt: now, modifiedAt: now }));
}

export async function duplicatePages(docId: string, indices: number[]) {
  if (!indices.length) return;
  await applyDocumentChange(docId, indices.length > 1 ? `Duplicate ${indices.length} pages` : "Duplicate page", async ({ bytes, pageIds, annotations }) => {
    const doc = await loadPdfLib(bytes);
    const ids = [...pageIds];
    const extra: Annotation[] = [];
    for (const i of sortDesc(indices)) {
      const [copy] = await doc.copyPages(doc, [i]);
      doc.insertPage(i + 1, copy);
      const newId = uid("p");
      ids.splice(i + 1, 0, newId);
      extra.push(...cloneAnnotsForPage(annotations, pageIds[i], newId));
    }
    return { bytes: await doc.save(), pageIds: ids, annotations: [...annotations, ...extra] };
  });
}

/** Extracts pages (with their comments) into a new document tab. */
export async function extractToNewDocument(docId: string, indices: number[], opts: { deleteAfter?: boolean; separate?: boolean } = {}) {
  const d = getDoc(docId);
  if (!d || !indices.length) return;
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  await withBusy("Extracting pages…", async () => {
    if (opts.separate) {
      for (const i of sorted) {
        const bytes = await buildPdf(docId, { pageIndices: [i], security: "none" });
        await openGenerated(bytes, `${baseName(d.name)} - page ${i + 1}.pdf`);
      }
    } else {
      const bytes = await buildPdf(docId, { pageIndices: sorted, security: "none" });
      await openGenerated(bytes, `${baseName(d.name)} - pages ${formatPageRanges(sorted)}.pdf`);
    }
  });
  if (opts.deleteAfter) {
    const { useApp } = await import("../state/store");
    useApp.setState({ activeId: docId });
    await deletePages(docId, sorted);
  }
}

/** Loads another PDF for inserting, asking for its password when needed. */
export async function loadSourcePdf(bytes: Uint8Array, name: string): Promise<{ bytes: Uint8Array; annotations: { pageIndex: number; annot: Annotation }[] } | null> {
  let password: string | undefined;
  try {
    const { pdf, password: pw } = await openPdf(bytes, {
      onPassword: (reason) => new Promise((resolve) => openDialog("password", { fileName: name, reason, resolve })),
    });
    password = pw;
    const encrypted = !!(await pdf.getMetadata().then((m) => (m.info as Record<string, unknown>).EncryptFilterName).catch(() => null));
    await pdf.loadingTask.destroy();
    const res = await importAnnotations(bytes, encrypted ? (password ?? "") : undefined);
    return { bytes: res.bytes, annotations: res.annotations };
  } catch (e) {
    if (e instanceof PasswordCancelled) return null;
    throw e;
  }
}

/** Inserts pages of other PDFs (and images) at `at`. */
export async function insertFromFiles(docId: string, at: number, sources: { name: string; bytes: Uint8Array; pages?: number[] }[]) {
  const loaded: { bytes: Uint8Array; annotations: { pageIndex: number; annot: Annotation }[]; pages?: number[] }[] = [];
  for (const s of sources) {
    const l = await loadSourcePdf(s.bytes, s.name);
    if (l) loaded.push({ ...l, pages: s.pages });
  }
  if (!loaded.length) return;
  await applyDocumentChange(docId, "Insert pages", async ({ bytes, pageIds, annotations }) => {
    const doc = await loadPdfLib(bytes);
    const ids = [...pageIds];
    const extra: Annotation[] = [];
    let pos = at;
    for (const src of loaded) {
      const srcDoc = await loadPdfLib(src.bytes);
      const indices = src.pages ?? srcDoc.getPageIndices();
      const copies = await doc.copyPages(srcDoc, indices);
      copies.forEach((p: PDFPage, k: number) => {
        doc.insertPage(pos, p);
        const newId = uid("p");
        ids.splice(pos, 0, newId);
        pos++;
        for (const a of src.annotations.filter((x) => x.pageIndex === indices[k])) extra.push({ ...a.annot, id: uid("a"), pageId: newId });
      });
    }
    return { bytes: await doc.save(), pageIds: ids, annotations: [...annotations, ...extra] };
  });
}

/** Replaces pages `targets` with pages from another document (one-to-one, in order). */
export async function replacePages(docId: string, targets: number[], source: { name: string; bytes: Uint8Array; pages: number[] }) {
  const src = await loadSourcePdf(source.bytes, source.name);
  if (!src) return;
  const n = Math.min(targets.length, source.pages.length);
  await applyDocumentChange(docId, "Replace pages", async ({ bytes, pageIds, annotations }) => {
    const doc = await loadPdfLib(bytes);
    const srcDoc = await loadPdfLib(src.bytes);
    const copies = await doc.copyPages(srcDoc, source.pages.slice(0, n));
    const ids = [...pageIds];
    const extra: Annotation[] = [];
    for (let k = 0; k < n; k++) {
      const i = targets[k];
      doc.removePage(i);
      doc.insertPage(i, copies[k]);
      const newId = uid("p");
      ids[i] = newId;
      for (const a of src.annotations.filter((x) => x.pageIndex === source.pages[k])) extra.push({ ...a.annot, id: uid("a"), pageId: newId });
    }
    return { bytes: await doc.save(), pageIds: ids, annotations: [...annotations, ...extra] };
  });
}

export interface CropSpec {
  /** Margins to trim, in points, measured on the page as displayed. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Sets the CropBox of pages by trimming margins from the visible area. */
export async function cropPages(docId: string, indices: number[], spec: CropSpec | { rect: [number, number, number, number] }) {
  await applyDocumentChange(docId, indices.length > 1 ? `Crop ${indices.length} pages` : "Crop page", async ({ bytes, pageIds }) => {
    const doc = await loadPdfLib(bytes);
    for (const i of new Set(indices)) {
      const p = doc.getPage(i);
      if ("rect" in spec) {
        const [x1, y1, x2, y2] = spec.rect;
        p.setCropBox(x1, y1, x2 - x1, y2 - y1);
        continue;
      }
      const cb = p.getCropBox();
      // Map displayed margins to user space according to the page rotation.
      const r = p.getRotation().angle % 360;
      // (/Rotate 90 shows user-space left at the top, bottom at the left, etc.)
      const m =
        r === 90
          ? { l: spec.top, r: spec.bottom, b: spec.left, t: spec.right }
          : r === 180
            ? { l: spec.right, r: spec.left, b: spec.top, t: spec.bottom }
            : r === 270
              ? { l: spec.bottom, r: spec.top, b: spec.right, t: spec.left }
              : { l: spec.left, r: spec.right, b: spec.bottom, t: spec.top };
      const w = Math.max(10, cb.width - m.l - m.r);
      const h = Math.max(10, cb.height - m.b - m.t);
      p.setCropBox(cb.x + m.l, cb.y + m.b, w, h);
    }
    return { bytes: await doc.save(), pageIds };
  });
}

/** Resizes pages to a paper size, scaling content to fit (Acrobat "Scale to page"). */
export async function resizePages(docId: string, indices: number[], size: [number, number]) {
  await applyDocumentChange(docId, "Resize pages", async ({ bytes, pageIds, annotations }) => {
    const doc = await loadPdfLib(bytes);
    const moves = new Map<string, { from: [number, number, number, number]; to: [number, number, number, number] }>();
    for (const i of new Set(indices)) {
      const p = doc.getPage(i);
      const mb = p.getMediaBox();
      const s = Math.min(size[0] / mb.width, size[1] / mb.height);
      const nw = mb.width * s,
        nh = mb.height * s;
      const dx = (size[0] - nw) / 2,
        dy = (size[1] - nh) / 2;
      // Each call wraps the existing content, so the last call is applied last:
      // p' = s * (p - origin) + (dx, dy).
      p.translateContent(-mb.x, -mb.y);
      p.scaleContent(s, s);
      p.translateContent(dx, dy);
      p.setMediaBox(0, 0, size[0], size[1]);
      p.setCropBox(0, 0, size[0], size[1]);
      // Native annotations (links, form widgets) follow the content.
      const annots = p.node.Annots();
      for (let k = 0; annots && k < annots.size(); k++) {
        const a = doc.context.lookup(annots.get(k));
        if (!(a instanceof PDFDict)) continue;
        const rect = a.lookupMaybe(PDFName.of("Rect"), PDFArray);
        if (!rect || rect.size() !== 4) continue;
        const v = rect.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0));
        a.set(PDFName.of("Rect"), doc.context.obj([s * (v[0] - mb.x) + dx, s * (v[1] - mb.y) + dy, s * (v[2] - mb.x) + dx, s * (v[3] - mb.y) + dy]));
      }
      moves.set(pageIds[i], { from: [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height], to: [dx, dy, dx + nw, dy + nh] });
    }
    const { transformAnnot } = await import("../annotations/geometry");
    const next = annotations.map((a) => {
      const mv = moves.get(a.pageId);
      return mv ? transformAnnot(a, mv.from, mv.to) : a;
    });
    return { bytes: await doc.save(), pageIds, annotations: next };
  });
}
