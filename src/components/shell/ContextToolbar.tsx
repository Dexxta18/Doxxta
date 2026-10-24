import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  Cloud,
  Crop,
  Dot,
  Droplet,
  Eraser,
  EyeOff,
  Hand,
  Hash,
  Heading,
  Highlighter,
  Image,
  ImagePlus,
  KeyRound,
  Link,
  List,
  ListOrdered,
  Lock,
  LockOpen,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  MousePointer2,
  MousePointerClick,
  PenLine,
  PenTool,
  Pentagon,
  Plus,
  Redo2,
  Ruler,
  Scan,
  Search,
  ScanText,
  Settings2,
  ShieldCheck,
  Signature,
  Spline,
  Square,
  SquareCheck,
  SquareChevronDown,
  SquareDashed,
  Stamp,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  TextSelect,
  Type,
  Underline,
  Undo2,
  Waves,
  X,
  Calendar,
  Shapes,
  FileOutput,
  ListRestart,
  Layers,
  FileDown,
} from "lucide-react";
import { getApp, openDialog, setMode, setTool as selectTool, useApp } from "../../state/store";
import { MODE_PERMISSION, withPermission } from "../../core/permissions";
import { useSettings, useToolStyle, type SavedSignature } from "../../state/settings";
import type { Mode, ToolId } from "../../state/types";
import { IconButton } from "../ui/Button";
import { ColorButton, Slider } from "../ui/Fields";
import { Popover } from "../ui/Popover";
import { Menu, MenuButton, type MenuItem } from "../ui/Menu";
import { usePhone } from "../../lib/device";
import { runCommand } from "../../core/commands";
import { STAMPS } from "../../annotations/stamps";
import { HIGHLIGHT_COLORS } from "../../lib/colors";
import type { BorderStyle, LineEnding, NoteIcon } from "../../annotations/types";

interface ToolDef {
  id: ToolId;
  label: string;
  icon: ReactNode;
  shortcut?: string;
}

const T = (id: ToolId, label: string, icon: ReactNode, shortcut?: string): ToolDef => ({ id, label, icon, shortcut });

const SELECT = T("select", "Select", <MousePointer2 size={17} />, "V");
const HAND = T("hand", "Hand (pan)", <Hand size={17} />, "H");

const COMMENT_TEXT = [
  T("highlight", "Highlight text", <Highlighter size={17} />, "U"),
  T("underline", "Underline text", <Underline size={17} />),
  T("strikeout", "Strikethrough text", <Strikethrough size={17} />),
  T("squiggly", "Squiggly underline", <Waves size={17} />),
  T("area-highlight", "Highlight area", <SquareDashed size={17} />),
];
const COMMENT_NOTES = [T("note", "Sticky note", <StickyNote size={17} />, "N"), T("freetext", "Text box", <Type size={17} />, "T"), T("callout", "Callout", <MessageSquareText size={17} />)];
const COMMENT_DRAW = [T("ink", "Draw (pen)", <PenLine size={17} />, "D"), T("highlighter-pen", "Highlighter pen", <Highlighter size={17} />), T("eraser", "Eraser", <Eraser size={17} />)];
const SHAPES = [
  T("rect", "Rectangle", <Square size={17} />, "R"),
  T("ellipse", "Ellipse", <Circle size={17} />),
  T("line", "Line", <Minus size={17} />),
  T("arrow", "Arrow", <ArrowUpRight size={17} />),
  T("polygon", "Polygon", <Pentagon size={17} />),
  T("polyline", "Polyline", <Spline size={17} />),
  T("cloud", "Cloud", <Cloud size={17} />),
];
const FILLSIGN = [
  T("fs-text", "Add text", <Type size={17} />),
  T("fs-date", "Add date", <CalendarDays size={17} />),
  T("fs-check", "Checkmark", <Check size={17} />),
  T("fs-cross", "Cross mark", <X size={17} />),
  T("fs-dot", "Dot", <Dot size={22} />),
  T("fs-circle", "Circle", <Circle size={17} />),
  T("fs-line", "Line", <Minus size={17} />),
];
const EDIT = [
  T("edit-text", "Edit text", <TextCursorInput size={17} />),
  T("add-text", "Add text", <Type size={17} />),
  T("add-image", "Add image", <ImagePlus size={17} />),
  T("link", "Add link", <Link size={17} />),
  T("crop", "Crop page", <Crop size={17} />),
];
const FORMS = [
  T("field-text", "Text field", <TextCursorInput size={17} />),
  T("field-checkbox", "Check box", <SquareCheck size={17} />),
  T("field-radio", "Radio button", <CircleDot size={17} />),
  T("field-dropdown", "Dropdown", <SquareChevronDown size={17} />),
  T("field-listbox", "List box", <List size={17} />),
  T("field-button", "Button", <MousePointerClick size={17} />),
  T("field-signature", "Signature field", <Signature size={17} />),
  T("field-date", "Date field", <Calendar size={17} />),
];
const REDACT = [T("redact-text", "Mark text for redaction", <TextSelect size={17} />), T("redact-area", "Mark area for redaction", <SquareDashed size={17} />)];
const MEASURE = [T("measure-distance", "Distance", <Ruler size={17} />), T("measure-perimeter", "Perimeter", <Spline size={17} />), T("measure-area", "Area", <Shapes size={17} />)];

const MODE_TITLES: Record<Mode, string> = {
  view: "",
  comment: "Comment",
  fillsign: "Fill & Sign",
  edit: "Edit PDF",
  organize: "Organize pages",
  forms: "Prepare form",
  redact: "Redact",
  measure: "Measure",
  protect: "Protect",
  compare: "Compare",
};

function ToolButtons({ tools }: { tools: ToolDef[] }) {
  const current = useApp((s) => s.tool);
  return (
    <>
      {tools.map((t) => (
        <IconButton
          key={t.id}
          icon={t.icon}
          label={t.label}
          shortcut={t.shortcut}
          active={current === t.id}
          onClick={() => setTool(current === t.id && t.id !== "select" ? "select" : t.id, getApp().stickyTool)}
        />
      ))}
    </>
  );
}

const FREE_TOOLS = new Set<ToolId>(["select", "hand", "marquee-zoom", "snapshot"]);

/** Picks a tool, asking for the permissions password first on restricted documents. */
function setTool(t: ToolId, sticky?: boolean) {
  const { activeId, docs } = getApp();
  const doc = activeId ? docs[activeId] : undefined;
  if (!doc || FREE_TOOLS.has(t)) return selectTool(t, sticky);
  void withPermission(doc.id, MODE_PERMISSION[doc.mode] ?? "annotate", () => selectTool(t, sticky));
}

const Sep = () => <span className="toolbar-sep" />;

function ShapesDropdown() {
  const current = useApp((s) => s.tool);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const active = SHAPES.find((s) => s.id === current);
  const [last, setLast] = useState<ToolDef>(SHAPES[0]);
  const shown = active ?? last;
  return (
    <span className="split-btn">
      <IconButton icon={shown.icon} label={shown.label} active={!!active} onClick={() => setTool(active ? "select" : shown.id)} />
      <button ref={ref} className="split-btn-caret" aria-label="More shapes" data-tip="Shapes" onClick={() => setOpen(!open)}>
        <ChevronDown size={13} />
      </button>
      <Menu
        open={open}
        anchor={ref.current?.getBoundingClientRect() ?? null}
        onClose={() => setOpen(false)}
        ignore={ref.current}
        items={SHAPES.map((s) => ({
          label: s.label,
          icon: s.icon,
          checked: undefined,
          onSelect: () => {
            setLast(s);
            setTool(s.id);
          },
        }))}
      />
    </span>
  );
}

function StampPicker() {
  const current = useApp((s) => s.tool);
  const stampName = useSettings((s) => s.stampName);
  const custom = useSettings((s) => s.customStamps);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const stamp = STAMPS.find((s) => s.name === stampName);
  return (
    <span className="split-btn">
      <IconButton icon={<Stamp size={17} />} label={`Stamp: ${stamp?.label ?? "Custom"}`} active={current === "stamp" || current === "image-stamp"} onClick={() => setTool(current === "stamp" ? "select" : "stamp")} />
      <button ref={ref} className="split-btn-caret" aria-label="Choose stamp" data-tip="Choose stamp" onClick={() => setOpen(!open)}>
        <ChevronDown size={13} />
      </button>
      <Popover open={open} anchor={ref} onClose={() => setOpen(false)} ignoreRefs={[ref]} className="stamp-popover">
        {(["Standard", "Sign Here", "Dynamic"] as const).map((g) => (
          <div key={g} className="stamp-group">
            <div className="popover-title">{g === "Dynamic" ? "Dynamic (name & date)" : g}</div>
            <div className="stamp-grid">
              {STAMPS.filter((s) => s.group === g).map((s) => (
                <button
                  key={s.name}
                  className={`stamp-chip${s.name === stampName ? " is-active" : ""}`}
                  style={{ color: s.color, borderColor: s.color }}
                  onClick={() => {
                    useSettings.getState().set({ stampName: s.name });
                    setTool("stamp");
                    setOpen(false);
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="stamp-group">
          <div className="popover-title">Custom</div>
          <div className="stamp-grid">
            {custom.map((c) => (
              <button key={c.id} className="stamp-chip stamp-chip-img" onClick={() => {
                setOpen(false);
                openDialog("custom-stamp", { use: c.id });
              }}>
                <img src={c.dataUrl} alt={c.name} />
              </button>
            ))}
            <button
              className="stamp-chip stamp-chip-add"
              onClick={() => {
                useSettings.getState().set({ selectedCustomStampId: null });
                setTool("image-stamp");
                setOpen(false);
              }}
            >
              <ImagePlus size={14} /> Image stamp
            </button>
            <button
              className="stamp-chip stamp-chip-add"
              onClick={() => {
                setOpen(false);
                openDialog("custom-stamp");
              }}
            >
              Manage…
            </button>
          </div>
        </div>
      </Popover>
    </span>
  );
}

function SignatureButton({ kind }: { kind: "signature" | "initials" }) {
  const current = useApp((s) => s.tool);
  const sigs = useSettings((s) => s.signatures).filter((s) => s.kind === kind);
  const selectedId = useSettings((s) => (kind === "signature" ? s.selectedSignatureId : s.selectedInitialsId));
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const toolId: ToolId = kind;
  const choose = (s: SavedSignature) => {
    useSettings.getState().set(kind === "signature" ? { selectedSignatureId: s.id } : { selectedInitialsId: s.id });
    setTool(toolId);
    setOpen(false);
  };
  const label = kind === "signature" ? "Sign" : "Initials";
  return (
    <span className="split-btn">
      <button
        className={`toolbar-text-btn${current === toolId ? " is-active" : ""}`}
        data-tip={sigs.length ? `Place ${kind}` : `Create ${kind}`}
        onClick={() => {
          if (!sigs.length) openDialog("signature", { kind });
          else setTool(current === toolId ? "select" : toolId);
        }}
      >
        {kind === "signature" ? <Signature size={16} /> : <PenTool size={16} />}
        {label}
      </button>
      <button ref={ref} className="split-btn-caret" aria-label={`${label} options`} onClick={() => setOpen(!open)}>
        <ChevronDown size={13} />
      </button>
      <Popover open={open} anchor={ref} onClose={() => setOpen(false)} ignoreRefs={[ref]} className="popover-pad sig-popover">
        <div className="popover-title">{kind === "signature" ? "Your signatures" : "Your initials"}</div>
        {sigs.length === 0 && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Nothing saved yet.</div>}
        <div className="sig-list">
          {sigs.map((s) => (
            <button key={s.id} className={`sig-item${s.id === selectedId ? " is-active" : ""}`} onClick={() => choose(s)}>
              <img src={s.dataUrl} alt={kind} />
            </button>
          ))}
        </div>
        <button
          className="btn btn-subtle btn-sm btn-block"
          style={{ marginTop: 8 }}
          onClick={() => {
            setOpen(false);
            openDialog("signature", { kind });
          }}
        >
          <Plus size={14} /> {kind === "signature" ? "Add signature" : "Add initials"}
        </button>
      </Popover>
    </span>
  );
}

const ENDINGS: LineEnding[] = ["None", "OpenArrow", "ClosedArrow", "Circle", "Square", "Diamond", "Butt", "Slash"];
const NOTE_ICONS: NoteIcon[] = ["Comment", "Note", "Help", "Insert", "Key", "NewParagraph", "Paragraph"];

/** Style controls for the active creation tool (persisted per tool). */
function ToolStyleControls() {
  const tool = useApp((s) => s.tool);
  const style = useToolStyle(tool);
  const setStyle = (patch: Parameters<ReturnType<typeof useSettings.getState>["setToolStyle"]>[1]) => useSettings.getState().setToolStyle(tool, patch);
  const widthRef = useRef<HTMLButtonElement>(null);
  const opRef = useRef<HTMLButtonElement>(null);
  const [pop, setPop] = useState<null | "width" | "opacity">(null);
  const [menu, setMenu] = useState<{ anchor: DOMRect; items: MenuItem[] } | null>(null);

  const isText = ["freetext", "callout", "fs-text", "fs-date", "add-text"].includes(tool);
  const hasColor = !["select", "hand", "marquee-zoom", "snapshot", "eraser", "edit-text", "crop", "add-image", "image-stamp", "stamp", "signature", "initials", "link"].includes(tool) && !tool.startsWith("field-");
  const hasWidth = ["ink", "highlighter-pen", "rect", "ellipse", "line", "arrow", "polygon", "polyline", "cloud", "measure-distance", "measure-perimeter", "measure-area", "fs-check", "fs-cross", "fs-circle", "fs-line", "callout"].includes(tool);
  const hasFill = ["rect", "ellipse", "polygon", "cloud", "freetext", "callout"].includes(tool);
  const hasOpacity = hasColor && !tool.startsWith("fs-") && !tool.startsWith("redact") && tool !== "add-text";
  const isLine = tool === "line" || tool === "arrow";
  const hasSize = isText || tool.startsWith("fs-");
  if (!hasColor && !hasWidth) return null;

  return (
    <div className="tool-style">
      {hasColor && (
        <ColorButton
          label={isText ? "Text color" : "Color"}
          value={isText ? style.textColor : style.color}
          colors={tool === "highlight" || tool === "area-highlight" || tool === "highlighter-pen" ? HIGHLIGHT_COLORS : undefined}
          onChange={(c) => c && setStyle(isText ? { textColor: c, ...(tool === "freetext" ? {} : { color: c }) } : { color: c })}
        />
      )}
      {(tool === "freetext" || tool === "callout") && <ColorButton label="Border color" allowNone value={style.strokeWidth > 0 || tool === "callout" ? style.color : null} onChange={(c) => setStyle(c ? { color: c, strokeWidth: Math.max(1, style.strokeWidth) } : { strokeWidth: 0 })} />}
      {hasFill && <ColorButton label="Fill color" allowNone value={style.fillColor} onChange={(c) => setStyle({ fillColor: c })} />}
      {hasWidth && (
        <>
          <button ref={widthRef} className="annot-toolbar-chip" data-tip="Thickness" onClick={() => setPop(pop === "width" ? null : "width")}>
            <span className="stroke-sample" style={{ height: Math.min(8, Math.max(1, style.strokeWidth)) }} />
            {style.strokeWidth}pt
          </button>
          <Popover open={pop === "width"} anchor={widthRef} onClose={() => setPop(null)} ignoreRefs={[widthRef]} className="popover-pad">
            <div className="popover-title">Thickness</div>
            <div style={{ width: 210 }}>
              <Slider value={style.strokeWidth} min={0.5} max={tool === "highlighter-pen" ? 30 : tool === "ink" ? 20 : 12} step={0.5} format={(v) => `${v} pt`} onChange={(v) => setStyle({ strokeWidth: v })} />
            </div>
          </Popover>
        </>
      )}
      {hasOpacity && (
        <>
          <button ref={opRef} className="annot-toolbar-chip" data-tip="Opacity" onClick={() => setPop(pop === "opacity" ? null : "opacity")}>
            {Math.round(style.opacity * 100)}%
          </button>
          <Popover open={pop === "opacity"} anchor={opRef} onClose={() => setPop(null)} ignoreRefs={[opRef]} className="popover-pad">
            <div className="popover-title">Opacity</div>
            <div style={{ width: 210 }}>
              <Slider value={Math.round(style.opacity * 100)} min={5} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => setStyle({ opacity: v / 100 })} />
            </div>
          </Popover>
        </>
      )}
      {hasSize && (
        <select className="annot-toolbar-select" value={style.fontSize} data-tip={isText ? "Font size" : "Size"} onChange={(e) => setStyle({ fontSize: Number(e.target.value) })}>
          {[6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map((s) => (
            <option key={s} value={s}>
              {s} pt
            </option>
          ))}
        </select>
      )}
      {isText && (
        <select className="annot-toolbar-select" value={style.fontFamily} data-tip="Font" onChange={(e) => setStyle({ fontFamily: e.target.value as never })}>
          <option value="Helvetica">Sans</option>
          <option value="Times">Serif</option>
          <option value="Courier">Mono</option>
        </select>
      )}
      {isLine && (
        <button
          className="annot-toolbar-chip"
          data-tip="Line endings"
          onClick={(e) =>
            setMenu({
              anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
              items: [
                { type: "header", label: "Start" },
                ...ENDINGS.map((en) => ({ label: en, checked: style.startEnding === en, onSelect: () => setStyle({ startEnding: en }) })),
                { type: "header", label: "End" },
                ...ENDINGS.map((en) => ({ label: en, checked: style.endEnding === en, onSelect: () => setStyle({ endEnding: en }) })),
              ] as MenuItem[],
            })
          }
        >
          Ends <ChevronDown size={12} />
        </button>
      )}
      {(tool === "rect" || tool === "ellipse" || tool === "polygon" || tool === "line" || tool === "polyline") && (
        <button
          className="annot-toolbar-chip"
          data-tip="Line style"
          onClick={(e) =>
            setMenu({
              anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
              items: ((tool === "line" || tool === "polyline" ? ["solid", "dashed"] : ["solid", "dashed", "cloudy"]) as BorderStyle[]).map((b) => ({
                label: b[0].toUpperCase() + b.slice(1),
                checked: style.borderStyle === b,
                onSelect: () => setStyle({ borderStyle: b }),
              })),
            })
          }
        >
          {style.borderStyle[0].toUpperCase() + style.borderStyle.slice(1)} <ChevronDown size={12} />
        </button>
      )}
      {tool === "note" && (
        <button
          className="annot-toolbar-chip"
          data-tip="Note icon"
          onClick={(e) =>
            setMenu({
              anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
              items: NOTE_ICONS.map((n) => ({ label: n, checked: style.noteIcon === n, onSelect: () => setStyle({ noteIcon: n }) })),
            })
          }
        >
          {style.noteIcon} <ChevronDown size={12} />
        </button>
      )}
      <Menu open={!!menu} anchor={menu?.anchor ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </div>
  );
}

function ModeTools({ mode }: { mode: Mode }) {
  switch (mode) {
    case "comment":
      return (
        <>
          <ToolButtons tools={COMMENT_TEXT} />
          <Sep />
          <ToolButtons tools={COMMENT_NOTES} />
          <Sep />
          <ToolButtons tools={COMMENT_DRAW} />
          <Sep />
          <ShapesDropdown />
          <StampPicker />
          <Sep />
          <ToolStyleControls />
        </>
      );
    case "fillsign":
      return (
        <>
          <ToolButtons tools={FILLSIGN} />
          <Sep />
          <SignatureButton kind="signature" />
          <SignatureButton kind="initials" />
          <Sep />
          <ToolStyleControls />
        </>
      );
    case "edit":
      return (
        <>
          <ToolButtons tools={EDIT} />
          <Sep />
          <ToolStyleControls />
        </>
      );
    case "forms":
      return <ToolButtons tools={FORMS} />;
    case "redact":
      return (
        <>
          <ToolButtons tools={REDACT} />
          <Sep />
          <button className="toolbar-text-btn" onClick={() => openDialog("search-redact")}>
            <Search size={16} /> Find text & patterns
          </button>
        </>
      );
    case "measure":
      return (
        <>
          <ToolButtons tools={MEASURE} />
          <Sep />
          <ToolStyleControls />
        </>
      );
    case "protect":
      return null;
    default:
      return (
        <>
          <ToolButtons tools={[T("highlight", "Highlight text", <Highlighter size={17} />, "U"), T("note", "Sticky note", <StickyNote size={17} />, "N"), T("ink", "Draw", <PenLine size={17} />, "D"), T("freetext", "Text box", <Type size={17} />, "T")]} />
          <Sep />
          <IconButton icon={<Scan size={17} />} label="Marquee zoom" shortcut="Z" active={useApp.getState().tool === "marquee-zoom"} onClick={() => setTool("marquee-zoom")} />
        </>
      );
  }
}

/** A tool's labelled button (Watermark, Clear form…): put in the "More" menu when there's no room for it. */
interface ToolAction {
  label: string;
  icon: ReactNode;
  tip?: string;
  run: () => void;
  /** The tool's main action: drawn as a button of its own, and the last to go in "More". */
  main?: boolean;
}

const ACTIONS: Partial<Record<Mode, ToolAction[]>> = {
  fillsign: [
    { label: "Clear form", icon: <ListRestart size={16} />, tip: "Clear all form field values", run: () => runCommand("tool.resetForm") },
    { label: "Form data", icon: <FileOutput size={16} />, run: () => runCommand("tool.exportFormData") },
  ],
  edit: [
    { label: "Text in pictures", icon: <ScanText size={16} />, tip: "Recognize the text in this page's pictures to edit it", run: () => runCommand("tool.editPictureText") },
    { label: "Header & footer", icon: <Heading size={16} />, run: () => runCommand("tool.headerFooter") },
    { label: "Watermark", icon: <Droplet size={16} />, run: () => runCommand("tool.watermark") },
    { label: "Background", icon: <Image size={16} />, run: () => runCommand("tool.background") },
    { label: "Page numbers", icon: <ListOrdered size={16} />, run: () => runCommand("tool.pageNumbers") },
    { label: "Bates", icon: <Hash size={16} />, run: () => runCommand("tool.bates") },
  ],
  forms: [{ label: "All fields", icon: <Layers size={16} />, run: () => useSettings.getState().set({ rightPanel: "fields" }) }],
  redact: [
    { label: "Remove hidden info", icon: <ShieldCheck size={16} />, run: () => runCommand("tool.sanitize") },
    { label: "Apply redactions", icon: <EyeOff size={15} />, run: () => openDialog("apply-redactions"), main: true },
  ],
  measure: [{ label: "Scale & units", icon: <Settings2 size={16} />, run: () => openDialog("measure-scale") }],
  protect: [
    { label: "Encrypt with password", icon: <Lock size={16} />, run: () => runCommand("tool.protect") },
    { label: "Remove security", icon: <LockOpen size={16} />, run: () => runCommand("tool.removeSecurity") },
    { label: "Redact", icon: <EyeOff size={16} />, run: () => runCommand("mode.redact") },
    { label: "Remove hidden info", icon: <ShieldCheck size={16} />, run: () => runCommand("tool.sanitize") },
    { label: "Flatten", icon: <KeyRound size={16} />, run: () => runCommand("tool.flatten") },
  ],
};

/** Widths of the "More" button, of the gap between buttons and of the tools' scroll arrows. */
const MORE_WIDTH = 34;
const GAP = 2;
const SCROLL_ARROW = 28;

/**
 * A tool's labelled buttons, as many as fit in the space the toolbar has left; the rest are in a
 * "More" menu, so they never run over the buttons beside them however narrow the window is.
 */
function ToolActions({ actions, start }: { actions: ToolAction[]; start: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(() => new Set(actions.map((a) => a.label)));
  // Room kept for the main action (the tool buttons scroll first).
  const [keep, setKeep] = useState(0);
  const key = actions.map((a) => a.label).join("|");
  useLayoutEffect(() => {
    const el = box.current;
    const sizes = ghost.current;
    if (!el || !sizes) return;
    const fit = () => {
      const widths = [...sizes.children].map((c) => (c as HTMLElement).offsetWidth + GAP);
      const room = el.clientWidth;
      const all = widths.reduce((s, w) => s + w, 0) <= room;
      // The main action first, then the others in order, while they fit.
      const order = actions.map((_, i) => i).sort((i, j) => Number(!!actions[j].main) - Number(!!actions[i].main) || i - j);
      const fits = new Set<string>();
      let used = all ? 0 : MORE_WIDTH;
      for (const i of order) {
        if (used + widths[i] > room) break;
        used += widths[i];
        fits.add(actions[i].label);
      }
      setShown((prev) => (prev.size === fits.size && [...fits].every((l) => prev.has(l)) ? prev : fits));
      // Room for the main action, when the toolbar has it beside the buttons that always show.
      const main = widths.reduce((s, w, i) => s + (actions[i].main ? w : 0), 0);
      const want = main ? main + (actions.some((a) => !a.main) ? MORE_WIDTH : 0) : 0;
      const bar = el.parentElement;
      let spare = 0;
      if (want && bar) {
        const px = (v: string) => Number.parseFloat(v) || 0;
        const style = getComputedStyle(bar);
        spare = bar.clientWidth - px(style.paddingLeft) - px(style.paddingRight) - 2 * SCROLL_ARROW;
        for (const c of bar.children) {
          if (c === el || c.classList.contains("context-toolbar-tools") || c.classList.contains("toolbar-scroll")) continue;
          const cs = getComputedStyle(c);
          spare -= c.getBoundingClientRect().width + px(cs.marginLeft) + px(cs.marginRight) + GAP;
        }
      }
      setKeep(want && spare >= want ? want : 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const look = (a: ToolAction) => (a.main ? "btn btn-sm btn-danger" : "toolbar-text-btn");
  const more = actions.filter((a) => !shown.has(a.label));
  return (
    <div ref={box} className={`toolbar-actions${start ? " is-start" : ""}`} style={keep ? { minWidth: keep } : undefined}>
      {actions
        .filter((a) => shown.has(a.label))
        .map((a) => (
          <button key={a.label} className={look(a)} data-tip={a.tip} onClick={a.run}>
            {a.icon} {a.label}
          </button>
        ))}
      {more.length > 0 && (
        <MenuButton items={more.map((a) => ({ label: a.label, icon: a.icon, hint: a.tip, danger: a.main, onSelect: a.run }))} placement="bottom-end">
          {({ ref, onClick, open }) => <IconButton ref={ref} icon={<MoreHorizontal size={17} />} label="More" active={open} onClick={onClick} />}
        </MenuButton>
      )}
      {/* The buttons' widths, for working out how many fit. */}
      <div ref={ghost} className="toolbar-actions-sizes" aria-hidden>
        {actions.map((a) => (
          <span key={a.label} className={look(a)}>
            {a.icon} {a.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The tool buttons. When the window is too narrow for all of them, they scroll sideways (with
 * the mouse wheel or the arrows beside them) rather than pushing Undo and Redo away.
 */
function ToolsRow({ children }: { children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ back: false, more: false });
  const update = () => {
    const el = row.current;
    if (!el) return;
    const back = el.scrollLeft > 1;
    const more = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.back === back && e.more === more ? e : { back, more }));
  };
  // After every change of tools or styles, and whenever the row changes size.
  useLayoutEffect(update);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const scroll = (dir: number) => row.current?.scrollBy({ left: dir * Math.max(120, row.current.clientWidth * 0.6), behavior: "smooth" });
  const overflowing = edges.back || edges.more;
  return (
    <>
      {overflowing && <IconButton size="sm" className="toolbar-scroll" icon={<ChevronLeft size={16} />} label="Show earlier tools" disabled={!edges.back} onClick={() => scroll(-1)} />}
      <div
        ref={row}
        className={`context-toolbar-tools${edges.back ? " fade-start" : ""}${edges.more ? " fade-end" : ""}`}
        onWheel={(e) => {
          if (row.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) row.current.scrollLeft += e.deltaY;
        }}
      >
        {children}
      </div>
      {overflowing && <IconButton size="sm" className="toolbar-scroll" icon={<ChevronRight size={16} />} label="Show more tools" disabled={!edges.more} onClick={() => scroll(1)} />}
    </>
  );
}

export function ContextToolbar({ docId }: { docId: string }) {
  const phone = usePhone();
  const mode = useApp((s) => s.docs[docId]?.mode ?? "view");
  const canUndo = useApp((s) => s.docs[docId]?.canUndo);
  const canRedo = useApp((s) => s.docs[docId]?.canRedo);
  const undoLabel = useApp((s) => s.docs[docId]?.undoLabel);
  const redoLabel = useApp((s) => s.docs[docId]?.redoLabel);
  useApp((s) => s.tool);
  return (
    <div className={`context-toolbar mode-${mode}`} role="toolbar" aria-label={`${MODE_TITLES[mode] || "View"} tools`}>
      {mode !== "view" && (
        <span className="mode-chip">
          {MODE_TITLES[mode]}
          <button className="mode-chip-close" aria-label="Close tool" data-tip="Close tool" onClick={() => setMode(docId, "view")}>
            <X size={13} />
          </button>
        </span>
      )}
      {mode !== "organize" && (
        <>
          {/* On phones a finger scrolls the page: no Hand tool. */}
          <ToolButtons tools={phone ? [SELECT] : [SELECT, HAND]} />
          <Sep />
        </>
      )}
      <ToolsRow key={`tools-${mode}`}>
        <ModeTools mode={mode} />
      </ToolsRow>
      <ToolActions key={`actions-${mode}`} actions={ACTIONS[mode] ?? []} start={mode === "protect"} />
      <IconButton icon={<Undo2 size={17} />} label={undoLabel ? `Undo ${undoLabel}` : "Undo"} shortcut="Mod+Z" disabled={!canUndo} onClick={() => runCommand("edit.undo")} />
      <IconButton icon={<Redo2 size={17} />} label={redoLabel ? `Redo ${redoLabel}` : "Redo"} shortcut="Mod+Shift+Z" disabled={!canRedo} onClick={() => runCommand("edit.redo")} />
      {mode === "view" && !phone && (
        <>
          <Sep />
          <IconButton icon={<Search size={17} />} label="Find" shortcut="Mod+F" onClick={() => runCommand("edit.find")} />
          <IconButton icon={<FileDown size={17} />} label="Download" onClick={() => runCommand("file.saveAs")} />
        </>
      )}
    </div>
  );
}
