import type { ReactNode } from "react";
import {
  BookOpen,
  Columns2,
  Copy,
  Crop,
  Download,
  Expand,
  File as FileIcon,
  FilePlus2,
  FileSearch,
  Files,
  FolderOpen,
  Hand,
  Info,
  Link2,
  Maximize,
  MousePointer2,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Scan,
  Search,
  Settings,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
  Clipboard,
  Scissors,
  Camera,
  Keyboard,
  Presentation,
  Volume2,
  X,
} from "lucide-react";
import { getActiveDoc, getApp, getDoc, openDialog, setMode, setTool, toast, useApp, withBusy } from "../state/store";
import { getViewer } from "../state/runtime";
import { useSettings } from "../state/settings";
import type { Mode, ToolId } from "../state/types";
import { pickFiles } from "../lib/util";
import { mobile } from "../lib/mobile";
import { closeDocument, openFile, redo, revertDocument, undo } from "./document";
import { copySelected, deleteSelected, duplicateSelected, hasAnnotClipboard, pasteAnnots, selectAllOnPage } from "./annotOps";
import { MODE_PERMISSION, withPermission, type Permission } from "./permissions";
import { requestRecognition } from "../viewer/recognizeRequest";

export interface Command {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  /** Requires an open document. */
  needsDoc?: boolean;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Restriction of secured PDFs this command is subject to. */
  perm?: Permission;
  run: () => unknown;
}

const ic = (C: React.ComponentType<{ size?: number }>) => <C size={16} />;

const activeId = () => getApp().activeId;
const viewer = () => getViewer(activeId());

export async function openFilesFromPicker() {
  const w = window as unknown as {
    showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]>;
  };
  if (w.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({
        multiple: true,
        types: [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }],
      });
      for (const h of handles) await openFile(await h.getFile(), { fileHandle: h });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const files = await pickFiles("application/pdf,.pdf", true);
  for (const f of files) await openFile(f);
}

function mode(m: Mode) {
  return () => {
    const id = activeId();
    if (!id) return;
    const doc = getActiveDoc()!;
    const next = doc.mode === m && m !== "view" ? "view" : m;
    const perm = MODE_PERMISSION[next];
    if (perm) void withPermission(id, perm, () => setMode(id, next));
    else setMode(id, next);
  };
}

function tool(t: ToolId) {
  return () => setTool(t);
}

/** Phones: the document goes to the share sheet, which prints it (or sends it to a printing app). */
async function printFromPhone(docId: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  const [{ buildPdf }, { shareFile }] = await Promise.all([import("./save"), import("../lib/mobile")]);
  const bytes = await withBusy("Preparing to print…", () => buildPdf(docId, {}));
  if (bytes) await shareFile(bytes, doc.name, `Print “${doc.name}”`);
}

const commands: Command[] = [
  // ----- File -----
  { id: "file.open", label: "Open…", icon: ic(FolderOpen), shortcut: "Mod+O", run: openFilesFromPicker },
  { id: "file.openUrl", label: "Open from URL…", icon: ic(Link2), run: () => openDialog("open-url") },
  { id: "file.save", label: "Save", icon: ic(Save), shortcut: "Mod+S", needsDoc: true, run: async () => (await import("./save")).saveDocument(activeId()!) },
  { id: "file.saveAs", label: "Save as…", icon: ic(Download), shortcut: "Mod+Shift+S", needsDoc: true, run: () => openDialog("save-as", { docId: activeId() }) },
  {
    id: "file.print",
    perm: "print",
    label: "Print…",
    icon: ic(Printer),
    shortcut: "Mod+P",
    needsDoc: true,
    // Phones print from the share sheet (Print on iPhone; printer and PDF apps on Android).
    run: () => (mobile ? void printFromPhone(activeId()!) : openDialog("print", { docId: activeId() })),
  },
  { id: "file.properties", label: "Document properties…", icon: ic(Info), shortcut: "Mod+D", needsDoc: true, run: () => openDialog("properties", { docId: activeId() }) },
  { id: "file.close", label: "Close document", icon: ic(X), needsDoc: true, run: () => closeDocument(activeId()!) },
  {
    id: "file.closeAll",
    label: "Close all",
    needsDoc: true,
    run: async () => {
      for (const id of [...getApp().order]) if (!(await closeDocument(id))) break;
    },
  },
  { id: "file.revert", label: "Revert to saved", icon: ic(RotateCcw), needsDoc: true, enabled: () => !!getActiveDoc()?.dirty, run: () => revertDocument(activeId()!) },
  { id: "file.createBlank", label: "Blank document…", icon: ic(FileIcon), run: () => openDialog("create", { tab: "blank" }) },
  { id: "file.createImages", label: "From images…", icon: ic(FilePlus2), run: () => openDialog("create", { tab: "images" }) },
  { id: "file.createText", label: "From text file…", icon: ic(FilePlus2), run: () => openDialog("create", { tab: "text" }) },
  { id: "file.createClipboard", label: "From clipboard image", icon: ic(Clipboard), run: async () => (await import("../ops/create")).createFromClipboard() },
  { id: "file.createCamera", label: "From camera / scanner…", icon: ic(Camera), run: () => openDialog("camera") },
  { id: "file.combine", label: "Combine files…", icon: ic(Files), run: () => openDialog("combine") },
  { id: "file.export", perm: "copy", label: "Export PDF…", icon: ic(Download), needsDoc: true, run: () => openDialog("export", { docId: activeId() }) },

  // ----- Edit -----
  { id: "edit.undo", label: "Undo", icon: ic(Undo2), shortcut: "Mod+Z", needsDoc: true, enabled: () => !!getActiveDoc()?.canUndo, run: () => undo(activeId()!) },
  { id: "edit.redo", label: "Redo", icon: ic(Redo2), shortcut: "Mod+Shift+Z", needsDoc: true, enabled: () => !!getActiveDoc()?.canRedo, run: () => redo(activeId()!) },
  { id: "edit.cut", perm: "annotate", label: "Cut", icon: ic(Scissors), shortcut: "Mod+X", needsDoc: true, enabled: () => !!getActiveDoc()?.selection.length, run: () => copySelected(activeId()!, true) },
  { id: "edit.copy", label: "Copy", icon: ic(Copy), shortcut: "Mod+C", needsDoc: true, enabled: () => !!getActiveDoc()?.selection.length, run: () => copySelected(activeId()!) },
  { id: "edit.paste", perm: "annotate", label: "Paste", icon: ic(Clipboard), shortcut: "Mod+V", needsDoc: true, enabled: () => hasAnnotClipboard(), run: () => pasteAnnots(activeId()!) },
  { id: "edit.duplicate", perm: "annotate", label: "Duplicate", icon: ic(Copy), shortcut: "Mod+Shift+D", needsDoc: true, enabled: () => !!getActiveDoc()?.selection.length, run: () => duplicateSelected(activeId()!) },
  { id: "edit.delete", perm: "annotate", label: "Delete", icon: ic(Trash2), shortcut: "Delete", needsDoc: true, enabled: () => !!getActiveDoc()?.selection.length, run: () => deleteSelected(activeId()!) },
  { id: "edit.selectAll", label: "Select all comments on page", needsDoc: true, run: () => selectAllOnPage(activeId()!) },
  {
    id: "edit.find",
    label: "Find…",
    icon: ic(Search),
    shortcut: "Mod+F",
    needsDoc: true,
    run: () => {
      useApp.setState({ findBarOpen: true });
      setTimeout(() => document.querySelector<HTMLInputElement>(".findbar input")?.select(), 0);
    },
  },
  { id: "edit.search", label: "Advanced search…", icon: ic(FileSearch), shortcut: "Mod+Shift+F", needsDoc: true, run: () => useSettings.getState().set({ rightPanel: "search" }) },
  { id: "edit.preferences", label: "Preferences…", icon: ic(Settings), shortcut: "Mod+,", run: () => openDialog("preferences") },

  // ----- View -----
  { id: "view.zoomIn", label: "Zoom in", icon: ic(ZoomIn), shortcut: "Mod+=", needsDoc: true, run: () => viewer()?.zoomIn() },
  { id: "view.zoomOut", label: "Zoom out", icon: ic(ZoomOut), shortcut: "Mod+-", needsDoc: true, run: () => viewer()?.zoomOut() },
  { id: "view.fitPage", label: "Fit page", shortcut: "Mod+0", needsDoc: true, checked: () => getActiveDoc()?.view.scaleValue === "page-fit", run: () => viewer()?.setScale("page-fit") },
  { id: "view.actualSize", label: "Actual size", shortcut: "Mod+1", needsDoc: true, checked: () => getActiveDoc()?.view.scaleValue === "page-actual", run: () => viewer()?.setScale("page-actual") },
  { id: "view.fitWidth", label: "Fit width", shortcut: "Mod+2", needsDoc: true, checked: () => getActiveDoc()?.view.scaleValue === "page-width", run: () => viewer()?.setScale("page-width") },
  { id: "view.fitAuto", label: "Automatic zoom", shortcut: "Mod+3", needsDoc: true, checked: () => getActiveDoc()?.view.scaleValue === "auto", run: () => viewer()?.setScale("auto") },
  { id: "view.marqueeZoom", label: "Marquee zoom", icon: ic(Scan), shortcut: "Z", needsDoc: true, checked: () => getApp().tool === "marquee-zoom", run: tool("marquee-zoom") },
  { id: "view.rotateCw", label: "Rotate view clockwise", icon: ic(RotateCw), shortcut: "Mod+Shift+=", needsDoc: true, run: () => viewer()?.rotateView(90) },
  { id: "view.rotateCcw", label: "Rotate view counterclockwise", icon: ic(RotateCcw), shortcut: "Mod+Shift+-", needsDoc: true, run: () => viewer()?.rotateView(-90) },
  { id: "view.firstPage", label: "First page", shortcut: "Home", needsDoc: true, run: () => viewer()?.goToPage(1) },
  { id: "view.lastPage", label: "Last page", shortcut: "End", needsDoc: true, run: () => viewer()?.goToPage(getActiveDoc()?.pages.length ?? 1) },
  { id: "view.nextPage", label: "Next page", shortcut: "PageDown", needsDoc: true, run: () => viewer()?.nextPage() },
  { id: "view.prevPage", label: "Previous page", shortcut: "PageUp", needsDoc: true, run: () => viewer()?.prevPage() },
  { id: "view.goToPage", label: "Go to page…", shortcut: "Mod+Shift+N", needsDoc: true, run: () => openDialog("goto-page", { docId: activeId() }) },
  // Page display (pdf.js ScrollMode: 0 vertical, 1 horizontal, 2 wrapped, 3 page; SpreadMode: 0 none, 1 odd, 2 even).
  { id: "view.singlePage", label: "Single page view", icon: ic(FileIcon), needsDoc: true, checked: () => getActiveDoc()?.view.scrollMode === 3 && getActiveDoc()?.view.spreadMode === 0, run: () => setLayout(3, 0) },
  { id: "view.continuous", label: "Enable scrolling", icon: ic(BookOpen), needsDoc: true, checked: () => getActiveDoc()?.view.scrollMode === 0 && getActiveDoc()?.view.spreadMode === 0, run: () => setLayout(0, 0) },
  { id: "view.twoPage", label: "Two page view", icon: ic(Columns2), needsDoc: true, checked: () => getActiveDoc()?.view.scrollMode === 3 && getActiveDoc()?.view.spreadMode !== 0, run: () => setLayout(3, 1) },
  { id: "view.twoPageScroll", label: "Two page scrolling", needsDoc: true, checked: () => getActiveDoc()?.view.scrollMode === 0 && getActiveDoc()?.view.spreadMode !== 0, run: () => setLayout(0, 1) },
  {
    id: "view.coverPage",
    label: "Show cover page in two page view",
    needsDoc: true,
    checked: () => getActiveDoc()?.view.spreadMode === 2,
    run: () => {
      const d = getActiveDoc();
      if (!d) return;
      setLayout(d.view.scrollMode === 1 || d.view.scrollMode === 2 ? 0 : d.view.scrollMode, d.view.spreadMode === 2 ? 1 : 2);
    },
  },
  { id: "view.horizontal", label: "Horizontal scrolling", needsDoc: true, checked: () => getActiveDoc()?.view.scrollMode === 1, run: () => setLayout(1, 0) },
  { id: "view.wrapped", label: "Wrapped (grid) scrolling", needsDoc: true, checked: () => getActiveDoc()?.view.scrollMode === 2, run: () => setLayout(2, 0) },
  {
    id: "view.fullscreen",
    label: "Full screen mode",
    icon: ic(Maximize),
    shortcut: "Mod+L",
    run: () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => toast("Full screen is not available", "warning"));
    },
  },
  { id: "view.presentation", label: "Presentation mode", icon: ic(Presentation), shortcut: "F5", needsDoc: true, run: async () => (await import("../components/modes/presentationMode")).startPresentation() },
  { id: "view.readMode", label: "Read mode", icon: ic(Expand), shortcut: "Mod+H", needsDoc: true, checked: () => getApp().readMode, run: () => useApp.setState((s) => ({ readMode: !s.readMode })) },
  { id: "view.toolsPanel", label: "Tools panel", shortcut: "F3", checked: () => useSettings.getState().toolsPanelOpen, run: () => useSettings.getState().set({ toolsPanelOpen: !useSettings.getState().toolsPanelOpen }) },
  {
    id: "view.sidePanel",
    label: "Side panel",
    shortcut: "F4",
    checked: () => !!useSettings.getState().rightPanel,
    run: () => {
      const s = useSettings.getState();
      s.set({ rightPanel: s.rightPanel ? null : "thumbnails" });
    },
  },
  { id: "view.readAloud", label: "Read out loud", icon: ic(Volume2), shortcut: "Mod+Shift+Y", needsDoc: true, run: async () => (await import("../ops/speech")).toggleReadAloud() },
  { id: "view.pageThemeNormal", label: "Original colors", checked: () => useSettings.getState().pageTheme === "normal", run: () => useSettings.getState().set({ pageTheme: "normal" }) },
  { id: "view.pageThemeNight", label: "Night (inverted)", checked: () => useSettings.getState().pageTheme === "night", run: () => useSettings.getState().set({ pageTheme: "night" }) },
  { id: "view.pageThemeSepia", label: "Sepia", checked: () => useSettings.getState().pageTheme === "sepia", run: () => useSettings.getState().set({ pageTheme: "sepia" }) },
  { id: "view.pageThemeContrast", label: "High contrast", checked: () => useSettings.getState().pageTheme === "contrast", run: () => useSettings.getState().set({ pageTheme: "contrast" }) },
  { id: "view.themeLight", label: "Light", checked: () => useSettings.getState().theme === "light", run: () => useSettings.getState().set({ theme: "light" }) },
  { id: "view.themeDark", label: "Dark", checked: () => useSettings.getState().theme === "dark", run: () => useSettings.getState().set({ theme: "dark" }) },
  { id: "view.themeSystem", label: "Match system", checked: () => useSettings.getState().theme === "system", run: () => useSettings.getState().set({ theme: "system" }) },

  // ----- Tools -----
  { id: "tool.select", label: "Select", icon: ic(MousePointer2), shortcut: "V", needsDoc: true, checked: () => getApp().tool === "select", run: tool("select") },
  { id: "tool.hand", label: "Hand", icon: ic(Hand), shortcut: "H", needsDoc: true, checked: () => getApp().tool === "hand", run: tool("hand") },
  { id: "tool.snapshot", label: "Take a snapshot", icon: ic(Camera), needsDoc: true, run: tool("snapshot") },
  { id: "tool.note", perm: "annotate", label: "Sticky note", shortcut: "N", needsDoc: true, run: () => enterTool("comment", "note") },
  { id: "tool.highlight", perm: "annotate", label: "Highlight text", shortcut: "U", needsDoc: true, run: () => enterTool("comment", "highlight") },
  { id: "tool.freetext", perm: "annotate", label: "Text box", shortcut: "T", needsDoc: true, run: () => enterTool("comment", "freetext") },
  { id: "tool.ink", perm: "annotate", label: "Draw", shortcut: "D", needsDoc: true, run: () => enterTool("comment", "ink") },
  { id: "tool.rect", perm: "annotate", label: "Rectangle", shortcut: "R", needsDoc: true, run: () => enterTool("comment", "rect") },
  { id: "mode.view", label: "View", needsDoc: true, checked: () => getActiveDoc()?.mode === "view", run: mode("view") },
  { id: "mode.comment", label: "Comment", needsDoc: true, checked: () => getActiveDoc()?.mode === "comment", run: mode("comment") },
  { id: "mode.fillsign", label: "Fill & Sign", needsDoc: true, checked: () => getActiveDoc()?.mode === "fillsign", run: mode("fillsign") },
  { id: "mode.edit", label: "Edit PDF", needsDoc: true, checked: () => getActiveDoc()?.mode === "edit", run: mode("edit") },
  { id: "mode.organize", label: "Organize pages", needsDoc: true, checked: () => getActiveDoc()?.mode === "organize", run: mode("organize") },
  { id: "mode.forms", label: "Prepare a form", needsDoc: true, checked: () => getActiveDoc()?.mode === "forms", run: mode("forms") },
  { id: "mode.redact", label: "Redact", needsDoc: true, checked: () => getActiveDoc()?.mode === "redact", run: mode("redact") },
  { id: "mode.measure", label: "Measure", needsDoc: true, checked: () => getActiveDoc()?.mode === "measure", run: mode("measure") },
  { id: "mode.protect", label: "Protect", needsDoc: true, checked: () => getActiveDoc()?.mode === "protect", run: mode("protect") },
  { id: "tool.compare", label: "Compare files", needsDoc: false, run: () => openDialog("compare-setup", { docId: activeId() }) },
  { id: "tool.compress", perm: "modify", label: "Compress PDF", needsDoc: true, run: () => openDialog("compress", { docId: activeId() }) },
  { id: "tool.ocr", perm: "modify", label: "Recognize text (OCR)", needsDoc: true, run: () => openDialog("ocr", { docId: activeId() }) },
  { id: "tool.editPictureText", perm: "modify", label: "Edit text in pictures", needsDoc: true, run: editPictureText },
  { id: "tool.export", perm: "copy", label: "Export PDF", needsDoc: true, run: () => openDialog("export", { docId: activeId() }) },
  { id: "tool.split", perm: "assemble", label: "Split document", needsDoc: true, run: () => openDialog("split", { docId: activeId() }) },
  { id: "tool.insertPages", perm: "assemble", label: "Insert pages", needsDoc: true, run: () => openDialog("insert-pages", { docId: activeId() }) },
  { id: "tool.extractPages", perm: "assemble", label: "Extract pages", needsDoc: true, run: () => openDialog("extract-pages", { docId: activeId() }) },
  { id: "tool.watermark", perm: "modify", label: "Watermark", needsDoc: true, run: () => openDialog("watermark", { docId: activeId() }) },
  { id: "tool.headerFooter", perm: "modify", label: "Header & footer", needsDoc: true, run: () => openDialog("header-footer", { docId: activeId() }) },
  { id: "tool.background", perm: "modify", label: "Background", needsDoc: true, run: () => openDialog("background", { docId: activeId() }) },
  { id: "tool.bates", perm: "modify", label: "Bates numbering", needsDoc: true, run: () => openDialog("bates", { docId: activeId() }) },
  { id: "tool.pageNumbers", perm: "modify", label: "Add page numbers", needsDoc: true, run: () => openDialog("page-numbers", { docId: activeId() }) },
  { id: "tool.crop", perm: "modify", label: "Crop pages", icon: ic(Crop), needsDoc: true, run: () => enterTool("edit", "crop") },
  { id: "tool.link", perm: "modify", label: "Add or edit links", icon: ic(Link2), needsDoc: true, run: () => enterTool("edit", "link") },
  { id: "tool.protect", perm: "owner", label: "Protect with password", needsDoc: true, run: () => openDialog("protect", { docId: activeId() }) },
  { id: "tool.removeSecurity", label: "Remove security", needsDoc: true, run: () => openDialog("remove-security", { docId: activeId() }) },
  { id: "tool.sanitize", perm: "modify", label: "Remove hidden information", needsDoc: true, run: () => openDialog("sanitize", { docId: activeId() }) },
  { id: "tool.flatten", perm: "modify", label: "Flatten comments & forms", needsDoc: true, run: () => openDialog("flatten", { docId: activeId() }) },
  { id: "tool.stamps", perm: "annotate", label: "Stamps", needsDoc: true, run: () => enterTool("comment", "stamp") },
  { id: "tool.signatures", label: "Manage signatures", needsDoc: false, run: () => openDialog("signature", { kind: "signature" }) },
  { id: "tool.importComments", perm: "annotate", label: "Import comments (XFDF)…", needsDoc: true, run: async () => (await import("../annotations/xfdf")).importCommentsFromFile(activeId()!) },
  { id: "tool.exportComments", label: "Export comments (XFDF)", needsDoc: true, run: async () => (await import("../annotations/xfdf")).exportCommentsToFile(activeId()!) },
  { id: "tool.summarizeComments", label: "Summarize comments", needsDoc: true, run: async () => (await import("../ops/commentSummary")).summarizeComments(activeId()!) },
  { id: "tool.exportFormData", label: "Export form data…", needsDoc: true, run: () => openDialog("form-data", { docId: activeId(), mode: "export" }) },
  { id: "tool.importFormData", perm: "fillForms", label: "Import form data…", needsDoc: true, run: () => openDialog("form-data", { docId: activeId(), mode: "import" }) },
  { id: "tool.resetForm", perm: "fillForms", label: "Clear form", needsDoc: true, run: async () => (await import("../ops/forms")).resetForm(activeId()!) },
  { id: "help.shortcuts", label: "Keyboard shortcuts", icon: ic(Keyboard), shortcut: "Shift+?", run: () => openDialog("shortcuts") },
  { id: "help.about", label: "About Doxxta", icon: ic(Info), run: () => openDialog("about") },
];

function setLayout(scroll: number, spread: number) {
  const v = viewer();
  if (!v) return;
  v.setScrollMode(scroll);
  v.setSpreadMode(spread);
}

/** Edit text on the current page, after recognizing the text that's part of its pictures. */
function editPictureText() {
  const id = activeId();
  const doc = getActiveDoc();
  if (!id || !doc) return;
  enterTool("edit", "edit-text");
  requestRecognition(id, Math.max(0, doc.view.page - 1));
}

export function enterTool(m: Mode, t: ToolId) {
  const id = activeId();
  if (!id) return;
  const go = () => {
    if (getActiveDoc()?.mode !== m) setMode(id, m);
    setTool(t);
  };
  const perm = MODE_PERMISSION[m];
  if (perm) void withPermission(id, perm, go);
  else go();
}

const byId = new Map(commands.map((c) => [c.id, c]));

export function getCommand(id: string): Command {
  const c = byId.get(id);
  if (!c) throw new Error(`Unknown command ${id}`);
  return c;
}

export function isEnabled(c: Command): boolean {
  if (c.needsDoc && !getActiveDoc()) return false;
  if (c.needsDoc && getActiveDoc()?.status !== "ready") return false;
  return c.enabled ? c.enabled() : true;
}

export function runCommand(id: string) {
  const c = getCommand(id);
  if (!isEnabled(c)) return;
  const run = () =>
    Promise.resolve(c.run()).catch((e) => {
      console.error(e);
      toast(e instanceof Error ? e.message : String(e), "error");
    });
  const docId = activeId();
  if (c.perm && c.needsDoc && docId) void withPermission(docId, c.perm, run);
  else void run();
}

export function allCommands() {
  return commands;
}
