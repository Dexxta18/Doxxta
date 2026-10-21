import {
  ArrowDownToLine,
  ArrowUpToLine,
  ClipboardCopy,
  Copy,
  Lock,
  MessageSquare,
  Pencil,
  Scissors,
  SlidersHorizontal,
  Stamp,
  Trash2,
} from "lucide-react";
import { getDoc, openContextMenu, openDialog, useApp, type ContextMenuItem } from "../state/store";
import { useSettings } from "../state/settings";
import {
  bringToFront,
  copySelected,
  deleteSelected,
  duplicateSelected,
  selectedAnnots,
  sendToBack,
  setStatus,
  toggleLock,
} from "../core/annotOps";
import { updateAnnotations } from "../state/annotActions";

export function openAnnotContextMenu(docId: string, x: number, y: number) {
  const doc = getDoc(docId);
  if (!doc) return;
  const sel = selectedAnnots(docId);
  if (!sel.length) return;
  const ids = sel.map((a) => a.id);
  const one = sel.length === 1 ? sel[0] : null;
  const locked = sel.every((a) => a.locked);
  const items: ContextMenuItem[] = [];
  if (one?.kind === "freetext") items.push({ type: "item", label: "Edit text", icon: <Pencil size={15} />, run: () => useApp.setState({ editingId: one.id }) });
  if (one?.kind === "note") items.push({ type: "item", label: "Open note", icon: <Pencil size={15} />, run: () => useApp.setState({ editingId: one.id }) });
  if (one && one.kind !== "field" && one.kind !== "link")
    items.push({
      type: "item",
      label: "Add comment / reply",
      icon: <MessageSquare size={15} />,
      run: () => {
        useSettings.getState().set({ rightPanel: "comments" });
        useApp.setState({ focusCommentId: one.id });
      },
    });
  if (one?.kind === "link") items.push({ type: "item", label: "Edit link…", icon: <Pencil size={15} />, run: () => openDialog("link", { docId, editId: one.id }) });
  items.push({ type: "item", label: "Properties…", icon: <SlidersHorizontal size={15} />, run: () => openDialog("annot-props", { docId, ids }) });
  items.push({ type: "separator" });
  if (sel.every((a) => a.kind !== "field" && a.kind !== "redact" && a.kind !== "link" && a.kind !== "textedit")) {
    for (const s of ["Accepted", "Rejected", "Cancelled", "Completed", "None"] as const) {
      items.push({ type: "item", label: s === "None" ? "Clear status" : `Mark ${s.toLowerCase()}`, run: () => setStatus(docId, ids, s) });
    }
    items.push({ type: "separator" });
  }
  items.push({ type: "item", label: "Cut", icon: <Scissors size={15} />, shortcut: "Mod+X", disabled: locked, run: () => copySelected(docId, true) });
  items.push({ type: "item", label: "Copy", icon: <ClipboardCopy size={15} />, shortcut: "Mod+C", run: () => copySelected(docId) });
  items.push({ type: "item", label: "Duplicate", icon: <Copy size={15} />, shortcut: "Mod+D", run: () => duplicateSelected(docId) });
  items.push({ type: "separator" });
  items.push({ type: "item", label: "Bring to front", icon: <ArrowUpToLine size={15} />, run: () => bringToFront(docId, ids) });
  items.push({ type: "item", label: "Send to back", icon: <ArrowDownToLine size={15} />, run: () => sendToBack(docId, ids) });
  items.push({ type: "item", label: locked ? "Unlock" : "Lock", icon: <Lock size={15} />, run: () => toggleLock(docId, ids) });
  if (sel.every((a) => a.kind !== "redact" && a.kind !== "field" && a.kind !== "link")) {
    const allFlat = sel.every((a) => a.flatten);
    items.push({
      type: "item",
      label: allFlat ? "Keep as editable annotation" : "Flatten into page on save",
      icon: <Stamp size={15} />,
      run: () => {
        const set = new Set(ids);
        updateAnnotations(docId, (a) => (set.has(a.id) ? { ...a, flatten: !allFlat } : null), allFlat ? "Unflatten" : "Flatten on save");
      },
    });
  }
  items.push({ type: "separator" });
  items.push({ type: "item", label: "Delete", icon: <Trash2 size={15} />, shortcut: "Del", danger: true, disabled: locked, run: () => deleteSelected(docId) });
  openContextMenu(x, y, items);
}
