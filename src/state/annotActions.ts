import type { Annotation } from "../annotations/types";
import { getRuntime, type HistoryEntry } from "./runtime";
import { getDoc, updateDoc, useApp } from "./store";
import { nowIso } from "../lib/util";

const MAX_HISTORY = 200;

export function syncHistoryFlags(docId: string) {
  const rt = getRuntime(docId);
  if (!rt) return;
  const { undo, redo } = rt.history;
  updateDoc(docId, {
    canUndo: undo.length > 0,
    canRedo: redo.length > 0,
    undoLabel: undo[undo.length - 1]?.label,
    redoLabel: redo[redo.length - 1]?.label,
  });
}

export function pushHistory(docId: string, entry: HistoryEntry) {
  const rt = getRuntime(docId);
  if (!rt) return;
  const { undo } = rt.history;
  const last = undo[undo.length - 1];
  if (
    entry.kind === "annots" &&
    last?.kind === "annots" &&
    entry.key &&
    last.key === entry.key &&
    entry.at - last.at < 1200
  ) {
    // Coalesce rapid changes (slider drags, typing) into one undo step.
    last.after = entry.after;
    last.at = entry.at;
  } else {
    undo.push(entry);
    // Bound memory: whole-document snapshots are big, keep fewer of them.
    let docEntries = undo.filter((e) => e.kind === "doc").length;
    while (undo.length > MAX_HISTORY || docEntries > 20) {
      const removed = undo.shift();
      if (removed?.kind === "doc") docEntries--;
    }
  }
  rt.history.redo = [];
  syncHistoryFlags(docId);
}

function commitAnnotations(docId: string, next: Annotation[], label: string, key?: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  const before = doc.annotations;
  if (before === next) return;
  updateDoc(docId, { annotations: next, dirty: true });
  pushHistory(docId, { kind: "annots", label, before, after: next, key, at: Date.now() });
}

export function addAnnotations(docId: string, annots: Annotation[], label = "Add annotation", select = true) {
  const doc = getDoc(docId);
  if (!doc || !annots.length) return;
  commitAnnotations(docId, [...doc.annotations, ...annots], label);
  if (select) updateDoc(docId, { selection: annots.map((a) => a.id) });
}

export type AnnotPatch = Partial<Annotation> & Record<string, unknown>;

export function updateAnnotations(
  docId: string,
  patches: Record<string, AnnotPatch> | ((a: Annotation) => Annotation | null),
  label = "Edit annotation",
  key?: string,
) {
  const doc = getDoc(docId);
  if (!doc) return;
  const now = nowIso();
  let changed = false;
  const next = doc.annotations.map((a) => {
    let updated: Annotation | null;
    if (typeof patches === "function") updated = patches(a);
    else updated = patches[a.id] ? ({ ...a, ...patches[a.id] } as Annotation) : null;
    if (!updated || updated === a) return a;
    changed = true;
    return { ...updated, modifiedAt: now } as Annotation;
  });
  if (changed) commitAnnotations(docId, next, label, key);
}

export function updateAnnotation(docId: string, id: string, patch: AnnotPatch, label?: string, key?: string) {
  updateAnnotations(docId, { [id]: patch }, label, key);
}

export function deleteAnnotations(docId: string, ids: string[], label?: string) {
  const doc = getDoc(docId);
  if (!doc || !ids.length) return;
  const set = new Set(ids);
  const next = doc.annotations.filter((a) => !set.has(a.id));
  if (next.length === doc.annotations.length) return;
  commitAnnotations(docId, next, label ?? (ids.length > 1 ? `Delete ${ids.length} annotations` : "Delete annotation"));
  updateDoc(docId, (d) => ({ selection: d.selection.filter((s) => !set.has(s)) }));
  const app = useApp.getState();
  if (app.editingId && set.has(app.editingId)) useApp.setState({ editingId: null });
}

export function replaceAllAnnotations(docId: string, next: Annotation[], label: string) {
  commitAnnotations(docId, next, label);
}

/** Moves annotations to the end (drawn on top) or start (drawn below). */
export function reorderAnnotations(docId: string, ids: string[], toFront: boolean) {
  const doc = getDoc(docId);
  if (!doc) return;
  const set = new Set(ids);
  const moving = doc.annotations.filter((a) => set.has(a.id));
  const rest = doc.annotations.filter((a) => !set.has(a.id));
  commitAnnotations(docId, toFront ? [...rest, ...moving] : [...moving, ...rest], toFront ? "Bring to front" : "Send to back");
}
