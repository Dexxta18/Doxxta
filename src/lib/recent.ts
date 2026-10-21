import { createStore, del, get, set } from "idb-keyval";
import { create } from "zustand";
import type { PDFDocumentProxy } from "./pdfjs";
import { renderPageToCanvas } from "./pdfjs";
import { reviveFileHandle } from "./desktop";

/**
 * Recent files, stored in IndexedDB so they can be reopened without the
 * original file (bytes are kept for files up to MAX_BYTES; file handles are
 * kept where the File System Access API is available).
 */

export interface RecentEntry {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  openedAt: string;
  thumb?: string;
  hasBytes: boolean;
  hasHandle: boolean;
  starred?: boolean;
}

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 30;
const store = typeof indexedDB !== "undefined" ? createStore("quillmark", "recent") : undefined;

export const useRecent = create<{ entries: RecentEntry[]; loaded: boolean }>(() => ({ entries: [], loaded: false }));

export async function loadRecent() {
  if (!store) return;
  try {
    const entries = ((await get<RecentEntry[]>("index", store)) ?? []).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    useRecent.setState({ entries, loaded: true });
  } catch (e) {
    console.warn("Could not read recent files", e);
    useRecent.setState({ loaded: true });
  }
}

async function saveIndex(entries: RecentEntry[]) {
  useRecent.setState({ entries });
  if (store) await set("index", entries, store);
}

async function makeThumb(pdf: PDFDocumentProxy): Promise<string | undefined> {
  try {
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const canvas = await renderPageToCanvas(page, { scale: 180 / Math.max(vp.width, vp.height) });
    return canvas.toDataURL("image/jpeg", 0.75);
  } catch {
    return undefined;
  }
}

export async function addRecentFile(opts: {
  name: string;
  bytes: Uint8Array;
  fileHandle: FileSystemFileHandle | null;
  pageCount: number;
  pdf: PDFDocumentProxy;
}) {
  if (!store) return;
  const { entries } = useRecent.getState();
  const existing = entries.find((e) => e.name === opts.name && e.size === opts.bytes.length);
  const id = existing?.id ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const thumb = existing?.thumb ?? (await makeThumb(opts.pdf));
  const hasBytes = opts.bytes.length <= MAX_BYTES;
  if (hasBytes) await set(`bytes:${id}`, opts.bytes, store);
  if (opts.fileHandle) await set(`handle:${id}`, opts.fileHandle, store).catch(() => {});
  const entry: RecentEntry = {
    id,
    name: opts.name,
    size: opts.bytes.length,
    pageCount: opts.pageCount,
    openedAt: new Date().toISOString(),
    thumb,
    hasBytes: hasBytes || !!existing?.hasBytes,
    hasHandle: !!opts.fileHandle || !!existing?.hasHandle,
    starred: existing?.starred,
  };
  let next = [entry, ...entries.filter((e) => e.id !== id)];
  const dropped = next.slice(MAX_ENTRIES).filter((e) => !e.starred);
  next = next.filter((e) => !dropped.includes(e));
  for (const d of dropped) await forget(d.id);
  await saveIndex(next);
}

async function forget(id: string) {
  if (!store) return;
  await del(`bytes:${id}`, store).catch(() => {});
  await del(`handle:${id}`, store).catch(() => {});
}

export async function getRecentFile(id: string): Promise<{ bytes: Uint8Array; handle: FileSystemFileHandle | null } | null> {
  if (!store) return null;
  const handle = reviveFileHandle(await get(`handle:${id}`, store).catch(() => null));
  if (handle && "queryPermission" in handle) {
    try {
      const h = handle as FileSystemFileHandle & {
        queryPermission(o: object): Promise<string>;
        requestPermission(o: object): Promise<string>;
      };
      let perm = await h.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") perm = await h.requestPermission({ mode: "readwrite" });
      if (perm === "granted") {
        const file = await handle.getFile();
        return { bytes: new Uint8Array(await file.arrayBuffer()), handle };
      }
    } catch {
      /* fall back to cached bytes */
    }
  }
  const bytes = (await get(`bytes:${id}`, store)) as Uint8Array | undefined;
  return bytes ? { bytes, handle: null } : null;
}

export async function removeRecent(id: string) {
  await forget(id);
  await saveIndex(useRecent.getState().entries.filter((e) => e.id !== id));
}

export async function toggleStar(id: string) {
  await saveIndex(useRecent.getState().entries.map((e) => (e.id === id ? { ...e, starred: !e.starred } : e)));
}

export async function clearRecent() {
  for (const e of useRecent.getState().entries) if (!e.starred) await forget(e.id);
  await saveIndex(useRecent.getState().entries.filter((e) => e.starred));
}
