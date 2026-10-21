import { PDFDocument, loadPdfLib } from "../lib/pdflib";
import { openPdf, PasswordCancelled } from "../lib/pdfjs";
import { openDialog } from "../state/store";
import { buildPdf } from "../core/save";
import { imagesToPdf } from "./create";
import { isPdfBytes } from "../lib/util";
import { zipSync } from "fflate";

export interface CombineSource {
  id: string;
  name: string;
  kind: "pdf" | "image" | "open";
  /** File bytes (pdf/image) — for open documents the tab id is used instead. */
  bytes?: Uint8Array;
  file?: File;
  docId?: string;
  pageCount: number;
  /** Optional page range string; empty = all. */
  pages?: number[];
}

/** Decrypts (asking for the password) and returns a pdf-lib document. */
export async function loadForCopy(bytes: Uint8Array, name: string): Promise<PDFDocument | null> {
  try {
    const { pdf, password } = await openPdf(bytes, {
      onPassword: (reason) => new Promise((resolve) => openDialog("password", { fileName: name, reason, resolve })),
    });
    const info = (await pdf.getMetadata()).info as Record<string, unknown>;
    await pdf.loadingTask.destroy();
    return await loadPdfLib(bytes, info.EncryptFilterName ? (password ?? "") : undefined);
  } catch (e) {
    if (e instanceof PasswordCancelled) return null;
    throw e;
  }
}

/** Merges sources in order. Comments in open documents and files are kept (as annotations). */
export async function combine(sources: CombineSource[], progress?: (p: number, d?: string) => void): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  let i = 0;
  for (const s of sources) {
    progress?.(i++ / sources.length, s.name);
    let src: PDFDocument | null = null;
    if (s.kind === "open" && s.docId) src = await loadPdfLib(await buildPdf(s.docId, { security: "none" }));
    else if (s.kind === "image" && s.file) src = await loadPdfLib(await imagesToPdf([s.file], { pageSize: "fit", margin: 0 }));
    else if (s.bytes && isPdfBytes(s.bytes)) src = await loadForCopy(s.bytes, s.name);
    if (!src) continue;
    const indices = s.pages?.length ? s.pages : src.getPageIndices();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
  }
  out.setCreator("Quillmark");
  return out.save();
}

export type SplitMode =
  | { kind: "every"; pages: number }
  | { kind: "files"; files: number }
  | { kind: "ranges"; ranges: number[][] }
  | { kind: "bookmarks"; starts: { index: number; title: string }[] }
  | { kind: "size"; maxBytes: number };

/** Computes page groups for a split. */
export function splitGroups(mode: SplitMode, pageCount: number): { pages: number[]; title?: string }[] {
  switch (mode.kind) {
    case "every": {
      const out: { pages: number[] }[] = [];
      for (let i = 0; i < pageCount; i += Math.max(1, mode.pages)) out.push({ pages: Array.from({ length: Math.min(mode.pages, pageCount - i) }, (_, k) => i + k) });
      return out;
    }
    case "files": {
      // As even as possible: the first files take one page more when the pages don't divide evenly.
      const files = Math.min(Math.max(1, Math.round(mode.files)), pageCount);
      const out: { pages: number[] }[] = [];
      for (let f = 0, start = 0; f < files; f++) {
        const size = Math.floor(pageCount / files) + (f < pageCount % files ? 1 : 0);
        out.push({ pages: Array.from({ length: size }, (_, k) => start + k) });
        start += size;
      }
      return out;
    }
    case "ranges":
      return mode.ranges.filter((r) => r.length).map((pages) => ({ pages }));
    case "bookmarks": {
      const starts = [...mode.starts].sort((a, b) => a.index - b.index);
      if (!starts.length || starts[0].index > 0) starts.unshift({ index: 0, title: "Front matter" });
      return starts
        .map((s, k) => ({
          title: s.title,
          pages: Array.from({ length: (starts[k + 1]?.index ?? pageCount) - s.index }, (_, j) => s.index + j),
        }))
        .filter((g) => g.pages.length);
    }
    case "size":
      return [{ pages: Array.from({ length: pageCount }, (_, i) => i) }];
  }
}

/** Splits by an approximate maximum file size by measuring page-by-page. */
export async function splitBySize(docId: string, pageCount: number, maxBytes: number, progress?: (p: number) => void): Promise<number[][]> {
  const groups: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < pageCount; i++) {
    progress?.(i / pageCount);
    const trial = [...cur, i];
    const size = (await buildPdf(docId, { pageIndices: trial, security: "none" })).length;
    if (size > maxBytes && cur.length) {
      groups.push(cur);
      cur = [i];
    } else cur = trial;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function zipFiles(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const f of files) {
    let name = f.name.replace(/[\\/:*?"<>|]/g, "_");
    let n = 2;
    while (used.has(name)) name = f.name.replace(/(\.[^.]+)?$/, ` (${n++})$1`);
    used.add(name);
    entries[name] = f.bytes;
  }
  return zipSync(entries, { level: 0 });
}
