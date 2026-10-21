import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, FreeTextAnnot, InkAnnot, LineAnnot, PolyAnnot } from "../annotations/types";
import { AnnotSvg, FreeTextView, TextEditView, stageBox, type RenderCtx } from "../annotations/render";
import {
  apply,
  dist,
  invert,
  normRect,
  rectsIntersect,
  simplifyPath,
  stageTransform,
  transformRect,
  type Matrix,
  type PdfRect,
  type Point,
} from "../lib/geometry";
import { getDoc, selectAnnots, setTool, toast, updateDoc, useApp, openDialog } from "../state/store";
import { getToolStyle, useSettings } from "../state/settings";
import type { ToolId } from "../state/types";
import { addAnnotations, deleteAnnotations, updateAnnotation, updateAnnotations } from "../state/annotActions";
import {
  createField,
  createFreeText,
  createImage,
  createInk,
  createLine,
  createNote,
  createPoly,
  createRedaction,
  createShape,
  createStamp,
  createSymbol,
  createMarkup,
} from "../annotations/factory";
import { computeRect, resizeMode, selectionRect, transformAnnot, translateAnnot } from "../annotations/geometry";
import { AnnotToolbar } from "./AnnotToolbar";
import { NotePopup } from "./NotePopup";
import { TextEditLayer } from "./TextEditLayer";
import { getViewer } from "../state/runtime";
import { pickFiles, uid } from "../lib/util";
import { loadImageFile } from "../lib/images";
import { snapshotRegion } from "./snapshot";
import { polylinePath, toSvg } from "../annotations/paths";
import { formatToday } from "../lib/dates";
import { stdFontName, wrapText } from "../lib/fontMetrics";

const PDF_TO_CSS = 96 / 72;

/** Tools during which the page text layer must stay interactive. */
const TEXT_TOOLS = new Set<ToolId>(["select", "hand", "highlight", "underline", "strikeout", "squiggly", "redact-text", "edit-text"]);
const POLY_TOOLS = new Set<ToolId>(["polygon", "polyline", "cloud", "measure-perimeter", "measure-area"]);
const RECT_TOOLS = new Set<ToolId>(["rect", "ellipse", "area-highlight", "redact-area", "link", "crop", "marquee-zoom", "snapshot"]);
const LINE_TOOLS = new Set<ToolId>(["line", "arrow", "measure-distance"]);
const FIELD_TOOLS: Partial<Record<ToolId, Extract<Annotation, { kind: "field" }>["fieldType"]>> = {
  "field-text": "text",
  "field-checkbox": "checkbox",
  "field-radio": "radio",
  "field-dropdown": "dropdown",
  "field-listbox": "listbox",
  "field-button": "button",
  "field-signature": "signature",
  "field-date": "date",
};

type Drag =
  | { type: "rect"; tool: ToolId; start: Point; cur: Point }
  | { type: "line"; tool: ToolId; start: Point; cur: Point }
  | { type: "ink"; tool: ToolId; points: Point[] }
  | { type: "erase"; key: string; points: Point[] }
  | { type: "callout"; start: Point; cur: Point }
  | { type: "move"; ids: string[]; start: Point; cur: Point; moved: boolean }
  | { type: "resize"; id: string; handle: string; startBox: { x: number; y: number; w: number; h: number }; startStage: Point; curStage: Point; aspect: boolean }
  | { type: "vertex"; id: string; index: number; cur: Point };

/** Last ink stroke created, so quick successive strokes merge into one drawing. */
let lastInk: { id: string; at: number; pageId: string; tool: ToolId } | null = null;

export const PageOverlay = memo(function PageOverlay({ docId, pageIndex }: { docId: string; pageIndex: number }) {
  const page = useApp((s) => s.docs[docId]?.pages[pageIndex]);
  if (!page) return null;
  return <PageOverlayInner docId={docId} pageIndex={pageIndex} />;
});

function PageOverlayInner({ docId, pageIndex }: { docId: string; pageIndex: number }) {
  const page = useApp((s) => s.docs[docId].pages[pageIndex]);
  const viewRotation = useApp((s) => s.docs[docId].view.rotation);
  const zoom = useApp((s) => s.docs[docId].view.scale);
  const mode = useApp((s) => s.docs[docId].mode);
  const all = useApp((s) => s.docs[docId].annotations);
  const selection = useApp((s) => s.docs[docId].selection);
  const tool = useApp((s) => s.tool);
  // Outside Edit mode a click on a link follows it (Shift/Ctrl+click selects it).
  const followLinks = mode !== "edit" && (tool === "select" || tool === "hand");
  const editingId = useApp((s) => s.editingId);
  const smoothInk = useSettings((s) => s.smoothInk);

  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  // The latest drag, so pointer handlers can act on it outside React state updaters
  // (React may run those twice, which would create annotations twice).
  const dragRef = useRef<Drag | null>(null);
  const setDrag = useCallback((next: Drag | null | ((d: Drag | null) => Drag | null)) => {
    const value = typeof next === "function" ? next(dragRef.current) : next;
    dragRef.current = value;
    setDragState(value);
  }, []);
  const [poly, setPoly] = useState<{ tool: ToolId; vertices: Point[]; hover: Point | null } | null>(null);
  const lastClick = useRef<{ t: number; p: Point }>({ t: 0, p: { x: 0, y: 0 } });

  const rotation = (page.rotate + viewRotation) % 360;
  const geo = useMemo(() => stageTransform(page.view, rotation), [page.view, rotation]);
  const inv = useMemo(() => invert(geo.m), [geo]);
  const scale = zoom * PDF_TO_CSS * (page.userUnit || 1);
  const ctx: RenderCtx = useMemo(() => ({ m: geo.m, rotation, scale, mode }), [geo, rotation, scale, mode]);
  const annots = useMemo(() => all.filter((a) => a.pageId === page.id), [all, page.id]);
  const selSet = useMemo(() => new Set(selection), [selection]);

  const toUser = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const r = stageRef.current!.getBoundingClientRect();
      const s = r.width / geo.width;
      return apply(inv, (e.clientX - r.left) / s, (e.clientY - r.top) / s);
    },
    [geo, inv],
  );
  const toStage = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const r = stageRef.current!.getBoundingClientRect();
      const s = r.width / geo.width;
      return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
    },
    [geo],
  );

  const finishTool = useCallback(() => {
    if (!useApp.getState().stickyTool) setTool("select");
  }, []);

  // Cancel in-progress polygons when the tool changes.
  useEffect(() => setPoly(null), [tool]);

  const commitPoly = useCallback(
    (p: { tool: ToolId; vertices: Point[] }) => {
      const minPts = p.tool === "polyline" || p.tool === "measure-perimeter" ? 2 : 3;
      if (p.vertices.length >= minPts) {
        addAnnotations(docId, [createPoly(p.tool, page.id, p.vertices, rotation)], "Add shape");
      }
      setPoly(null);
    },
    [docId, page.id, rotation],
  );

  useEffect(() => {
    if (!poly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPoly(null);
      if (e.key === "Enter") commitPoly(poly);
      if (e.key === "Backspace") setPoly((p) => (p ? { ...p, vertices: p.vertices.slice(0, -1) } : p));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [poly, commitPoly]);

  // Global move/up listeners while dragging.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const p = toUser(e);
      setDrag((d) => {
        if (!d) return d;
        switch (d.type) {
          case "rect":
          case "line":
          case "callout":
            return { ...d, cur: p };
          case "ink": {
            const last = d.points[d.points.length - 1];
            if (last && dist(last, p) < 0.6 / Math.max(0.2, scale / 2)) return d;
            return { ...d, points: [...d.points, p] };
          }
          case "erase":
            eraseAt(docId, page.id, p, 6 / scale, d.key);
            return { ...d, points: [...d.points.slice(-1), p] };
          case "move":
            return { ...d, cur: p, moved: d.moved || dist(d.start, p) * scale > 3 };
          case "resize":
            return { ...d, curStage: toStage(e), aspect: d.aspect || e.shiftKey };
          case "vertex":
            return { ...d, cur: p };
        }
      });
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      setDrag(null);
      if (d) finishDrag(d, toUser(e), e);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.type, toUser, toStage, scale]);

  const finishDrag = (d: Drag, p: Point, e: PointerEvent) => {
    const doc = getDoc(docId);
    if (!doc) return;
    switch (d.type) {
      case "rect": {
        const r = normRect(d.start.x, d.start.y, p.x, p.y);
        const tiny = (r[2] - r[0]) * scale < 4 && (r[3] - r[1]) * scale < 4;
        handleRectTool(d.tool, r, tiny, d.start);
        break;
      }
      case "line": {
        if (dist(d.start, p) * scale < 4) {
          // Click without drag: make a default-length line.
          const q = { x: d.start.x + 80, y: d.start.y };
          addAnnotations(docId, [createLine(d.tool, page.id, d.start, q, rotation)], "Add line");
        } else addAnnotations(docId, [createLine(d.tool, page.id, d.start, p, rotation)], d.tool === "measure-distance" ? "Measure distance" : "Add line");
        if (!useApp.getState().stickyTool && d.tool !== "measure-distance") finishTool();
        break;
      }
      case "ink": {
        let pts = d.points.length === 1 ? [d.points[0], { x: d.points[0].x + 0.1, y: d.points[0].y + 0.1 }] : d.points;
        if (smoothInk) pts = simplifyPath(pts, 0.35);
        const now = Date.now();
        const prev = lastInk && lastInk.pageId === page.id && lastInk.tool === d.tool && now - lastInk.at < 1500 ? doc.annotations.find((a) => a.id === lastInk!.id) : undefined;
        if (prev && prev.kind === "ink") {
          const next = { ...prev, paths: [...prev.paths, pts] } as InkAnnot;
          updateAnnotation(docId, prev.id, { paths: next.paths, rect: computeRect(next) }, "Draw", `ink-${prev.id}`);
          lastInk = { ...lastInk!, at: now };
        } else {
          const a = createInk(d.tool, page.id, [pts], rotation);
          addAnnotations(docId, [a], "Draw", false);
          lastInk = { id: a.id, at: now, pageId: page.id, tool: d.tool };
        }
        break;
      }
      case "callout": {
        const s = getToolStyle("callout");
        const w = 150;
        const h = s.fontSize * 1.2 * 2 + 6;
        const tip = d.start;
        const end = dist(d.start, p) * scale < 6 ? { x: tip.x + 40, y: tip.y + 40 } : p;
        const rect: PdfRect = [end.x, end.y - h / 2, end.x + w, end.y + h / 2];
        const attach = { x: rect[0], y: (rect[1] + rect[3]) / 2 };
        const knee = { x: attach.x - Math.min(20, Math.abs(attach.x - tip.x) / 2), y: attach.y };
        const a = { ...createFreeText("callout", page.id, rect, rotation), callout: [tip, knee, attach] } as FreeTextAnnot;
        addAnnotations(docId, [{ ...a, rect }], "Add callout");
        finishTool();
        useApp.setState({ editingId: a.id });
        break;
      }
      case "move": {
        if (!d.moved) {
          break;
        }
        const dx = p.x - d.start.x;
        const dy = p.y - d.start.y;
        const ids = new Set(d.ids);
        updateAnnotations(docId, (a) => (ids.has(a.id) ? translateAnnot(a, dx, dy) : null), d.ids.length > 1 ? "Move annotations" : "Move annotation");
        break;
      }
      case "resize": {
        const a = doc.annotations.find((x) => x.id === d.id);
        if (!a) break;
        const next = resizedAnnot(a, d, inv);
        if (next) updateAnnotations(docId, { [a.id]: next as never }, "Resize annotation");
        break;
      }
      case "vertex": {
        const a = doc.annotations.find((x) => x.id === d.id);
        if (!a) break;
        const next = movedVertex(a, d.index, d.cur);
        if (next) updateAnnotations(docId, { [a.id]: next as never }, "Edit shape");
        break;
      }
      case "erase":
        break;
    }
    void e;
  };

  function handleRectTool(t: ToolId, r: PdfRect, tiny: boolean, start: Point) {
    const fieldType = FIELD_TOOLS[t];
    if (fieldType) {
      const names = (getDoc(docId)?.annotations ?? []).filter((a) => a.kind === "field").map((a) => (a as { name: string }).name);
      const a = createField(fieldType, page.id, tiny ? null : r, start, rotation, names);
      addAnnotations(docId, [a], "Add form field");
      updateDoc(docId, { selection: [a.id] });
      return;
    }
    switch (t) {
      case "rect":
      case "ellipse": {
        const rr = tiny ? ([start.x - 40, start.y - 25, start.x + 40, start.y + 25] as PdfRect) : r;
        addAnnotations(docId, [createShape(t, page.id, rr, rotation)], "Add shape");
        finishTool();
        break;
      }
      case "area-highlight": {
        if (tiny) return;
        const q = [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]] as never;
        addAnnotations(docId, [createMarkup("highlight", "area-highlight", page.id, [q], rotation)], "Highlight area", false);
        break;
      }
      case "redact-area":
        if (tiny) return;
        addAnnotations(docId, [createRedaction(page.id, r, rotation)], "Mark for redaction", false);
        break;
      case "link": {
        if (tiny) return;
        const id = uid("a");
        openDialog("link", { docId, pageId: page.id, rect: r, rotation, newId: id });
        break;
      }
      case "crop":
        if (tiny) return;
        openDialog("crop", { docId, pageIndex, rect: r });
        break;
      case "marquee-zoom": {
        const v = getViewer(docId);
        if (!v) return;
        if (tiny) {
          v.zoomIn();
          requestAnimationFrame(() => v.scrollToPoint(pageIndex, start.x, start.y, { center: true }));
          return;
        }
        const sr = transformRect(geo.m, r);
        const wPts = sr[2] - sr[0];
        const hPts = sr[3] - sr[1];
        const cw = v.container.clientWidth - 40;
        const ch = v.container.clientHeight - 40;
        const z = Math.min(cw / (wPts * PDF_TO_CSS), ch / (hPts * PDF_TO_CSS), 10);
        v.setScale(z);
        const cx = (r[0] + r[2]) / 2,
          cy = (r[1] + r[3]) / 2;
        requestAnimationFrame(() => requestAnimationFrame(() => v.scrollToPoint(pageIndex, cx, cy, { center: true })));
        break;
      }
      case "snapshot":
        if (tiny) return;
        snapshotRegion(docId, pageIndex, r).catch((e) => toast(String(e), "error"));
        break;
    }
  }

  const placeAt = async (t: ToolId, p: Point) => {
    switch (t) {
      case "note": {
        const a = createNote(page.id, p, rotation);
        addAnnotations(docId, [a], "Add note");
        finishTool();
        useApp.setState({ editingId: a.id });
        return;
      }
      case "freetext":
      case "fs-text":
      case "add-text": {
        const s = getToolStyle(t);
        const h = s.fontSize * 1.2 + 6;
        const w = t === "fs-text" || t === "add-text" ? 160 : 180;
        const a = createFreeText(t, page.id, [p.x, p.y - h + s.fontSize * 0.35, p.x + w, p.y + s.fontSize * 0.35], rotation);
        addAnnotations(docId, [a], "Add text");
        if (t === "freetext") finishTool();
        useApp.setState({ editingId: a.id });
        return;
      }
      case "fs-date": {
        const s = getToolStyle(t);
        const text = formatToday();
        const h = s.fontSize * 1.2 + 6;
        const a = createFreeText(t, page.id, [p.x, p.y - h / 2, p.x + 110, p.y + h / 2], rotation, text);
        addAnnotations(docId, [a], "Add date");
        return;
      }
      case "fs-check":
      case "fs-cross":
      case "fs-dot":
      case "fs-circle":
      case "fs-line": {
        const sym = ({ "fs-check": "check", "fs-cross": "cross", "fs-dot": "dot", "fs-circle": "circle", "fs-line": "line" } as const)[t];
        addAnnotations(docId, [createSymbol(sym, t, page.id, p, rotation)], "Add mark");
        return;
      }
      case "stamp": {
        addAnnotations(docId, [createStamp(page.id, p, rotation)], "Add stamp");
        finishTool();
        return;
      }
      case "signature":
      case "initials": {
        const sigs = useSettings.getState().signatures.filter((s) => s.kind === (t === "initials" ? "initials" : "signature"));
        const settings = useSettings.getState();
        const chosenId = t === "initials" ? settings.selectedInitialsId : settings.selectedSignatureId;
        const sig = sigs.find((s) => s.id === chosenId) ?? sigs[sigs.length - 1];
        if (!sig) {
          openDialog("signature", { kind: t === "initials" ? "initials" : "signature", place: { docId, pageId: page.id, at: p, rotation } });
          return;
        }
        addAnnotations(docId, [createImage(page.id, p, rotation, sig.dataUrl, sig.width, sig.height, t === "initials" ? "initials" : "signature")], t === "initials" ? "Add initials" : "Add signature");
        finishTool();
        return;
      }
      case "image-stamp":
      case "add-image": {
        if (t === "image-stamp") {
          const { selectedCustomStampId, customStamps } = useSettings.getState();
          const stamp = customStamps.find((c) => c.id === selectedCustomStampId);
          if (stamp) {
            addAnnotations(docId, [createImage(page.id, p, rotation, stamp.dataUrl, stamp.width, stamp.height, "stamp", 160)], "Add stamp");
            finishTool();
            return;
          }
        }
        const [file] = await pickFiles("image/*");
        if (!file) return;
        const img = await loadImageFile(file);
        addAnnotations(docId, [createImage(page.id, p, rotation, img.dataUrl, img.width, img.height, t === "add-image" ? "content" : "stamp", t === "add-image" ? 240 : 160)], "Add image");
        finishTool();
        return;
      }
    }
  };

  const lastAnnotDown = useRef({ id: "", t: 0 });
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const p = toUser(e);
    const handleEl = target.closest<HTMLElement>("[data-handle]");
    if (handleEl) {
      e.preventDefault();
      e.stopPropagation();
      const id = handleEl.dataset.annot!;
      const h = handleEl.dataset.handle!;
      const a = annots.find((x) => x.id === id);
      if (!a || a.locked) return;
      if (h.startsWith("v")) {
        setDrag({ type: "vertex", id, index: Number(h.slice(1)), cur: p });
      } else {
        setDrag({ type: "resize", id, handle: h, startBox: stageBox(geo.m, selectionRect(a)), startStage: toStage(e), curStage: toStage(e), aspect: resizeMode(a) === "aspect" || e.shiftKey });
      }
      return;
    }

    const annotEl = target.closest<HTMLElement>("[data-annot-id]");
    const editingLink = tool === "link" && annotEl?.classList.contains("folio-annot-link");
    if (TEXT_TOOLS.has(tool) || mode === "organize" || editingLink) {
      if (annotEl && (tool === "select" || tool === "hand" || editingLink) && !annotEl.classList.contains("is-editing")) {
        const id = annotEl.dataset.annotId!;
        const a = annots.find((x) => x.id === id);
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        if (a.kind === "link" && followLinks) {
          if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
            window.getSelection()?.removeAllRanges();
            void import("../ops/links").then((m) => m.followLink(docId, a));
            return;
          }
        }
        // Clear any text selection so the click doesn't extend it.
        window.getSelection()?.removeAllRanges();
        let next = selection;
        if (e.shiftKey || e.metaKey || e.ctrlKey) next = selSet.has(id) ? selection.filter((s) => s !== id) : [...selection, id];
        else if (!selSet.has(id)) next = [id];
        selectAnnots(docId, next);
        // Pointer events report detail 0 in some browsers, so time the clicks too.
        const now = Date.now();
        const double = e.detail >= 2 || (lastAnnotDown.current.id === id && now - lastAnnotDown.current.t < 450);
        lastAnnotDown.current = { id: double ? "" : id, t: now };
        if (double) {
          if (a.kind === "freetext" || a.kind === "note") useApp.setState({ editingId: a.id });
          else if (a.kind === "link") openDialog("link", { docId, editId: a.id });
          else useApp.setState({ focusCommentId: a.id });
          return;
        }
        const movable = next.filter((sid) => {
          const x = annots.find((y) => y.id === sid);
          return x && !x.locked && x.kind !== "redact";
        });
        if (movable.length && next.includes(id)) setDrag({ type: "move", ids: movable, start: p, cur: p, moved: false });
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (selection.length) selectAnnots(docId, []);

    if (RECT_TOOLS.has(tool) || FIELD_TOOLS[tool]) {
      setDrag({ type: "rect", tool, start: p, cur: p });
      return;
    }
    if (LINE_TOOLS.has(tool)) {
      setDrag({ type: "line", tool, start: p, cur: p });
      return;
    }
    if (tool === "ink" || tool === "highlighter-pen") {
      setDrag({ type: "ink", tool, points: [p] });
      return;
    }
    if (tool === "eraser") {
      const key = uid("erase");
      eraseAt(docId, page.id, p, 6 / scale, key);
      setDrag({ type: "erase", key, points: [p] });
      return;
    }
    if (tool === "callout") {
      setDrag({ type: "callout", start: p, cur: p });
      return;
    }
    if (POLY_TOOLS.has(tool)) {
      const now = Date.now();
      const dbl = now - lastClick.current.t < 350 && dist(lastClick.current.p, p) * scale < 6;
      lastClick.current = { t: now, p };
      if (!poly || poly.tool !== tool) {
        setPoly({ tool, vertices: [p], hover: p });
        return;
      }
      if (dbl) {
        commitPoly(poly);
        return;
      }
      const closeToFirst = poly.vertices.length >= 3 && dist(poly.vertices[0], p) * scale < 8 && tool !== "polyline" && tool !== "measure-perimeter";
      if (closeToFirst) {
        commitPoly(poly);
        return;
      }
      setPoly({ ...poly, vertices: [...poly.vertices, p] });
      return;
    }
    void placeAt(tool, p);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (poly) setPoly((pp) => (pp ? { ...pp, hover: toUser(e) } : pp));
  };

  // ----- draft rendering -----
  const draftAnnots = useMemo(() => {
    if (!drag) return annots;
    if (drag.type === "move" && drag.moved) {
      const ids = new Set(drag.ids);
      const dx = drag.cur.x - drag.start.x,
        dy = drag.cur.y - drag.start.y;
      return annots.map((a) => (ids.has(a.id) ? translateAnnot(a, dx, dy) : a));
    }
    if (drag.type === "resize") {
      return annots.map((a) => (a.id === drag.id ? (resizedAnnot(a, drag, inv) ?? a) : a));
    }
    if (drag.type === "vertex") {
      return annots.map((a) => (a.id === drag.id ? (movedVertex(a, drag.index, drag.cur) ?? a) : a));
    }
    return annots;
  }, [annots, drag, inv]);

  const isCreateTool = !TEXT_TOOLS.has(tool) && mode !== "organize";
  const primary = selection.length ? draftAnnots.find((a) => a.id === selection[selection.length - 1]) : undefined;
  const showToolbar = primary && !drag && !editingId && selection.length >= 1;
  const editingNote = editingId ? draftAnnots.find((a) => a.id === editingId && a.kind === "note") : undefined;

  return (
    <div
      className={`folio-overlay${isCreateTool ? " is-creating" : ""} tool-${tool}${followLinks ? " links-follow" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onContextMenu={(e) => {
        const el = (e.target as Element).closest<HTMLElement>("[data-annot-id]");
        if (el) {
          e.preventDefault();
          const id = el.dataset.annotId!;
          if (!selSet.has(id)) selectAnnots(docId, [id]);
          import("./annotMenu").then((m) => m.openAnnotContextMenu(docId, e.clientX, e.clientY));
        }
      }}
    >
      <div ref={stageRef} className="folio-stage" style={{ width: geo.width, height: geo.height }}>
        <svg className="folio-svg" width={geo.width} height={geo.height} viewBox={`0 0 ${geo.width} ${geo.height}`}>
          {draftAnnots.map((a) =>
            a.kind === "freetext" ? (
              a.callout?.length ? <CalloutLine key={a.id} a={a} ctx={ctx} /> : null
            ) : a.kind === "textedit" ? null : (
              <AnnotSvg key={a.id} a={a} ctx={ctx} />
            ),
          )}
          {drag && <DragPreview drag={drag} ctx={ctx} />}
          {poly && <PolyPreview poly={poly} ctx={ctx} />}
        </svg>
        <div className="folio-html">
          {draftAnnots.map((a) =>
            a.kind === "freetext" ? (
              <FreeTextView
                key={a.id}
                a={a}
                ctx={ctx}
                editing={editingId === a.id}
                onCommit={(text, height) => commitFreeText(docId, a, text, height)}
                onCancel={() => {
                  useApp.setState({ editingId: null });
                  if (!a.text) deleteAnnotations(docId, [a.id], "Remove empty text");
                }}
              />
            ) : a.kind === "textedit" ? (
              <TextEditView key={a.id} a={a} ctx={ctx} />
            ) : null,
          )}
        </div>
        <svg className="folio-ui" width={geo.width} height={geo.height} viewBox={`0 0 ${geo.width} ${geo.height}`}>
          {draftAnnots
            .filter((a) => selSet.has(a.id))
            .map((a) => (
              <SelectionHandles key={a.id} a={a} ctx={ctx} single={selection.length === 1} />
            ))}
        </svg>
      </div>
      {tool === "edit-text" && <TextEditLayer docId={docId} pageIndex={pageIndex} ctx={ctx} geo={geo} />}
      {showToolbar && primary && <AnnotToolbar docId={docId} a={primary} box={stageBox(geo.m, selectionRect(primary))} scale={scale} count={selection.length} />}
      {editingNote && <NotePopup docId={docId} a={editingNote} box={stageBox(geo.m, editingNote.rect)} scale={scale} />}
    </div>
  );
}

function commitFreeText(docId: string, a: FreeTextAnnot, text: string, _contentHeight: number) {
  useApp.setState({ editingId: null });
  if (!text.trim()) {
    deleteAnnotations(docId, [a.id], "Remove empty text");
    return;
  }
  // Size the box to the wrapped text using the same metrics as the renderer.
  const swap = a.rotation % 180 !== 0;
  const boxW = swap ? a.rect[3] - a.rect[1] : a.rect[2] - a.rect[0];
  const pad = 2 + a.borderWidth;
  const lines = wrapText(text, stdFontName(a.fontFamily, a.bold, a.italic), a.fontSize, boxW - pad * 2);
  const needed = lines.length * a.fontSize * 1.2 + pad * 2;
  let rect = a.rect;
  if (!swap) {
    const h = Math.max(needed, a.rect[3] - a.rect[1]);
    rect = [a.rect[0], a.rect[3] - h, a.rect[2], a.rect[3]];
  } else {
    const w = Math.max(needed, a.rect[2] - a.rect[0]);
    rect = a.rotation === 90 ? [a.rect[2] - w, a.rect[1], a.rect[2], a.rect[3]] : [a.rect[0], a.rect[1], a.rect[0] + w, a.rect[3]];
  }
  updateAnnotation(docId, a.id, { text, rect, contents: a.plain ? "" : text } as never, "Edit text");
}

function resizedAnnot(a: Annotation, d: Extract<Drag, { type: "resize" }>, inv: Matrix): Annotation | null {
  const dx = d.curStage.x - d.startStage.x;
  const dy = d.curStage.y - d.startStage.y;
  let { x, y, w, h } = d.startBox;
  const hnd = d.handle;
  if (hnd.includes("w")) {
    x += dx;
    w -= dx;
  }
  if (hnd.includes("e")) w += dx;
  if (hnd.includes("n")) {
    y += dy;
    h -= dy;
  }
  if (hnd.includes("s")) h += dy;
  if (d.aspect && hnd.length === 2 && d.startBox.w > 0 && d.startBox.h > 0) {
    const ratio = d.startBox.w / d.startBox.h;
    if (Math.abs(w / ratio) > Math.abs(h)) h = w / ratio;
    else w = h * ratio;
    if (hnd.includes("w")) x = d.startBox.x + d.startBox.w - w;
    if (hnd.includes("n")) y = d.startBox.y + d.startBox.h - h;
  }
  const min = 4;
  if (w < min) {
    if (hnd.includes("w")) x -= min - w;
    w = min;
  }
  if (h < min) {
    if (hnd.includes("n")) y -= min - h;
    h = min;
  }
  const from = d.startBox;
  const fromUser = transformRect(inv, [from.x, from.y, from.x + from.w, from.y + from.h]);
  const toUser = transformRect(inv, [x, y, x + w, y + h]);
  return transformAnnot(a, fromUser, toUser);
}

function movedVertex(a: Annotation, index: number, p: Point): Annotation | null {
  if (a.kind === "line") {
    const points = a.points.slice() as LineAnnot["points"];
    points[index] = p;
    const next = { ...a, points };
    return { ...next, rect: computeRect(next) };
  }
  if (a.kind === "polygon" || a.kind === "polyline") {
    const vertices = a.vertices.slice();
    vertices[index] = p;
    const next = { ...a, vertices } as PolyAnnot;
    return { ...next, rect: computeRect(next) };
  }
  if (a.kind === "freetext" && a.callout) {
    const callout = a.callout.slice();
    callout[index] = p;
    return { ...a, callout };
  }
  return null;
}

/** Removes ink near `p` (splitting strokes), for the eraser tool. */
function eraseAt(docId: string, pageId: string, p: Point, radius: number, key: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  const box: PdfRect = [p.x - radius, p.y - radius, p.x + radius, p.y + radius];
  const toDelete: string[] = [];
  let touched = false;
  const updates: Record<string, Partial<InkAnnot>> = {};
  for (const a of doc.annotations) {
    if (a.pageId !== pageId || a.kind !== "ink" || a.locked || !rectsIntersect(a.rect, box)) continue;
    const r = radius + a.strokeWidth / 2;
    const paths: Point[][] = [];
    let changed = false;
    for (const path of a.paths) {
      let cur: Point[] = [];
      for (let i = 0; i < path.length; i++) {
        const pt = path[i];
        // Also check the segment so fast strokes are hit.
        const prev = path[i - 1];
        const hit = dist(pt, p) <= r || (prev && distToSeg(p, prev, pt) <= r);
        if (hit) {
          changed = true;
          if (cur.length > 1) paths.push(cur);
          cur = [];
        } else cur.push(pt);
      }
      if (cur.length > 1) paths.push(cur);
      else if (cur.length === 1 && path.length === 1) paths.push(cur);
    }
    if (!changed) continue;
    touched = true;
    if (!paths.length) toDelete.push(a.id);
    else {
      const next = { ...a, paths } as InkAnnot;
      updates[a.id] = { paths, rect: computeRect(next) };
    }
  }
  if (!touched) return;
  if (Object.keys(updates).length) updateAnnotations(docId, updates as never, "Erase", key);
  if (toDelete.length) deleteAnnotations(docId, toDelete, "Erase");
}

function distToSeg(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (!l2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function CalloutLine({ a, ctx }: { a: FreeTextAnnot; ctx: RenderCtx }) {
  const pts = a.callout!;
  const tip = pts[0];
  const next = pts[1] ?? pts[0];
  const len = Math.hypot(tip.x - next.x, tip.y - next.y) || 1;
  const ux = (tip.x - next.x) / len,
    uy = (tip.y - next.y) / len;
  const size = Math.max(6, a.borderWidth * 4);
  const head = [
    { x: tip.x - ux * size + -uy * size * 0.45, y: tip.y - uy * size + ux * size * 0.45 },
    tip,
    { x: tip.x - ux * size - -uy * size * 0.45, y: tip.y - uy * size - ux * size * 0.45 },
  ];
  return (
    <g data-annot-id={a.id} className="folio-annot folio-annot-callout" opacity={a.opacity}>
      <path className="folio-hit" d={toSvg(polylinePath(pts), ctx.m)} strokeWidth={8 / ctx.scale} />
      <path d={toSvg(polylinePath(pts), ctx.m)} stroke={a.borderColor ?? a.color} strokeWidth={Math.max(1, a.borderWidth)} fill="none" />
      <path d={toSvg(polylinePath(head), ctx.m)} stroke={a.borderColor ?? a.color} strokeWidth={Math.max(1, a.borderWidth)} fill="none" />
    </g>
  );
}

function DragPreview({ drag, ctx }: { drag: Drag; ctx: RenderCtx }) {
  const { m } = ctx;
  switch (drag.type) {
    case "rect": {
      const r = normRect(drag.start.x, drag.start.y, drag.cur.x, drag.cur.y);
      const b = stageBox(m, r);
      const style = getToolStyle(drag.tool);
      if (drag.tool === "ellipse")
        return <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} fill={style.fillColor ?? "none"} stroke={style.color} strokeWidth={style.strokeWidth} opacity={style.opacity} />;
      if (drag.tool === "rect")
        return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={style.fillColor ?? "none"} stroke={style.color} strokeWidth={style.strokeWidth} opacity={style.opacity} />;
      const cls = drag.tool === "redact-area" ? "folio-draft-redact" : drag.tool === "area-highlight" ? "folio-draft-highlight" : "folio-draft-marquee";
      return <rect x={b.x} y={b.y} width={b.w} height={b.h} className={cls} vectorEffect="non-scaling-stroke" />;
    }
    case "line": {
      const a = apply(m, drag.start.x, drag.start.y);
      const b = apply(m, drag.cur.x, drag.cur.y);
      const style = getToolStyle(drag.tool);
      return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={style.color} strokeWidth={style.strokeWidth} strokeLinecap="round" />;
    }
    case "callout": {
      const a = apply(m, drag.start.x, drag.start.y);
      const b = apply(m, drag.cur.x, drag.cur.y);
      return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={getToolStyle("callout").color} strokeWidth={1} strokeDasharray="3 2" />;
    }
    case "ink": {
      const style = getToolStyle(drag.tool);
      return (
        <path
          d={toSvg(polylinePath(drag.points), m)}
          stroke={style.color}
          strokeWidth={style.strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={style.opacity}
          style={drag.tool === "highlighter-pen" ? { mixBlendMode: "multiply" } : undefined}
        />
      );
    }
    case "erase": {
      const p = drag.points[drag.points.length - 1];
      const c = apply(m, p.x, p.y);
      return <circle cx={c.x} cy={c.y} r={6 / ctx.scale} className="folio-eraser-cursor" vectorEffect="non-scaling-stroke" />;
    }
    default:
      return null;
  }
}

function PolyPreview({ poly, ctx }: { poly: { tool: ToolId; vertices: Point[]; hover: Point | null }; ctx: RenderCtx }) {
  const style = getToolStyle(poly.tool);
  const pts = poly.hover ? [...poly.vertices, poly.hover] : poly.vertices;
  const closed = poly.tool !== "polyline" && poly.tool !== "measure-perimeter";
  return (
    <g>
      <path d={toSvg(polylinePath(pts, closed && pts.length > 2), ctx.m)} fill={closed && style.fillColor ? style.fillColor : "none"} fillOpacity={0.15} stroke={style.color} strokeWidth={style.strokeWidth} strokeDasharray={poly.tool === "cloud" ? "4 3" : undefined} />
      {poly.vertices.map((v, i) => {
        const s = apply(ctx.m, v.x, v.y);
        return <circle key={i} cx={s.x} cy={s.y} r={3 / ctx.scale} className="folio-vertex-dot" />;
      })}
    </g>
  );
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

function SelectionHandles({ a, ctx, single }: { a: Annotation; ctx: RenderCtx; single: boolean }) {
  const box = stageBox(ctx.m, selectionRect(a));
  const pad = 3 / ctx.scale;
  const hs = 8 / ctx.scale;
  const rm = resizeMode(a);
  const outline = (
    <rect
      x={box.x - pad}
      y={box.y - pad}
      width={box.w + pad * 2}
      height={box.h + pad * 2}
      className="folio-sel-outline"
      vectorEffect="non-scaling-stroke"
    />
  );
  if (!single || a.locked) return outline;
  if (rm === "vertices") {
    const pts = a.kind === "line" ? a.points : a.kind === "polygon" || a.kind === "polyline" ? a.vertices : [];
    return (
      <g>
        {a.kind !== "line" && outline}
        {pts.map((p, i) => {
          const s = apply(ctx.m, p.x, p.y);
          return <circle key={i} data-handle={`v${i}`} data-annot={a.id} cx={s.x} cy={s.y} r={hs / 2 + 1 / ctx.scale} className="folio-handle folio-handle-vertex" vectorEffect="non-scaling-stroke" />;
        })}
      </g>
    );
  }
  const pos: Record<(typeof HANDLES)[number], Point> = {
    nw: { x: box.x - pad, y: box.y - pad },
    n: { x: box.x + box.w / 2, y: box.y - pad },
    ne: { x: box.x + box.w + pad, y: box.y - pad },
    e: { x: box.x + box.w + pad, y: box.y + box.h / 2 },
    se: { x: box.x + box.w + pad, y: box.y + box.h + pad },
    s: { x: box.x + box.w / 2, y: box.y + box.h + pad },
    sw: { x: box.x - pad, y: box.y + box.h + pad },
    w: { x: box.x - pad, y: box.y + box.h / 2 },
  };
  const handles = rm === "none" ? [] : rm === "aspect" ? (["nw", "ne", "se", "sw"] as const) : HANDLES;
  return (
    <g>
      {outline}
      {handles.map((h) => (
        <rect
          key={h}
          data-handle={h}
          data-annot={a.id}
          x={pos[h].x - hs / 2}
          y={pos[h].y - hs / 2}
          width={hs}
          height={hs}
          rx={1.5 / ctx.scale}
          className={`folio-handle folio-handle-${h}`}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {a.kind === "freetext" &&
        a.callout?.slice(0, 2).map((p, i) => {
          const s = apply(ctx.m, p.x, p.y);
          return <circle key={`c${i}`} data-handle={`v${i}`} data-annot={a.id} cx={s.x} cy={s.y} r={hs / 2} className="folio-handle folio-handle-vertex" vectorEffect="non-scaling-stroke" />;
        })}
    </g>
  );
}
