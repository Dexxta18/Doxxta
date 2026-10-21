import type { Annotation, ReviewStatus } from "../annotations/types";
import { translateAnnot } from "../annotations/geometry";
import { addAnnotations, deleteAnnotations, reorderAnnotations, updateAnnotations } from "../state/annotActions";
import { getDoc, toast, updateDoc, useApp } from "../state/store";
import { nowIso, uid } from "../lib/util";
import { authorName, useSettings } from "../state/settings";

let clipboard: Annotation[] = [];

export function selectedAnnots(docId: string): Annotation[] {
  const doc = getDoc(docId);
  if (!doc) return [];
  const set = new Set(doc.selection);
  return doc.annotations.filter((a) => set.has(a.id));
}

export function copySelected(docId: string, cut = false) {
  const sel = selectedAnnots(docId);
  if (!sel.length) return false;
  clipboard = sel.map((a) => structuredClone(a));
  if (cut) deleteAnnotations(docId, sel.map((a) => a.id), "Cut");
  return true;
}

export function hasAnnotClipboard() {
  return clipboard.length > 0;
}

function cloneAnnot(a: Annotation, pageId: string, dx: number, dy: number): Annotation {
  const now = nowIso();
  const moved = translateAnnot({ ...structuredClone(a), pageId }, dx, dy);
  return { ...moved, id: uid("a"), createdAt: now, modifiedAt: now, replies: [], status: "None", author: authorName(), locked: false };
}

export function pasteAnnots(docId: string) {
  const doc = getDoc(docId);
  if (!doc || !clipboard.length) return false;
  const targetPage = doc.pages[doc.view.page - 1]?.id ?? clipboard[0].pageId;
  const samePage = clipboard.every((a) => a.pageId === targetPage);
  const off = samePage ? 12 : 0;
  const next = clipboard.map((a) => cloneAnnot(a, targetPage, off, -off));
  addAnnotations(docId, next, "Paste");
  // Subsequent pastes cascade.
  clipboard = next.map((a) => structuredClone(a));
  return true;
}

export function duplicateSelected(docId: string) {
  const sel = selectedAnnots(docId);
  if (!sel.length) return;
  addAnnotations(docId, sel.map((a) => cloneAnnot(a, a.pageId, 12, -12)), "Duplicate");
}

export function deleteSelected(docId: string) {
  const sel = selectedAnnots(docId).filter((a) => !a.locked);
  if (!sel.length) return false;
  deleteAnnotations(docId, sel.map((a) => a.id));
  return true;
}

export function nudgeSelected(docId: string, dx: number, dy: number) {
  const sel = selectedAnnots(docId).filter((a) => !a.locked);
  if (!sel.length) return false;
  const ids = new Set(sel.map((a) => a.id));
  updateAnnotations(docId, (a) => (ids.has(a.id) ? translateAnnot(a, dx, dy) : null), "Move", "nudge");
  return true;
}

export function setStatus(docId: string, ids: string[], status: ReviewStatus) {
  const set = new Set(ids);
  updateAnnotations(docId, (a) => (set.has(a.id) ? { ...a, status } : null), `Set status: ${status}`);
}

export function toggleLock(docId: string, ids: string[]) {
  const doc = getDoc(docId);
  if (!doc) return;
  const set = new Set(ids);
  const anyUnlocked = doc.annotations.some((a) => set.has(a.id) && !a.locked);
  updateAnnotations(docId, (a) => (set.has(a.id) ? { ...a, locked: anyUnlocked } : null), anyUnlocked ? "Lock" : "Unlock");
}

export function bringToFront(docId: string, ids: string[]) {
  reorderAnnotations(docId, ids, true);
}

export function sendToBack(docId: string, ids: string[]) {
  reorderAnnotations(docId, ids, false);
}

export function addReply(docId: string, annotId: string, text: string) {
  const now = nowIso();
  updateAnnotations(
    docId,
    (a) => (a.id === annotId ? { ...a, replies: [...a.replies, { id: uid("r"), author: authorName(), contents: text, createdAt: now, modifiedAt: now }] } : null),
    "Reply",
  );
}

export function editReply(docId: string, annotId: string, replyId: string, text: string | null) {
  updateAnnotations(
    docId,
    (a) =>
      a.id === annotId
        ? {
            ...a,
            replies: text === null ? a.replies.filter((r) => r.id !== replyId) : a.replies.map((r) => (r.id === replyId ? { ...r, contents: text, modifiedAt: nowIso() } : r)),
          }
        : null,
    text === null ? "Delete reply" : "Edit reply",
  );
}

export function selectAllOnPage(docId: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  const pageId = doc.pages[doc.view.page - 1]?.id;
  updateDoc(docId, { selection: doc.annotations.filter((a) => a.pageId === pageId).map((a) => a.id) });
}

export function ensureAuthor(): boolean {
  if (useSettings.getState().author.trim()) return true;
  return false;
}

export function clearSelection(docId: string) {
  const doc = getDoc(docId);
  if (doc?.selection.length) updateDoc(docId, { selection: [] });
  if (useApp.getState().editingId) useApp.setState({ editingId: null });
}

export function deleteAllComments(docId: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  const ids = doc.annotations.filter((a) => a.kind !== "field" && a.kind !== "textedit" && a.kind !== "link" && !a.flatten).map((a) => a.id);
  if (!ids.length) {
    toast("There are no comments to delete");
    return;
  }
  deleteAnnotations(docId, ids, "Delete all comments");
}
