import { create } from "zustand";
import type { Annotation } from "../annotations/types";
import type { DocState, FindState, Mode, ToolId, ViewState } from "./types";
import { uid } from "../lib/util";

export interface Toast {
  id: string;
  kind: "info" | "success" | "error" | "warning";
  message: string;
  action?: { label: string; run: () => void };
  timeout?: number;
}

export interface BusyState {
  message: string;
  progress?: number;
  detail?: string;
  cancel?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export type ContextMenuItem =
  | { type: "item"; label: string; icon?: React.ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; run: () => void }
  | { type: "separator" };

export interface CompareSession {
  old: { name: string; bytes: Uint8Array };
  new: { name: string; bytes: Uint8Array };
  kind: "text" | "visual";
}

export interface DialogState {
  id: string;
  props?: Record<string, unknown>;
}

interface AppState {
  docs: Record<string, DocState>;
  order: string[];
  activeId: string | null;
  tool: ToolId;
  /** Tool to return to after a one-shot placement (signature, stamp…). */
  stickyTool: boolean;
  dialogs: DialogState[];
  toasts: Toast[];
  busy: BusyState | null;
  contextMenu: ContextMenuState | null;
  presentation: boolean;
  /** Compare Files session shown over the workspace. */
  compare: CompareSession | null;
  readMode: boolean;
  findBarOpen: boolean;
  speaking: boolean;
  /** Annotation currently being text-edited (free text / note popup). */
  editingId: string | null;
  /** Comment card focused in the comments panel. */
  focusCommentId: string | null;
}

export const EMPTY_FIND: FindState = {
  query: "",
  caseSensitive: false,
  entireWord: false,
  highlightAll: true,
  matchDiacritics: false,
  current: 0,
  total: 0,
  status: "idle",
};

export const DEFAULT_VIEW: ViewState = { page: 1, scale: 1, scaleValue: "auto", rotation: 0, scrollMode: 0, spreadMode: 0 };

export const useApp = create<AppState>()(() => ({
  docs: {},
  order: [],
  activeId: null,
  tool: "select",
  stickyTool: false,
  dialogs: [],
  toasts: [],
  busy: null,
  contextMenu: null,
  presentation: false,
  compare: null,
  readMode: false,
  findBarOpen: false,
  speaking: false,
  editingId: null,
  focusCommentId: null,
}));

export const getApp = () => useApp.getState();

export function getDoc(id: string | null | undefined): DocState | undefined {
  return id ? useApp.getState().docs[id] : undefined;
}

export function getActiveDoc(): DocState | undefined {
  const s = useApp.getState();
  return s.activeId ? s.docs[s.activeId] : undefined;
}

export function useActiveDoc(): DocState | undefined {
  return useApp((s) => (s.activeId ? s.docs[s.activeId] : undefined));
}

export function updateDoc(id: string, patch: Partial<DocState> | ((d: DocState) => Partial<DocState>)) {
  useApp.setState((s) => {
    const d = s.docs[id];
    if (!d) return s;
    const p = typeof patch === "function" ? patch(d) : patch;
    return { docs: { ...s.docs, [id]: { ...d, ...p } } };
  });
}

export function setView(id: string, patch: Partial<ViewState>) {
  updateDoc(id, (d) => ({ view: { ...d.view, ...patch } }));
}

export function setTool(tool: ToolId, sticky = false) {
  useApp.setState({ tool, stickyTool: sticky, editingId: null });
}

export function setMode(id: string, mode: Mode) {
  updateDoc(id, { mode, selection: [] });
  // Each workspace starts with its natural tool.
  const defaults: Partial<Record<Mode, ToolId>> = { view: "select", organize: "select", compare: "select" };
  setTool(defaults[mode] ?? "select");
}

export function selectAnnots(id: string, ids: string[]) {
  updateDoc(id, { selection: ids });
}

export function toast(message: string, kind: Toast["kind"] = "info", opts: Partial<Toast> = {}) {
  const t: Toast = { id: uid("t"), kind, message, timeout: kind === "error" ? 8000 : 4000, ...opts };
  useApp.setState((s) => ({ toasts: [...s.toasts.slice(-4), t] }));
  if (t.timeout) setTimeout(() => dismissToast(t.id), t.timeout);
  return t.id;
}

export function dismissToast(id: string) {
  useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function openDialog(id: string, props?: Record<string, unknown>) {
  useApp.setState((s) => ({ dialogs: [...s.dialogs.filter((d) => d.id !== id), { id, props }] }));
}

export function closeDialog(id?: string) {
  useApp.setState((s) => ({ dialogs: id ? s.dialogs.filter((d) => d.id !== id) : s.dialogs.slice(0, -1) }));
}

export function setBusy(busy: BusyState | null) {
  useApp.setState({ busy });
}

/** Runs a long task behind the busy overlay, reporting errors as toasts. */
export async function withBusy<T>(message: string, fn: (progress: (p: number, detail?: string) => void) => Promise<T>): Promise<T | undefined> {
  setBusy({ message });
  try {
    return await fn((progress, detail) => setBusy({ message, progress, detail }));
  } catch (e) {
    console.error(e);
    toast(e instanceof Error ? e.message : String(e), "error");
    return undefined;
  } finally {
    setBusy(null);
  }
}

export function openContextMenu(x: number, y: number, items: ContextMenuItem[]) {
  useApp.setState({ contextMenu: { x, y, items } });
}

export function closeContextMenu() {
  useApp.setState({ contextMenu: null });
}

export function docAnnotations(id: string): Annotation[] {
  return useApp.getState().docs[id]?.annotations ?? [];
}

export function setFind(id: string, patch: Partial<FindState>) {
  updateDoc(id, (d) => ({ find: { ...d.find, ...patch } }));
}
