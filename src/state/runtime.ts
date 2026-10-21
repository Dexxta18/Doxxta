import type { EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import type { Annotation } from "../annotations/types";
import type { OutlineNode, PageMeta } from "./types";

/** Imperative API of a mounted viewer, used by toolbars, panels and shortcuts. */
export interface ViewerHandle {
  container: HTMLDivElement;
  pdfViewer: PDFViewer;
  eventBus: EventBus;
  linkService: PDFLinkService;
  findController: PDFFindController;
  goToPage(page: number): void;
  nextPage(): void;
  prevPage(): void;
  zoomIn(): void;
  zoomOut(): void;
  setScale(value: string | number): void;
  rotateView(delta: number): void;
  setScrollMode(mode: number): void;
  setSpreadMode(mode: number): void;
  /** Scrolls so that a point (PDF user space) on a page is visible. */
  scrollToPoint(pageIndex: number, x: number, y: number, opts?: { center?: boolean }): void;
  /** Opens a page view like an /XYZ destination (PDF user space; null keeps the current value). */
  goToDestination(pageIndex: number, view: { left: number | null; top: number | null; zoom: number | null }): void;
  getPageDiv(pageIndex: number): HTMLDivElement | null;
  getVisiblePageIndexes(): number[];
  refreshOptionalContent(): Promise<void>;
  /** Re-renders the canvases (e.g. after page theme changes). */
  refresh(): void;
}

export interface DocSnapshot {
  bytes: Uint8Array;
  pages: PageMeta[];
  annotations: Annotation[];
  outline: OutlineNode[] | null;
  outlineDirty: boolean;
}

export type HistoryEntry =
  | { kind: "annots"; label: string; before: Annotation[]; after: Annotation[]; key?: string; at: number }
  | { kind: "doc"; label: string; before: DocSnapshot; after: DocSnapshot; at: number };

export interface DocRuntime {
  /** Bytes currently loaded in pdf.js (imported annotations stripped, decrypted). */
  bytes: Uint8Array;
  /** The file as opened, for "Revert". */
  originalBytes: Uint8Array;
  pdf: PDFDocumentProxy;
  history: { undo: HistoryEntry[]; redo: HistoryEntry[] };
  viewer: ViewerHandle | null;
  fileHandle: FileSystemFileHandle | null;
  /** pdf.js form scripting manager (one per document, re-attached to new viewers). */
  scripting: unknown | null;
  /** Map of pdf.js text-layer fingerprints etc. that tools may cache per document version. */
  cache: Map<string, unknown>;
}

export const runtimes = new Map<string, DocRuntime>();

export function getRuntime(id: string | null | undefined): DocRuntime | undefined {
  return id ? runtimes.get(id) : undefined;
}

export function getViewer(id: string | null | undefined): ViewerHandle | null {
  return (id && runtimes.get(id)?.viewer) || null;
}
