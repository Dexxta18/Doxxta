import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { RightPanelId, ToolId, ToolStyle } from "./types";

export type AppTheme = "light" | "dark" | "system";
export type PageTheme = "normal" | "night" | "sepia" | "contrast";

export const DEFAULT_STYLE: ToolStyle = {
  color: "#ff6b6b",
  fillColor: null,
  opacity: 1,
  strokeWidth: 2,
  fontSize: 12,
  fontFamily: "Helvetica",
  bold: false,
  italic: false,
  textColor: "#111111",
  borderStyle: "solid",
  noteIcon: "Comment",
  startEnding: "None",
  endEnding: "None",
};

/** Per-tool defaults; users' changes are persisted on top of these. */
export const TOOL_STYLE_DEFAULTS: Partial<Record<ToolId, Partial<ToolStyle>>> = {
  highlight: { color: "#ffd400", opacity: 0.45 },
  "area-highlight": { color: "#ffd400", opacity: 0.45 },
  underline: { color: "#2f6bff", opacity: 1 },
  strikeout: { color: "#e5383b", opacity: 1 },
  squiggly: { color: "#2fb344", opacity: 1 },
  note: { color: "#ffd400", noteIcon: "Comment" },
  freetext: { color: "#e5383b", textColor: "#111111", fontSize: 12, fillColor: null, strokeWidth: 0 },
  callout: { color: "#e5383b", textColor: "#111111", fontSize: 12, fillColor: "#ffffff", strokeWidth: 1 },
  ink: { color: "#2f5bea", strokeWidth: 2, opacity: 1 },
  "highlighter-pen": { color: "#ffd400", strokeWidth: 12, opacity: 0.45 },
  rect: { color: "#e5383b", strokeWidth: 2 },
  ellipse: { color: "#e5383b", strokeWidth: 2 },
  line: { color: "#e5383b", strokeWidth: 2 },
  arrow: { color: "#e5383b", strokeWidth: 2, endEnding: "OpenArrow" },
  polygon: { color: "#e5383b", strokeWidth: 2 },
  polyline: { color: "#e5383b", strokeWidth: 2 },
  cloud: { color: "#e5383b", strokeWidth: 2, borderStyle: "cloudy" },
  "fs-text": { textColor: "#111111", color: "#111111", fontSize: 12 },
  "fs-check": { color: "#111111", strokeWidth: 1.5 },
  "fs-cross": { color: "#111111", strokeWidth: 1.5 },
  "fs-dot": { color: "#111111" },
  "fs-circle": { color: "#111111", strokeWidth: 1.5 },
  "fs-line": { color: "#111111", strokeWidth: 1.5 },
  "fs-date": { textColor: "#111111", color: "#111111", fontSize: 12 },
  "redact-text": { color: "#000000" },
  "redact-area": { color: "#000000" },
  "measure-distance": { color: "#2f5bea", strokeWidth: 1.5 },
  "measure-perimeter": { color: "#2f5bea", strokeWidth: 1.5 },
  "measure-area": { color: "#2f5bea", strokeWidth: 1.5, fillColor: "#2f5bea", opacity: 1 },
  "add-text": { textColor: "#111111", color: "#111111", fontSize: 12 },
  link: { color: "#2f5bea" },
};

export interface MeasureScale {
  /** e.g. 1 */
  docValue: number;
  docUnit: "pt" | "in" | "mm" | "cm";
  /** e.g. 10 */
  realValue: number;
  realUnit: string;
  precision: number;
}

export interface SavedSignature {
  id: string;
  kind: "signature" | "initials";
  dataUrl: string;
  width: number;
  height: number;
  createdAt: string;
}

export interface CustomStamp {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
}

interface SettingsState {
  theme: AppTheme;
  pageTheme: PageTheme;
  author: string;
  toolStyles: Partial<Record<ToolId, Partial<ToolStyle>>>;
  toolsPanelOpen: boolean;
  rightPanel: RightPanelId | null;
  rightPanelWidth: number;
  defaultZoom: string;
  measureScale: MeasureScale;
  stampName: string;
  dynamicStampUser: boolean;
  smoothInk: boolean;
  restoreLastView: boolean;
  showTextSelectionMenu: boolean;
  speechRate: number;
  speechVoice: string;
  signatures: SavedSignature[];
  selectedSignatureId: string | null;
  selectedInitialsId: string | null;
  customStamps: CustomStamp[];
  selectedCustomStampId: string | null;
  lastViews: Record<string, { page: number; scaleValue: string }>;
  set: (patch: Partial<Omit<SettingsState, "set" | "setToolStyle">>) => void;
  setToolStyle: (tool: ToolId, patch: Partial<ToolStyle>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      pageTheme: "normal",
      author: "",
      toolStyles: {},
      toolsPanelOpen: true,
      rightPanel: "thumbnails",
      rightPanelWidth: 300,
      defaultZoom: "auto",
      measureScale: { docValue: 1, docUnit: "in", realValue: 1, realUnit: "in", precision: 2 },
      stampName: "Approved",
      dynamicStampUser: true,
      smoothInk: true,
      restoreLastView: true,
      showTextSelectionMenu: true,
      speechRate: 1,
      speechVoice: "",
      signatures: [],
      selectedSignatureId: null,
      selectedInitialsId: null,
      customStamps: [],
      selectedCustomStampId: null,
      lastViews: {},
      set: (patch) => set(patch),
      setToolStyle: (tool, patch) =>
        set((s) => ({ toolStyles: { ...s.toolStyles, [tool]: { ...s.toolStyles[tool], ...patch } } })),
    }),
    {
      // Stored under the app's former name, Quillmark, so settings and signatures saved then carry over.
      name: "quillmark-settings",
      version: 1,
      partialize: (s) => {
        const { set: _set, setToolStyle: _sts, ...rest } = s;
        return rest;
      },
    },
  ),
);

export function getToolStyle(tool: ToolId): ToolStyle {
  const s = useSettings.getState();
  return { ...DEFAULT_STYLE, ...TOOL_STYLE_DEFAULTS[tool], ...s.toolStyles[tool] };
}

export function useToolStyle(tool: ToolId): ToolStyle {
  const custom = useSettings((s) => s.toolStyles[tool]);
  return { ...DEFAULT_STYLE, ...TOOL_STYLE_DEFAULTS[tool], ...custom };
}

export function authorName(): string {
  return useSettings.getState().author.trim() || "Guest";
}

const UNIT_TO_PT: Record<string, number> = { pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54 };

/** Real-world units per PDF point for the configured measurement scale. */
export function measureFactor(scale: MeasureScale): number {
  return scale.realValue / (scale.docValue * UNIT_TO_PT[scale.docUnit]);
}

export function measureScaleLabel(scale: MeasureScale): string {
  return `${scale.docValue} ${scale.docUnit} = ${scale.realValue} ${scale.realUnit}`;
}
