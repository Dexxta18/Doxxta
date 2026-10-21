import type { Annotation, BorderStyle, FontFamily, LineEnding, NoteIcon } from "../annotations/types";

export type ToolId =
  | "select"
  | "hand"
  | "marquee-zoom"
  | "snapshot"
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  | "area-highlight"
  | "note"
  | "freetext"
  | "callout"
  | "ink"
  | "highlighter-pen"
  | "eraser"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "polygon"
  | "polyline"
  | "cloud"
  | "stamp"
  | "signature"
  | "initials"
  | "image-stamp"
  | "fs-text"
  | "fs-check"
  | "fs-cross"
  | "fs-dot"
  | "fs-circle"
  | "fs-line"
  | "fs-date"
  | "redact-text"
  | "redact-area"
  | "measure-distance"
  | "measure-perimeter"
  | "measure-area"
  | "edit-text"
  | "add-text"
  | "add-image"
  | "link"
  | "crop"
  | "field-text"
  | "field-checkbox"
  | "field-radio"
  | "field-dropdown"
  | "field-listbox"
  | "field-button"
  | "field-signature"
  | "field-date";

/** Workspaces, like Acrobat's tool sets. Each shows its own context toolbar. */
export type Mode = "view" | "comment" | "fillsign" | "edit" | "organize" | "forms" | "redact" | "measure" | "protect" | "compare";

export type RightPanelId = "thumbnails" | "bookmarks" | "comments" | "attachments" | "layers" | "search" | "fields" | "signatures" | "info";

export interface ToolStyle {
  color: string;
  fillColor: string | null;
  opacity: number;
  strokeWidth: number;
  fontSize: number;
  fontFamily: FontFamily;
  bold: boolean;
  italic: boolean;
  textColor: string;
  borderStyle: BorderStyle;
  noteIcon: NoteIcon;
  startEnding: LineEnding;
  endEnding: LineEnding;
}

export interface ViewState {
  page: number;
  scale: number;
  scaleValue: string;
  rotation: number;
  scrollMode: number;
  spreadMode: number;
}

export interface PageMeta {
  id: string;
  /** Unrotated page box in PDF user space (pdf.js `page.view`). */
  view: number[];
  /** Page's own /Rotate. */
  rotate: number;
  userUnit: number;
  label?: string;
}

export interface OutlineNode {
  id: string;
  title: string;
  pageId?: string;
  /** Destination top in PDF user space (null = keep current). */
  top?: number | null;
  url?: string;
  bold?: boolean;
  italic?: boolean;
  color?: string | null;
  children: OutlineNode[];
}

export interface DocMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string | null;
  modDate: string | null;
  pdfVersion: string;
  isLinearized: boolean;
  isTagged: boolean;
  encryptFilter: string | null;
  isAcroForm: boolean;
  isXfa: boolean;
  isSignatures: boolean;
  language: string;
  pageLayout?: string;
  pageMode?: string;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  description?: string;
  size: number;
  /** Attachments added in this session are written on save. */
  pending?: boolean;
  removed?: boolean;
  content?: Uint8Array;
}

export interface SecurityInfo {
  encrypted: boolean;
  filter: string | null;
  /** The password used to open the document (empty string for owner-password-only files). */
  password?: string;
  /** Allowed actions (pdf.js PermissionFlag values), null = no restrictions. */
  permissions: number[] | null;
  /** The permissions (owner) password, once the user has entered it. */
  ownerPassword?: string;
  /** Restrictions lifted for this session with the permissions password. */
  unlocked?: boolean;
  /** Requested protection on save; `undefined` keeps the original. */
  pending?: { kind: "encrypt"; userPassword: string; ownerPassword: string; permissions: Record<string, boolean | string>; algorithm: string } | { kind: "remove" };
}

export interface FindState {
  query: string;
  caseSensitive: boolean;
  entireWord: boolean;
  highlightAll: boolean;
  matchDiacritics: boolean;
  current: number;
  total: number;
  status: "idle" | "pending" | "found" | "notfound" | "wrapped";
}

export interface DocState {
  id: string;
  name: string;
  fileSize: number;
  /** Increments whenever the underlying bytes are replaced and the viewer must reload. */
  version: number;
  status: "loading" | "ready" | "error";
  loadingMessage?: string;
  error?: string;
  pages: PageMeta[];
  annotations: Annotation[];
  selection: string[];
  dirty: boolean;
  formDirty: boolean;
  view: ViewState;
  mode: Mode;
  outline: OutlineNode[] | null;
  outlineDirty: boolean;
  metadata: DocMetadata | null;
  metadataDirty: boolean;
  attachments: AttachmentInfo[] | null;
  attachmentsDirty: boolean;
  security: SecurityInfo;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  hasForms: boolean;
  find: FindState;
  /** Annotations in the original file that could not be imported for editing. */
  lockedAnnotationCount: number;
  savedAt?: string;
  canSaveInPlace: boolean;
  bannerDismissed?: boolean;
}
