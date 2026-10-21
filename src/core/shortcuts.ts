import { useEffect } from "react";
import { allCommands, getCommand, isEnabled, runCommand } from "./commands";
import { getActiveDoc, getApp, setTool, useApp, closeDialog } from "../state/store";
import { clearSelection, nudgeSelected } from "./annotOps";
import { isMac } from "../lib/util";
import { useTextSelectionMenu } from "../viewer/interactions";

function normalize(e: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && !(e.key === "?" || e.key === "+")) parts.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toUpperCase();
  if (key === "+") key = "=";
  if (key === "_") key = "-";
  if (key === "Del") key = "Delete";
  parts.push(key);
  return parts.join("+");
}

function normalizeSpec(spec: string): string {
  return spec
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .join("+");
}

const bindings = new Map<string, string>();
function buildBindings() {
  if (bindings.size) return;
  for (const c of allCommands()) {
    if (c.shortcut) bindings.set(normalizeSpec(c.shortcut), c.id);
  }
  // Alternates.
  bindings.set("Mod+Y", "edit.redo");
  bindings.set("Mod+Shift+=", "view.rotateCw");
  bindings.set("Shift+?", "help.shortcuts");
  bindings.set("?", "help.shortcuts");
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

/** Floating panels that leave the document usable (keyboard navigation keeps working). */
const NON_MODAL_DIALOGS = new Set(["link-view"]);

/** Shortcuts that work even while typing in a field. */
const GLOBAL = new Set(["Mod+S", "Mod+Shift+S", "Mod+O", "Mod+P", "Mod+F", "Mod+L", "F5", "F3", "F4"]);

export function useGlobalShortcuts() {
  useEffect(() => {
    buildBindings();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const combo = normalize(e);
      const typing = isTyping(e.target);
      const app = getApp();
      if (app.dialogs.some((d) => !NON_MODAL_DIALOGS.has(d.id))) {
        if (e.key === "Escape") closeDialog();
        return;
      }
      if (typing && !GLOBAL.has(combo)) return;

      // Escape: cancel editing/tool, clear selection.
      if (e.key === "Escape") {
        const doc = getActiveDoc();
        if (useTextSelectionMenu.getState().docId) useTextSelectionMenu.setState({ docId: null });
        if (app.findBarOpen) {
          useApp.setState({ findBarOpen: false });
          return;
        }
        if (app.readMode) {
          useApp.setState({ readMode: false });
          return;
        }
        if (doc?.selection.length || app.editingId) {
          clearSelection(doc!.id);
          return;
        }
        if (app.tool !== "select") setTool("select");
        return;
      }

      const doc = getActiveDoc();
      if (doc && doc.status === "ready" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Annotation nudging and deletion.
        if (doc.selection.length) {
          const step = e.shiftKey ? 10 : 1;
          const deltas: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
          const d = deltas[e.key];
          if (d) {
            // Arrow directions are in screen space; convert for rotated views.
            const rot = (doc.pages[doc.view.page - 1]?.rotate ?? 0) + doc.view.rotation;
            const r = ((rot % 360) + 360) % 360;
            const [dx, dy] = r === 90 ? [d[1], -d[0]] : r === 180 ? [-d[0], -d[1]] : r === 270 ? [-d[1], d[0]] : d;
            if (nudgeSelected(doc.id, dx, dy)) e.preventDefault();
            return;
          }
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            runCommand("edit.delete");
            return;
          }
        }
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const v = doc.view;
          // In page-at-a-time layouts, arrows flip pages (Acrobat behaviour).
          if (v.scrollMode === 3 || v.spreadMode !== 0) {
            e.preventDefault();
            runCommand(e.key === "ArrowRight" ? "view.nextPage" : "view.prevPage");
            return;
          }
        }
      }

      const id = bindings.get(combo);
      if (!id) return;
      const c = getCommand(id);
      // Single-letter tool keys shouldn't fire when no document is open.
      if (!isEnabled(c)) {
        if (combo.startsWith("Mod")) e.preventDefault();
        return;
      }
      e.preventDefault();
      runCommand(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Human-readable list of shortcuts for the help dialog. */
export function shortcutList() {
  buildBindings();
  return allCommands()
    .filter((c) => c.shortcut)
    .map((c) => ({ label: c.label, shortcut: c.shortcut! }));
}
