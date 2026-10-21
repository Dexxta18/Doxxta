import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Columns2, File, Minus, Plus, RotateCw, ScrollText, Maximize2, MoveHorizontal } from "lucide-react";
import { useApp } from "../../state/store";
import { getViewer } from "../../state/runtime";
import { IconButton } from "../ui/Button";
import { Menu } from "../ui/Menu";
import { runCommand } from "../../core/commands";
import { cmd } from "./menus";
import { formatBytes } from "../../lib/util";

const PRESETS = [
  { value: "auto", label: "Automatic" },
  { value: "page-actual", label: "Actual size" },
  { value: "page-fit", label: "Fit page" },
  { value: "page-width", label: "Fit width" },
];
const PERCENTS = [50, 75, 100, 125, 150, 200, 300, 400];

export function StatusBar({ docId }: { docId: string }) {
  const view = useApp((s) => s.docs[docId].view);
  const pages = useApp((s) => s.docs[docId].pages);
  const fileSize = useApp((s) => s.docs[docId].fileSize);
  const dirty = useApp((s) => s.docs[docId].dirty);
  const savedAt = useApp((s) => s.docs[docId].savedAt);
  const count = pages.length;
  const label = pages[view.page - 1]?.label;
  const hasLabels = pages.some((p, i) => p.label && p.label !== String(i + 1));
  const [input, setInput] = useState(String(view.page));
  const [zoomMenu, setZoomMenu] = useState<DOMRect | null>(null);
  const [layoutMenu, setLayoutMenu] = useState<DOMRect | null>(null);
  const zoomRef = useRef<HTMLButtonElement>(null);
  const layoutRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setInput(hasLabels && label ? label : String(view.page)), [view.page, label, hasLabels]);

  const v = () => getViewer(docId);
  const go = () => {
    const viewer = v();
    if (!viewer) return;
    const byLabel = hasLabels ? pages.findIndex((p) => p.label === input.trim()) : -1;
    const n = byLabel >= 0 ? byLabel + 1 : parseInt(input, 10);
    if (Number.isFinite(n) && n >= 1 && n <= count) viewer.goToPage(n);
    else setInput(String(view.page));
  };

  const pct = Math.round(view.scale * 100);
  const layoutIcon = view.spreadMode !== 0 ? <Columns2 size={16} /> : view.scrollMode === 3 ? <File size={16} /> : view.scrollMode === 1 ? <MoveHorizontal size={16} /> : <ScrollText size={16} />;

  return (
    <footer className="statusbar">
      <div className="statusbar-group">
        <IconButton size="sm" icon={<ChevronsLeft size={16} />} label="First page" shortcut="Home" disabled={view.page <= 1} onClick={() => v()?.goToPage(1)} />
        <IconButton size="sm" icon={<ChevronLeft size={16} />} label="Previous page" disabled={view.page <= 1} onClick={() => v()?.prevPage()} />
        <input
          className="page-input"
          value={input}
          aria-label="Page number"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              go();
              (e.target as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
          onBlur={go}
          onFocus={(e) => e.target.select()}
        />
        <span className="muted page-count">
          {hasLabels ? `(${view.page} of ${count})` : `/ ${count}`}
        </span>
        <IconButton size="sm" icon={<ChevronRight size={16} />} label="Next page" disabled={view.page >= count} onClick={() => v()?.nextPage()} />
        <IconButton size="sm" icon={<ChevronsRight size={16} />} label="Last page" shortcut="End" disabled={view.page >= count} onClick={() => v()?.goToPage(count)} />
      </div>
      <div className="statusbar-group">
        <IconButton size="sm" icon={<Minus size={16} />} label="Zoom out" shortcut="Mod+-" onClick={() => v()?.zoomOut()} />
        <button ref={zoomRef} className="zoom-btn" onClick={() => setZoomMenu(zoomRef.current!.getBoundingClientRect())} aria-label="Zoom level">
          {pct}%
        </button>
        <IconButton size="sm" icon={<Plus size={16} />} label="Zoom in" shortcut="Mod+=" onClick={() => v()?.zoomIn()} />
        <IconButton size="sm" icon={<Maximize2 size={15} />} label="Fit page" shortcut="Mod+0" onClick={() => v()?.setScale(view.scaleValue === "page-fit" ? "page-width" : "page-fit")} />
        <span className="statusbar-sep" />
        <button ref={layoutRef} className="icon-btn icon-btn-sm" data-tip="Page display" onClick={() => setLayoutMenu(layoutRef.current!.getBoundingClientRect())}>
          {layoutIcon}
        </button>
        <IconButton size="sm" icon={<RotateCw size={15} />} label="Rotate view" onClick={() => runCommand("view.rotateCw")} />
      </div>
      <div className="statusbar-group statusbar-info">
        <span className="faint hide-narrow">{formatBytes(fileSize)}</span>
        <span className={`save-state${dirty ? " is-dirty" : ""}`}>{dirty ? "Unsaved changes" : savedAt ? "Saved" : ""}</span>
      </div>
      <Menu
        open={!!zoomMenu}
        anchor={zoomMenu}
        placement="top-start"
        onClose={() => setZoomMenu(null)}
        items={[
          ...PRESETS.map((p) => ({ label: p.label, checked: view.scaleValue === p.value, onSelect: () => v()?.setScale(p.value) })),
          { type: "separator" as const },
          ...PERCENTS.map((p) => ({ label: `${p}%`, checked: pct === p && !PRESETS.some((x) => x.value === view.scaleValue), onSelect: () => v()?.setScale(p / 100) })),
        ]}
      />
      <Menu
        open={!!layoutMenu}
        anchor={layoutMenu}
        placement="top-start"
        onClose={() => setLayoutMenu(null)}
        items={[cmd("view.singlePage"), cmd("view.continuous"), cmd("view.twoPage"), cmd("view.twoPageScroll"), cmd("view.coverPage"), { type: "separator" }, cmd("view.horizontal"), cmd("view.wrapped")]}
      />
    </footer>
  );
}
