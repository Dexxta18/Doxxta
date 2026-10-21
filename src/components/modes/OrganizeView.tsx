import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Copy,
  FileOutput,
  FilePlus2,
  FileSymlink,
  Files,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  ChevronDown,
  Crop,
  Maximize,
} from "lucide-react";
import { useApp, openDialog, setMode, toast, withBusy } from "../../state/store";
import { getViewer } from "../../state/runtime";
import { PageThumb } from "../panels/PageThumb";
import { IconButton } from "../ui/Button";
import { Menu, type MenuItem } from "../ui/Menu";
import {
  deletePages,
  duplicatePages,
  extractToNewDocument,
  insertBlankPages,
  insertFromFiles,
  movePages,
  reversePages,
  rotatePages,
} from "../../ops/organize";
import { isImageFile, isPdfFile, pickFiles, plural, readFileBytes } from "../../lib/util";
import { formatPageRanges } from "../../lib/pageRanges";

export default function OrganizeView({ docId, onClose }: { docId: string; onClose: () => void }) {
  const pages = useApp((s) => s.docs[docId].pages);
  const current = useApp((s) => s.docs[docId].view.page);
  const [selected, setSelected] = useState<Set<number>>(new Set([current - 1]));
  const [anchor, setAnchor] = useState(current - 1);
  const [size, setSize] = useState(150);
  const [drag, setDrag] = useState<number[] | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ anchor: DOMRect; items: MenuItem[] } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const count = pages.length;

  // Keep the selection valid after pages are added/removed.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((i) => i < count)));
  }, [count]);

  const sel = [...selected].sort((a, b) => a - b);
  const busy = async (msg: string, fn: () => Promise<unknown>) => {
    await withBusy(msg, async () => {
      await fn();
    });
  };

  const click = (e: React.MouseEvent, i: number) => {
    if (e.shiftKey) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      setSelected(new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)));
    } else if (e.metaKey || e.ctrlKey) {
      const n = new Set(selected);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      setSelected(n);
      setAnchor(i);
    } else {
      setSelected(new Set([i]));
      setAnchor(i);
    }
  };

  const insertFiles = async (at: number, files: File[]) => {
    const pdfs = files.filter(isPdfFile);
    const images = files.filter(isImageFile);
    const sources: { name: string; bytes: Uint8Array }[] = [];
    for (const f of pdfs) sources.push({ name: f.name, bytes: await readFileBytes(f) });
    if (images.length) {
      const { imagesToPdf } = await import("../../ops/create");
      sources.push({ name: "images", bytes: await imagesToPdf(images, { pageSize: "fit", margin: 0 }) });
    }
    if (!sources.length) {
      toast("Drop PDF or image files to insert them", "warning");
      return;
    }
    await busy("Inserting pages…", () => insertFromFiles(docId, at, sources));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
      e.preventDefault();
      busy("Deleting pages…", () => deletePages(docId, sel));
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(pages.map((_, i) => i)));
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const next = Math.max(0, Math.min(count - 1, anchor + (e.key === "ArrowRight" ? 1 : -1)));
      setSelected(new Set([next]));
      setAnchor(next);
    }
  };

  const insertMenu = (rect: DOMRect, at: number): MenuItem[] => {
    void rect;
    return [
      { label: "Blank page", icon: <FilePlus2 size={15} />, onSelect: () => busy("Inserting…", () => insertBlankPages(docId, at, 1)) },
      {
        label: "From file…",
        icon: <Files size={15} />,
        onSelect: async () => {
          const files = await pickFiles("application/pdf,.pdf,image/*", true);
          if (files.length) await insertFiles(at, files);
        },
      },
      { label: "Insert pages dialog…", onSelect: () => openDialog("insert-pages", { docId, at }) },
    ];
  };

  const hasSel = sel.length > 0;

  return (
    <div className="organize" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="organize-toolbar">
        <span className="mode-chip">
          Organize pages
          <button className="mode-chip-close" aria-label="Close" onClick={onClose}>
            <X size={13} />
          </button>
        </span>
        <span className="faint organize-count">{hasSel ? `${sel.length} of ${count} selected (${formatPageRanges(sel)})` : plural(count, "page")}</span>
        <span className="toolbar-sep" />
        <button
          className="toolbar-text-btn"
          onClick={(e) => setMenu({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), items: insertMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), hasSel ? sel[sel.length - 1] + 1 : count) })}
        >
          <FilePlus2 size={16} /> Insert <ChevronDown size={13} />
        </button>
        <IconButton icon={<RotateCcw size={17} />} label="Rotate left" disabled={!hasSel} onClick={() => busy("Rotating…", () => rotatePages(docId, sel, -90))} />
        <IconButton icon={<RotateCw size={17} />} label="Rotate right" disabled={!hasSel} onClick={() => busy("Rotating…", () => rotatePages(docId, sel, 90))} />
        <IconButton icon={<Copy size={17} />} label="Duplicate" disabled={!hasSel} onClick={() => busy("Duplicating…", () => duplicatePages(docId, sel))} />
        <IconButton icon={<Trash2 size={17} />} label="Delete" shortcut="Delete" disabled={!hasSel || sel.length >= count} onClick={() => busy("Deleting…", () => deletePages(docId, sel))} />
        <span className="toolbar-sep" />
        <IconButton icon={<FileOutput size={17} />} label="Extract to new document" disabled={!hasSel} onClick={() => openDialog("extract-pages", { docId, pages: sel })} />
        <IconButton icon={<FileSymlink size={17} />} label="Replace with pages from a file" disabled={!hasSel} onClick={() => openDialog("insert-pages", { docId, replace: sel })} />
        <IconButton icon={<Scissors size={17} />} label="Split document" onClick={() => openDialog("split", { docId })} />
        <IconButton icon={<Crop size={17} />} label="Crop pages" disabled={!hasSel} onClick={() => openDialog("crop", { docId, pages: sel })} />
        <IconButton icon={<ArrowLeftRight size={17} />} label="Reverse page order" onClick={() => busy("Reordering…", () => reversePages(docId))} />
        <span className="spacer" />
        <IconButton icon={<ZoomOut size={17} />} label="Smaller" onClick={() => setSize((s) => Math.max(90, s - 30))} />
        <IconButton icon={<ZoomIn size={17} />} label="Larger" onClick={() => setSize((s) => Math.min(320, s + 30))} />
      </div>
      <div
        ref={gridRef}
        className="organize-grid scroll-thin"
        data-drop-zone
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 40}px, 1fr))` }}
        onDragOver={(e) => {
          if (drag || Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
        }}
        onDrop={async (e) => {
          e.preventDefault();
          const at = dropAt ?? count;
          setDropAt(null);
          if (drag) {
            const moving = drag;
            setDrag(null);
            await busy("Moving pages…", () => movePages(docId, moving, at));
            const first = at - moving.filter((i) => i < at).length;
            setSelected(new Set(moving.map((_, k) => first + k)));
            return;
          }
          const files = Array.from(e.dataTransfer.files);
          if (files.length) await insertFiles(at, files);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(new Set());
        }}
      >
        {pages.map((p, i) => (
          <div
            key={p.id}
            className={`org-item${selected.has(i) ? " is-selected" : ""}${drag?.includes(i) ? " is-dragging" : ""}${dropAt === i ? " drop-before" : ""}${dropAt === i + 1 && i === count - 1 ? " drop-after" : ""}`}
            draggable
            onDragStart={(e) => {
              const moving = selected.has(i) ? sel : [i];
              if (!selected.has(i)) setSelected(new Set([i]));
              setDrag(moving);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", `pages:${moving.join(",")}`);
            }}
            onDragEnd={() => {
              setDrag(null);
              setDropAt(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
            }}
            onClick={(e) => click(e, i)}
            onDoubleClick={() => {
              setMode(docId, "view");
              setTimeout(() => getViewer(docId)?.goToPage(i + 1), 100);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!selected.has(i)) {
                setSelected(new Set([i]));
                setAnchor(i);
              }
              const targets = selected.has(i) ? sel : [i];
              setMenu({
                anchor: new DOMRect(e.clientX, e.clientY, 0, 0),
                items: [
                  { label: "Rotate right", icon: <RotateCw size={15} />, onSelect: () => busy("Rotating…", () => rotatePages(docId, targets, 90)) },
                  { label: "Rotate left", icon: <RotateCcw size={15} />, onSelect: () => busy("Rotating…", () => rotatePages(docId, targets, -90)) },
                  { label: "Duplicate", icon: <Copy size={15} />, onSelect: () => busy("Duplicating…", () => duplicatePages(docId, targets)) },
                  { label: "Insert blank page after", icon: <FilePlus2 size={15} />, onSelect: () => busy("Inserting…", () => insertBlankPages(docId, Math.max(...targets) + 1, 1)) },
                  { label: "Extract…", icon: <FileOutput size={15} />, onSelect: () => extractToNewDocument(docId, targets) },
                  { label: "Open in viewer", icon: <Maximize size={15} />, onSelect: () => (setMode(docId, "view"), setTimeout(() => getViewer(docId)?.goToPage(i + 1), 100)) },
                  { type: "separator" },
                  { label: "Delete", icon: <Trash2 size={15} />, danger: true, disabled: targets.length >= count, onSelect: () => busy("Deleting…", () => deletePages(docId, targets)) },
                ],
              });
            }}
          >
            <div className="org-thumb">
              <PageThumb docId={docId} pageIndex={i} width={size} />
              <div className="org-actions" onClick={(e) => e.stopPropagation()}>
                <button aria-label="Rotate left" data-tip="Rotate left" onClick={() => busy("Rotating…", () => rotatePages(docId, [i], -90))}>
                  <RotateCcw size={14} />
                </button>
                <button aria-label="Rotate right" data-tip="Rotate right" onClick={() => busy("Rotating…", () => rotatePages(docId, [i], 90))}>
                  <RotateCw size={14} />
                </button>
                <button aria-label="Delete page" data-tip="Delete" disabled={count <= 1} onClick={() => busy("Deleting…", () => deletePages(docId, [i]))}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <span className="org-label">{p.label && p.label !== String(i + 1) ? `${p.label} (${i + 1})` : i + 1}</span>
            <button
              className="org-insert"
              aria-label="Insert pages here"
              data-tip="Insert"
              onClick={(e) => {
                e.stopPropagation();
                setMenu({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), items: insertMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), i + 1) });
              }}
            >
              <FilePlus2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <Menu open={!!menu} anchor={menu?.anchor ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </div>
  );
}
