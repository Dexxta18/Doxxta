import { useEffect, useState } from "react";
import {
  Clock,
  FileDown,
  FilePen,
  FilePlus2,
  Files,
  FolderOpen,
  LayoutGrid,
  Link2,
  Lock,
  MessageSquare,
  Minimize2,
  PenLine,
  ScanText,
  Star,
  Trash2,
  Upload,
  EyeOff,
  GitCompare,
  FormInput,
} from "lucide-react";
import { clearRecent, getRecentFile, loadRecent, removeRecent, toggleStar, useRecent, type RecentEntry } from "../../lib/recent";
import { openBytes } from "../../core/document";
import { openFilesFromPicker, runCommand } from "../../core/commands";
import { openDialog, toast } from "../../state/store";
import { formatBytes, formatRelative } from "../../lib/util";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/Fields";
import { Logo } from "./TopBar";

const QUICK_TOOLS: { label: string; desc: string; icon: React.ReactNode; command: string; color: string }[] = [
  { label: "Edit PDF", desc: "Change text, add images and links", icon: <FilePen size={20} />, command: "mode.edit", color: "#e5484d" },
  { label: "Export PDF", desc: "Word, Excel, PowerPoint, images", icon: <FileDown size={20} />, command: "tool.export", color: "#2f5bea" },
  { label: "Combine files", desc: "Merge PDFs and images", icon: <Files size={20} />, command: "file.combine", color: "#8e4ec6" },
  { label: "Organize pages", desc: "Reorder, rotate, insert, delete", icon: <LayoutGrid size={20} />, command: "mode.organize", color: "#12a594" },
  { label: "Fill & Sign", desc: "Complete forms and sign", icon: <PenLine size={20} />, command: "mode.fillsign", color: "#d6409f" },
  { label: "Add comments", desc: "Highlight, notes, drawings", icon: <MessageSquare size={20} />, command: "mode.comment", color: "#f5a524" },
  { label: "Scan & OCR", desc: "Make scans searchable", icon: <ScanText size={20} />, command: "tool.ocr", color: "#0090ff" },
  { label: "Compress", desc: "Reduce file size", icon: <Minimize2 size={20} />, command: "tool.compress", color: "#30a46c" },
  { label: "Protect", desc: "Passwords & permissions", icon: <Lock size={20} />, command: "mode.protect", color: "#6e56cf" },
  { label: "Redact", desc: "Permanently remove content", icon: <EyeOff size={20} />, command: "mode.redact", color: "#343a46" },
  { label: "Prepare a form", desc: "Add fillable fields", icon: <FormInput size={20} />, command: "mode.forms", color: "#e54666" },
  { label: "Compare files", desc: "See what changed", icon: <GitCompare size={20} />, command: "tool.compare", color: "#0d74ce" },
];

/** Tools that need a document: ask for one first, then start the tool. */
async function startTool(command: string) {
  const needsDoc = !["file.combine", "tool.compare"].includes(command);
  if (needsDoc) {
    pendingCommand = command;
    await openFilesFromPicker();
    return;
  }
  runCommand(command);
}

let pendingCommand: string | null = null;

/** Called after a document becomes active to run a tool chosen from Home. */
export function consumePendingCommand() {
  const c = pendingCommand;
  pendingCommand = null;
  if (c) setTimeout(() => runCommand(c), 50);
}

export function HomeScreen() {
  const { entries, loaded } = useRecent();
  const [filter, setFilter] = useState<"all" | "starred">("all");
  useEffect(() => {
    if (!loaded) loadRecent();
  }, [loaded]);

  const shown = filter === "starred" ? entries.filter((e) => e.starred) : entries;

  const openRecent = async (e: RecentEntry) => {
    const f = await getRecentFile(e.id);
    if (!f) {
      toast("This file isn't stored offline anymore — open it again from your computer.", "warning");
      return;
    }
    await openBytes(f.bytes, e.name, { fileHandle: f.handle });
  };

  return (
    <div className="home scroll-thin">
      <div className="home-inner">
        <section className="home-hero">
          <div className="home-hero-text">
            <div className="home-brand">
              <Logo />
              <span>Quillmark</span>
            </div>
            <h1>Everything you need to work with PDFs.</h1>
            <p className="muted">Read, comment, sign, edit, organize, convert and protect — privately, right in your browser. Your files never leave this device.</p>
          </div>
          <div
            className="dropzone"
            onClick={() => openFilesFromPicker()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openFilesFromPicker()}
          >
            <div className="dropzone-icon">
              <Upload size={26} />
            </div>
            <strong>Drop PDF files here</strong>
            <span className="muted">or click to choose files</span>
            <div className="row" style={{ marginTop: 10, flexWrap: "wrap", justifyContent: "center" }} onClick={(e) => e.stopPropagation()}>
              <Button variant="primary" icon={<FolderOpen size={16} />} onClick={() => openFilesFromPicker()}>
                Open file
              </Button>
              <Button icon={<FilePlus2 size={16} />} onClick={() => openDialog("create", { tab: "blank" })}>
                Create
              </Button>
              <Button icon={<Link2 size={16} />} onClick={() => openDialog("open-url")}>
                From URL
              </Button>
            </div>
          </div>
        </section>

        <section>
          <h2 className="home-h2">Tools</h2>
          <div className="quick-tools">
            {QUICK_TOOLS.map((t) => (
              <button key={t.command} className="quick-tool" onClick={() => startTool(t.command)}>
                <span className="quick-tool-icon" style={{ background: `${t.color}1a`, color: t.color }}>
                  {t.icon}
                </span>
                <span className="quick-tool-text">
                  <strong>{t.label}</strong>
                  <span className="muted">{t.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 className="home-h2" style={{ margin: 0 }}>
              Recent files
            </h2>
            <div className="segmented segmented-sm" style={{ marginLeft: 8 }}>
              <button className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>
                All
              </button>
              <button className={filter === "starred" ? "is-active" : ""} onClick={() => setFilter("starred")}>
                Starred
              </button>
            </div>
            <span className="spacer" />
            {entries.length > 0 && (
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => clearRecent()}>
                Clear list
              </Button>
            )}
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={<Clock size={22} />} title={filter === "starred" ? "No starred files" : "No recent files yet"}>
              Files you open appear here so you can get back to them quickly. They're stored only in this browser.
            </EmptyState>
          ) : (
            <div className="recent-grid">
              {shown.map((e) => (
                <div key={e.id} className="recent-card" role="button" tabIndex={0} onClick={() => openRecent(e)} onKeyDown={(ev) => ev.key === "Enter" && openRecent(e)}>
                  <div className="recent-thumb">{e.thumb ? <img src={e.thumb} alt="" /> : <div className="recent-thumb-ph" />}</div>
                  <div className="recent-meta">
                    <strong className="ellipsis" title={e.name}>
                      {e.name}
                    </strong>
                    <span className="faint">
                      {formatRelative(e.openedAt)} · {e.pageCount} {e.pageCount === 1 ? "page" : "pages"} · {formatBytes(e.size)}
                    </span>
                  </div>
                  <div className="recent-actions" onClick={(ev) => ev.stopPropagation()}>
                    <button className={`icon-btn icon-btn-sm${e.starred ? " is-starred" : ""}`} aria-label={e.starred ? "Unstar" : "Star"} data-tip={e.starred ? "Unstar" : "Star"} onClick={() => toggleStar(e.id)}>
                      <Star size={14} fill={e.starred ? "currentColor" : "none"} />
                    </button>
                    <button className="icon-btn icon-btn-sm" aria-label="Remove from list" data-tip="Remove from list" onClick={() => removeRecent(e.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
