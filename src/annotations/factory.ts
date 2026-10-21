import type {
  Annotation,
  FieldAnnot,
  FieldType,
  FreeTextAnnot,
  ImageAnnot,
  InkAnnot,
  LineAnnot,
  NoteAnnot,
  PolyAnnot,
  RedactAnnot,
  ShapeAnnot,
  StampAnnot,
  SymbolAnnot,
  SymbolKind,
  TextMarkupAnnot,
} from "./types";
import { normRect, pointsBounds, quadBounds, unionRects, type PdfRect, type Point, type Quad } from "../lib/geometry";
import { authorName, getToolStyle, measureFactor, measureScaleLabel, useSettings } from "../state/settings";
import type { ToolId } from "../state/types";
import { nowIso, uid } from "../lib/util";
import { computeRect } from "./geometry";
import { dynamicSublabel, stampByName, stampLayout } from "./stamps";

export function base<K extends Annotation["kind"]>(kind: K, pageId: string, rect: PdfRect, rotation: number, extra: Partial<Annotation> = {}) {
  const now = nowIso();
  return {
    id: uid("a"),
    pageId,
    kind,
    rect,
    color: "#000000",
    opacity: 1,
    author: authorName(),
    contents: "",
    createdAt: now,
    modifiedAt: now,
    replies: [],
    status: "None" as const,
    rotation,
    ...extra,
  };
}

export function createMarkup(kind: TextMarkupAnnot["kind"], tool: ToolId, pageId: string, quads: Quad[], rotation: number, text?: string): TextMarkupAnnot {
  const s = getToolStyle(tool);
  const rect = unionRects(quads.map(quadBounds))!;
  return { ...base(kind, pageId, rect, rotation), color: s.color, opacity: s.opacity, quads, markedText: text, subject: undefined } as TextMarkupAnnot;
}

export function createRedaction(pageId: string, rect: PdfRect, rotation: number, quads?: Quad[], text?: string): RedactAnnot {
  const s = getToolStyle(quads ? "redact-text" : "redact-area");
  return { ...base("redact", pageId, rect, rotation), color: "#e5383b", fillColor: s.color, quads, markedText: text, overlayText: "" } as RedactAnnot;
}

export function createNote(pageId: string, at: Point, rotation: number): NoteAnnot {
  const s = getToolStyle("note");
  // Notes are anchored by their top-left corner (PDF y-up: top is the larger y).
  return { ...base("note", pageId, [at.x, at.y - 20, at.x + 20, at.y], rotation), color: s.color, icon: s.noteIcon } as NoteAnnot;
}

export function createFreeText(tool: ToolId, pageId: string, rect: PdfRect, rotation: number, text = ""): FreeTextAnnot {
  const s = getToolStyle(tool);
  const plain = tool === "fs-text" || tool === "fs-date" || tool === "add-text";
  return {
    ...base("freetext", pageId, rect, rotation),
    color: s.color,
    opacity: s.opacity,
    text,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    bold: s.bold,
    italic: s.italic,
    textColor: s.textColor,
    fillColor: plain ? null : s.fillColor,
    borderColor: plain ? null : tool === "callout" ? s.color : s.strokeWidth > 0 ? s.color : null,
    borderWidth: plain ? 0 : tool === "callout" ? Math.max(1, s.strokeWidth) : s.strokeWidth,
    align: "left",
    plain,
    flatten: tool === "add-text" ? true : undefined,
  } as FreeTextAnnot;
}

export function createInk(tool: ToolId, pageId: string, paths: Point[][], rotation: number): InkAnnot {
  const s = getToolStyle(tool);
  const a = {
    ...base("ink", pageId, [0, 0, 0, 0], rotation),
    color: s.color,
    opacity: s.opacity,
    paths,
    strokeWidth: s.strokeWidth,
    highlighter: tool === "highlighter-pen" || undefined,
  } as InkAnnot;
  return { ...a, rect: computeRect(a) };
}

export function createShape(tool: "rect" | "ellipse", pageId: string, rect: PdfRect, rotation: number): ShapeAnnot {
  const s = getToolStyle(tool);
  return { ...base(tool, pageId, rect, rotation), color: s.color, opacity: s.opacity, strokeWidth: s.strokeWidth, fillColor: s.fillColor, borderStyle: s.borderStyle } as ShapeAnnot;
}

export function createLine(tool: ToolId, pageId: string, p0: Point, p1: Point, rotation: number): LineAnnot {
  const s = getToolStyle(tool);
  const measure = tool === "measure-distance" ? measureInfo("distance") : undefined;
  const a = {
    ...base("line", pageId, [0, 0, 0, 0], rotation),
    color: s.color,
    opacity: s.opacity,
    points: [p0, p1],
    strokeWidth: s.strokeWidth,
    startEnding: tool === "arrow" ? s.startEnding : tool === "measure-distance" ? "None" : s.startEnding,
    endEnding: tool === "arrow" ? (s.endEnding === "None" ? "OpenArrow" : s.endEnding) : tool === "measure-distance" ? "None" : s.endEnding,
    borderStyle: s.borderStyle === "cloudy" ? "solid" : s.borderStyle,
    fillColor: null,
    measure,
  } as LineAnnot;
  return { ...a, rect: computeRect(a) };
}

export function createPoly(tool: ToolId, pageId: string, vertices: Point[], rotation: number): PolyAnnot {
  const s = getToolStyle(tool);
  const kind = tool === "polyline" || tool === "measure-perimeter" ? "polyline" : "polygon";
  const measure = tool === "measure-perimeter" ? measureInfo("perimeter") : tool === "measure-area" ? measureInfo("area") : undefined;
  const a = {
    ...base(kind, pageId, [0, 0, 0, 0], rotation),
    color: s.color,
    opacity: s.opacity,
    vertices,
    strokeWidth: s.strokeWidth,
    fillColor: kind === "polygon" ? s.fillColor : null,
    borderStyle: tool === "cloud" ? "cloudy" : s.borderStyle === "cloudy" && tool !== "polygon" ? "solid" : s.borderStyle,
    measure,
  } as PolyAnnot;
  return { ...a, rect: computeRect(a) };
}

export function measureInfo(kind: "distance" | "perimeter" | "area") {
  const scale = useSettings.getState().measureScale;
  return { kind, factor: measureFactor(scale), unit: scale.realUnit, scaleLabel: measureScaleLabel(scale), precision: scale.precision };
}

export function createStamp(pageId: string, center: Point, rotation: number, stampName?: string): StampAnnot {
  const settings = useSettings.getState();
  const def = stampByName(stampName ?? settings.stampName) ?? stampByName("Approved")!;
  const sublabel = def.dynamic ? dynamicSublabel(settings.dynamicStampUser ? authorName() : "") : undefined;
  const L = stampLayout(def.label, sublabel);
  const scale = 0.75;
  const swap = rotation % 180 !== 0;
  const w = (swap ? L.height : L.width) * scale;
  const h = (swap ? L.width : L.height) * scale;
  return {
    ...base("stamp", pageId, [center.x - w / 2, center.y - h / 2, center.x + w / 2, center.y + h / 2], rotation),
    color: def.color,
    stampName: def.name,
    label: def.label,
    sublabel,
    subject: def.label.charAt(0) + def.label.slice(1).toLowerCase(),
  } as StampAnnot;
}

export function createImage(pageId: string, center: Point, rotation: number, src: string, iw: number, ih: number, role: ImageAnnot["role"], maxW = 180): ImageAnnot {
  const ratio = ih / iw;
  let w = Math.min(maxW, iw);
  let h = w * ratio;
  if (role === "initials") {
    w = Math.min(w, 70);
    h = w * ratio;
  }
  const swap = rotation % 180 !== 0;
  const [rw, rh] = swap ? [h, w] : [w, h];
  return {
    ...base("image", pageId, [center.x - rw / 2, center.y - rh / 2, center.x + rw / 2, center.y + rh / 2], rotation),
    src,
    imageWidth: iw,
    imageHeight: ih,
    role,
    flatten: role === "content" ? true : undefined,
  } as ImageAnnot;
}

export function createSymbol(symbol: SymbolKind, tool: ToolId, pageId: string, center: Point, rotation: number): SymbolAnnot {
  const s = getToolStyle(tool);
  const size = Math.max(8, s.fontSize);
  const w = symbol === "line" ? size * 3 : symbol === "circle" ? size * 1.6 : size;
  const h = symbol === "line" ? Math.max(4, s.strokeWidth * 2) : symbol === "circle" ? size * 1.2 : size;
  const swap = rotation % 180 !== 0;
  const [rw, rh] = swap ? [h, w] : [w, h];
  return {
    ...base("symbol", pageId, [center.x - rw / 2, center.y - rh / 2, center.x + rw / 2, center.y + rh / 2], rotation),
    color: s.color,
    symbol,
    strokeWidth: s.strokeWidth,
  } as SymbolAnnot;
}

const FIELD_SIZES: Record<FieldType, [number, number]> = {
  text: [150, 20],
  date: [100, 20],
  checkbox: [14, 14],
  radio: [14, 14],
  dropdown: [150, 20],
  listbox: [150, 60],
  button: [90, 24],
  signature: [180, 40],
};

export function createField(type: FieldType, pageId: string, rect: PdfRect | null, at: Point, rotation: number, existingNames: string[]): FieldAnnot {
  const [w, h] = FIELD_SIZES[type];
  const r = rect ?? normRect(at.x, at.y - h, at.x + w, at.y);
  const prefix = { text: "Text", date: "Date", checkbox: "Check Box", radio: "Group", dropdown: "Dropdown", listbox: "List Box", button: "Button", signature: "Signature" }[type];
  let n = 1;
  while (existingNames.includes(`${prefix}${n}`)) n++;
  return {
    ...base("field", pageId, r, rotation),
    color: "#2f5bea",
    fieldType: type,
    name: `${prefix}${n}`,
    tooltip: "",
    required: false,
    readOnly: false,
    defaultValue: "",
    options: type === "dropdown" || type === "listbox" ? ["Option 1", "Option 2", "Option 3"] : [],
    multiline: false,
    maxLength: 0,
    fontSize: 0,
    exportValue: type === "radio" ? `Choice${n}` : "Yes",
    borderColor: "#7a8599",
    fillColor: null,
    textColor: "#000000",
    caption: type === "button" ? "Button" : "",
    action: "none",
    actionUrl: "",
    dateFormat: "mm/dd/yyyy",
  } as FieldAnnot;
}

/** Bounding rect from two drag points, with a minimum size for clicks. */
export function dragRect(a: Point, b: Point, minW = 0, minH = 0): PdfRect {
  const r = normRect(a.x, a.y, b.x, b.y);
  if (r[2] - r[0] < 3 && r[3] - r[1] < 3 && (minW || minH)) {
    return [a.x, a.y - minH, a.x + minW, a.y];
  }
  return r;
}

export function pointsRect(pts: Point[]): PdfRect {
  return pointsBounds(pts);
}
