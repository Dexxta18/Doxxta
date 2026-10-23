import {
  Droplet,
  EyeOff,
  FileDown,
  FilePen,
  FilePlus2,
  Files,
  FormInput,
  GitCompare,
  Hash,
  Heading,
  LayoutGrid,
  Lock,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Printer,
  Ruler,
  ScanText,
  Scissors,
  Stamp,
  Volume2,
  Image,
  ListOrdered,
  ShieldCheck,
  Layers,
} from "lucide-react";
import { useSettings } from "../../state/settings";
import { getCommand, isEnabled, runCommand } from "../../core/commands";
import { useApp } from "../../state/store";

interface ToolEntry {
  label: string;
  icon: React.ReactNode;
  command: string;
  color: string;
}

const GROUPS: { title: string; tools: ToolEntry[] }[] = [
  {
    title: "Popular",
    tools: [
      { label: "Add comments", icon: <MessageSquare size={17} />, command: "mode.comment", color: "#f5a524" },
      { label: "Fill & Sign", icon: <PenLine size={17} />, command: "mode.fillsign", color: "#d6409f" },
      { label: "Edit PDF", icon: <FilePen size={17} />, command: "mode.edit", color: "#e5484d" },
      { label: "Organize pages", icon: <LayoutGrid size={17} />, command: "mode.organize", color: "#12a594" },
      { label: "Export PDF", icon: <FileDown size={17} />, command: "tool.export", color: "#2f5bea" },
    ],
  },
  {
    title: "Create & combine",
    tools: [
      { label: "Create PDF", icon: <FilePlus2 size={17} />, command: "file.createBlank", color: "#0090ff" },
      { label: "Combine files", icon: <Files size={17} />, command: "file.combine", color: "#8e4ec6" },
      { label: "Split PDF", icon: <Scissors size={17} />, command: "tool.split", color: "#8e4ec6" },
      { label: "Insert pages", icon: <Layers size={17} />, command: "tool.insertPages", color: "#12a594" },
    ],
  },
  {
    title: "Forms & review",
    tools: [
      { label: "Prepare a form", icon: <FormInput size={17} />, command: "mode.forms", color: "#e54666" },
      { label: "Stamps", icon: <Stamp size={17} />, command: "tool.stamps", color: "#f76b15" },
      { label: "Measure", icon: <Ruler size={17} />, command: "mode.measure", color: "#0d74ce" },
      { label: "Compare files", icon: <GitCompare size={17} />, command: "tool.compare", color: "#0d74ce" },
    ],
  },
  {
    title: "Page marks",
    tools: [
      { label: "Watermark", icon: <Droplet size={17} />, command: "tool.watermark", color: "#0090ff" },
      { label: "Header & footer", icon: <Heading size={17} />, command: "tool.headerFooter", color: "#0090ff" },
      { label: "Page numbers", icon: <ListOrdered size={17} />, command: "tool.pageNumbers", color: "#0090ff" },
      { label: "Bates numbering", icon: <Hash size={17} />, command: "tool.bates", color: "#0090ff" },
      { label: "Background", icon: <Image size={17} />, command: "tool.background", color: "#0090ff" },
    ],
  },
  {
    title: "Protect & optimize",
    tools: [
      { label: "Protect", icon: <Lock size={17} />, command: "mode.protect", color: "#6e56cf" },
      { label: "Redact", icon: <EyeOff size={17} />, command: "mode.redact", color: "#343a46" },
      { label: "Remove hidden info", icon: <ShieldCheck size={17} />, command: "tool.sanitize", color: "#6e56cf" },
      { label: "Compress PDF", icon: <Minimize2 size={17} />, command: "tool.compress", color: "#30a46c" },
      { label: "Scan & OCR", icon: <ScanText size={17} />, command: "tool.ocr", color: "#0090ff" },
    ],
  },
  {
    title: "More",
    tools: [
      { label: "Read out loud", icon: <Volume2 size={17} />, command: "view.readAloud", color: "#5b6270" },
      { label: "Print", icon: <Printer size={17} />, command: "file.print", color: "#5b6270" },
    ],
  },
];

/** Every tool, by group, as a list (the "All tools" sheet on phones). */
export function ToolsList({ onPick }: { onPick?: () => void }) {
  const mode = useApp((s) => (s.activeId ? s.docs[s.activeId]?.mode : undefined));
  useApp((s) => (s.activeId ? `${s.activeId}:${s.docs[s.activeId]?.status}` : ""));
  return (
    <div className="tools-list">
      {GROUPS.map((g) => (
        <div key={g.title} className="tools-group">
          <div className="tools-group-title">{g.title}</div>
          {g.tools.map((t) => {
            const c = getCommand(t.command);
            const active = t.command.startsWith("mode.") && mode === t.command.slice(5);
            return (
              <button
                key={t.command}
                className={`tools-item${active ? " is-active" : ""}`}
                disabled={!isEnabled(c)}
                onClick={() => {
                  onPick?.();
                  runCommand(t.command);
                }}
              >
                <span className="tools-item-icon" style={{ color: t.color, background: `${t.color}17` }}>
                  {t.icon}
                </span>
                <span className="tools-item-label">{t.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function ToolsPanel() {
  const open = useSettings((s) => s.toolsPanelOpen);
  const mode = useApp((s) => (s.activeId ? s.docs[s.activeId]?.mode : undefined));
  // Re-render when the active document changes or finishes loading (tool availability).
  useApp((s) => (s.activeId ? `${s.activeId}:${s.docs[s.activeId]?.status}` : ""));
  const toggle = () => useSettings.getState().set({ toolsPanelOpen: !open });
  return (
    <aside className={`tools-panel scroll-thin${open ? "" : " is-collapsed"}`} aria-label="All tools">
      <div className="tools-panel-head">
        {open && <span className="tools-panel-title">All tools</span>}
        <button className="icon-btn icon-btn-sm" onClick={toggle} aria-label={open ? "Collapse tools" : "Expand tools"} data-tip={open ? "Collapse" : "All tools"} data-tip-side="right">
          {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>
      {GROUPS.map((g) => (
        <div key={g.title} className="tools-group">
          {open && <div className="tools-group-title">{g.title}</div>}
          {g.tools.map((t) => {
            const c = getCommand(t.command);
            const active = t.command.startsWith("mode.") && mode === t.command.slice(5);
            return (
              <button
                key={t.command}
                className={`tools-item${active ? " is-active" : ""}`}
                disabled={!isEnabled(c)}
                onClick={() => runCommand(t.command)}
                data-tip={open ? undefined : t.label}
                data-tip-side="right"
              >
                <span className="tools-item-icon" style={{ color: t.color, background: `${t.color}17` }}>
                  {t.icon}
                </span>
                {open && <span className="tools-item-label">{t.label}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
