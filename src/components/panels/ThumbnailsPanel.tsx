import { useEffect, useRef, useState } from "react";
import { RotateCw, RotateCcw, Trash2, FilePlus2, FileOutput, Copy, ZoomIn, ZoomOut } from "lucide-react";
import { openContextMenu, useApp } from "../../state/store";
import { getViewer } from "../../state/runtime";
import { PageThumb } from "./PageThumb";

export default function ThumbnailsPanel({ docId }: { docId: string }) {
  const pages = useApp((s) => s.docs[docId].pages);
  const current = useApp((s) => s.docs[docId].view.page);
  const [size, setSize] = useState(140);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-thumb-index="${current - 1}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current]);

  const pageMenu = async (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    const ops = await import("../../ops/organize");
    openContextMenu(e.clientX, e.clientY, [
      { type: "item", label: "Rotate clockwise", icon: <RotateCw size={15} />, run: () => ops.rotatePages(docId, [index], 90) },
      { type: "item", label: "Rotate counterclockwise", icon: <RotateCcw size={15} />, run: () => ops.rotatePages(docId, [index], -90) },
      { type: "separator" },
      { type: "item", label: "Insert blank page after", icon: <FilePlus2 size={15} />, run: () => ops.insertBlankPages(docId, index + 1, 1) },
      { type: "item", label: "Duplicate page", icon: <Copy size={15} />, run: () => ops.duplicatePages(docId, [index]) },
      { type: "item", label: "Extract page…", icon: <FileOutput size={15} />, run: () => ops.extractToNewDocument(docId, [index]) },
      { type: "separator" },
      { type: "item", label: "Delete page", icon: <Trash2 size={15} />, danger: true, disabled: pages.length <= 1, run: () => ops.deletePages(docId, [index]) },
    ]);
  };

  return (
    <div className="thumbs-panel">
      <div className="panel-toolbar">
        <span className="faint">{pages.length} pages</span>
        <span className="spacer" />
        <button className="icon-btn icon-btn-sm" aria-label="Smaller thumbnails" data-tip="Smaller" onClick={() => setSize((s) => Math.max(80, s - 30))}>
          <ZoomOut size={15} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Larger thumbnails" data-tip="Larger" onClick={() => setSize((s) => Math.min(260, s + 30))}>
          <ZoomIn size={15} />
        </button>
      </div>
      <div ref={listRef} className="thumbs-list scroll-thin" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 16}px, 1fr))` }}>
        {pages.map((p, i) => (
          <button
            key={p.id}
            data-thumb-index={i}
            className={`thumb-item${current === i + 1 ? " is-current" : ""}`}
            onClick={() => getViewer(docId)?.goToPage(i + 1)}
            onContextMenu={(e) => pageMenu(e, i)}
          >
            <PageThumb docId={docId} pageIndex={i} width={size} />
            <span className="thumb-label">{p.label && p.label !== String(i + 1) ? `${p.label} (${i + 1})` : i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
