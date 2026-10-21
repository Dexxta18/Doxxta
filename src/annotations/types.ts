import type { PdfRect, Point, Quad } from "../lib/geometry";

/**
 * The editable annotation model. Geometry is stored in PDF user space of the
 * page identified by `pageId` (a stable id that survives page reordering).
 * These records are written back into the PDF as real annotations (with
 * appearance streams) when saving, and re-imported when a PDF is opened, so
 * they round-trip through Acrobat and other viewers.
 */

export type AnnotKind =
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  | "note"
  | "freetext"
  | "ink"
  | "rect"
  | "ellipse"
  | "line"
  | "polygon"
  | "polyline"
  | "stamp"
  | "image"
  | "symbol"
  | "redact"
  | "link"
  | "textedit"
  | "field";

export type ReviewStatus = "None" | "Accepted" | "Rejected" | "Cancelled" | "Completed";

export interface Reply {
  id: string;
  author: string;
  contents: string;
  createdAt: string;
  modifiedAt: string;
}

export type LineEnding = "None" | "OpenArrow" | "ClosedArrow" | "Circle" | "Square" | "Diamond" | "Butt" | "Slash";

export type BorderStyle = "solid" | "dashed" | "cloudy";

export type FontFamily = "Helvetica" | "Times" | "Courier";

export interface MeasureInfo {
  kind: "distance" | "perimeter" | "area";
  /** Real-world units per PDF point. */
  factor: number;
  unit: string;
  /** Label for the scale ratio, e.g. "1 in = 10 ft". */
  scaleLabel: string;
  precision: number;
}

interface Base {
  id: string;
  pageId: string;
  kind: AnnotKind;
  /** Bounding rectangle in PDF user space. Derived for point-based kinds. */
  rect: PdfRect;
  color: string;
  opacity: number;
  author: string;
  subject?: string;
  contents: string;
  createdAt: string;
  modifiedAt: string;
  replies: Reply[];
  status: ReviewStatus;
  locked?: boolean;
  /** Drawn into the page content (not as an annotation) when saving. */
  flatten?: boolean;
  /** The page display rotation the annotation was authored at (text/images stay upright relative to it). */
  rotation: number;
}

export interface TextMarkupAnnot extends Base {
  kind: "highlight" | "underline" | "strikeout" | "squiggly";
  quads: Quad[];
  /** Text covered by the markup, for display in the comments list. */
  markedText?: string;
}

export type NoteIcon = "Comment" | "Note" | "Help" | "Insert" | "Key" | "NewParagraph" | "Paragraph";

export interface NoteAnnot extends Base {
  kind: "note";
  icon: NoteIcon;
}

export interface FreeTextAnnot extends Base {
  kind: "freetext";
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  textColor: string;
  fillColor: string | null;
  borderColor: string | null;
  borderWidth: number;
  align: "left" | "center" | "right";
  /** Optional callout leader line (start point at the target, knee, end at box). */
  callout?: Point[];
  /** Fill & Sign style text (no box chrome while editing). */
  plain?: boolean;
}

export interface InkAnnot extends Base {
  kind: "ink";
  paths: Point[][];
  strokeWidth: number;
  /** Ink created by the highlighter-style pen uses multiply blending. */
  highlighter?: boolean;
}

export interface ShapeAnnot extends Base {
  kind: "rect" | "ellipse";
  strokeWidth: number;
  fillColor: string | null;
  borderStyle: BorderStyle;
}

export interface LineAnnot extends Base {
  kind: "line";
  points: [Point, Point];
  strokeWidth: number;
  startEnding: LineEnding;
  endEnding: LineEnding;
  borderStyle: Exclude<BorderStyle, "cloudy">;
  fillColor: string | null;
  measure?: MeasureInfo;
}

export interface PolyAnnot extends Base {
  kind: "polygon" | "polyline";
  vertices: Point[];
  strokeWidth: number;
  fillColor: string | null;
  borderStyle: BorderStyle;
  measure?: MeasureInfo;
}

export interface StampAnnot extends Base {
  kind: "stamp";
  /** Standard stamp name (e.g. "Approved") or "Custom". */
  stampName: string;
  label: string;
  /** Second line such as "By Jane Doe at 10:42 AM, Oct 21 2026" for dynamic stamps. */
  sublabel?: string;
}

/** Raster image placed on the page: signatures, initials, image stamps, Edit PDF images. */
export interface ImageAnnot extends Base {
  kind: "image";
  /** data: URL (PNG or JPEG). */
  src: string;
  imageWidth: number;
  imageHeight: number;
  role: "signature" | "initials" | "stamp" | "content";
}

export type SymbolKind = "check" | "cross" | "dot" | "circle" | "line" | "rectangle";

export interface SymbolAnnot extends Base {
  kind: "symbol";
  symbol: SymbolKind;
  strokeWidth: number;
}

export interface RedactAnnot extends Base {
  kind: "redact";
  /** Text-based redactions carry quads; area redactions just use rect. */
  quads?: Quad[];
  overlayText?: string;
  fillColor: string;
  markedText?: string;
}

/**
 * Where a link goes. Page targets may carry an explicit view (PDF user space of
 * the target page, as in an /XYZ destination); without one the link opens the
 * top of the page.
 */
export type LinkTarget = { type: "page"; pageId: string; left?: number | null; top?: number | null; zoom?: number | null } | { type: "url"; url: string };

export type LinkHighlight = "none" | "invert" | "outline" | "push";

export interface LinkAnnot extends Base {
  kind: "link";
  target: LinkTarget;
  /** Visible rectangle (drawn by viewers from /Border and /C). */
  showBorder: boolean;
  borderStyle?: "solid" | "dashed" | "underline";
  /** 1 thin, 2 medium, 3 thick. */
  borderWidth?: number;
  /** What viewers do while the link is clicked. */
  highlight?: LinkHighlight;
  /** Text areas of a link that wraps across lines. */
  quads?: Quad[];
}

/** "Edit PDF > Edit text": replaces a block of page text on save. */
export interface TextEditAnnot extends Base {
  kind: "textedit";
  /** Area of the original text that is removed (PDF space). */
  originalRect: PdfRect;
  originalText: string;
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  textColor: string;
  /** Background used to cover the original text when content-level removal is not possible. */
  backgroundColor: string;
  lineHeight: number;
  align: "left" | "center" | "right";
}

export type FieldType = "text" | "checkbox" | "radio" | "dropdown" | "listbox" | "button" | "signature" | "date";

/** "Prepare Form": a new AcroForm field created on save. */
export interface FieldAnnot extends Base {
  kind: "field";
  fieldType: FieldType;
  name: string;
  tooltip: string;
  required: boolean;
  readOnly: boolean;
  defaultValue: string;
  options: string[];
  multiline: boolean;
  maxLength: number;
  fontSize: number;
  /** Radio buttons: the export value of this button within its group (`name`). */
  exportValue: string;
  borderColor: string | null;
  fillColor: string | null;
  textColor: string;
  /** Button: caption and action. */
  caption: string;
  action: "none" | "reset" | "print" | "url";
  actionUrl: string;
  dateFormat: string;
}

export type Annotation =
  | TextMarkupAnnot
  | NoteAnnot
  | FreeTextAnnot
  | InkAnnot
  | ShapeAnnot
  | LineAnnot
  | PolyAnnot
  | StampAnnot
  | ImageAnnot
  | SymbolAnnot
  | RedactAnnot
  | LinkAnnot
  | TextEditAnnot
  | FieldAnnot;

export type AnnotOf<K extends AnnotKind> = Extract<Annotation, { kind: K }>;

export const isTextMarkup = (a: Annotation): a is TextMarkupAnnot =>
  a.kind === "highlight" || a.kind === "underline" || a.kind === "strikeout" || a.kind === "squiggly";

/** Kinds that show up in the Comments panel (review comments, not content edits). */
export const isCommentKind = (a: Annotation) =>
  a.kind !== "link" && a.kind !== "textedit" && a.kind !== "field" && a.kind !== "redact" && !a.flatten;

export const KIND_LABELS: Record<AnnotKind, string> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "Strikethrough",
  squiggly: "Squiggly underline",
  note: "Sticky note",
  freetext: "Text box",
  ink: "Drawing",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  polygon: "Polygon",
  polyline: "Polyline",
  stamp: "Stamp",
  image: "Image",
  symbol: "Mark",
  redact: "Redaction",
  link: "Link",
  textedit: "Text edit",
  field: "Form field",
};

export function annotLabel(a: Annotation): string {
  if (a.kind === "line" && a.measure) return "Distance";
  if (a.kind === "polyline" && a.measure) return "Perimeter";
  if (a.kind === "polygon" && a.measure) return "Area";
  if (a.kind === "line" && a.endEnding !== "None") return "Arrow";
  if (a.kind === "polygon" && a.borderStyle === "cloudy") return "Cloud";
  if (a.kind === "image") return a.role === "signature" ? "Signature" : a.role === "initials" ? "Initials" : "Image";
  if (a.kind === "stamp") return `Stamp: ${a.label}`;
  if (a.kind === "field") return `Field: ${a.name}`;
  return KIND_LABELS[a.kind];
}
