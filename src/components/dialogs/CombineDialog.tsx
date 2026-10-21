import { useEffect, useState } from "react";
import { Files, GripVertical, Plus, Trash2, FileText, ImageIcon } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { EmptyState, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { useApp, withBusy, toast } from "../../state/store";
import { combine, type CombineSource } from "../../ops/combine";
import { openGenerated } from "../../core/document";
import { isImageFile, isPdfFile, pickFiles, readFileBytes, uid, formatBytes } from "../../lib/util";
import { openPdf, renderPageToCanvas } from "../../lib/pdfjs";
import { parsePageRanges } from "../../lib/pageRanges";
import { Menu } from "../ui/Menu";

interface Row extends CombineSource {
  thumb?: string;
  range: string;
  size?: number;
}

async function pdfInfo(bytes: Uint8Array): Promise<{ pages: number; thumb?: string }> {
  try {
    const { pdf } = await openPdf(bytes);
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const canvas = await renderPageToCanvas(page, { scale: 80 / vp.width });
    const thumb = canvas.toDataURL("image/jpeg", 0.7);
    const pages = pdf.numPages;
    await pdf.loadingTask.destroy();
    return { pages, thumb };
  } catch {
    // Encrypted files: count is unknown until the password is entered.
    return { pages: 0 };
  }
}

export default function CombineDialog({ close }: DialogProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [openMenu, setOpenMenu] = useState<DOMRect | null>(null);
  const docs = useApp((s) => s.docs);
  const order = useApp((s) => s.order);

  const addFiles = async (files: File[]) => {
    const next: Row[] = [];
    for (const f of files) {
      if (isPdfFile(f)) {
        const bytes = await readFileBytes(f);
        const info = await pdfInfo(bytes);
        next.push({ id: uid("c"), name: f.name, kind: "pdf", bytes, pageCount: info.pages, thumb: info.thumb, range: "", size: f.size });
      } else if (isImageFile(f)) {
        next.push({ id: uid("c"), name: f.name, kind: "image", file: f, pageCount: 1, thumb: URL.createObjectURL(f), range: "", size: f.size });
      }
    }
    if (!next.length) toast("Only PDF and image files can be combined", "warning");
    setRows((r) => [...r, ...next]);
  };

  // Start with the open documents, like Acrobat's "Add open files".
  useEffect(() => {
    const initial: Row[] = order
      .filter((id) => docs[id]?.status === "ready")
      .map((id) => ({ id: uid("c"), name: docs[id].name, kind: "open" as const, docId: id, pageCount: docs[id].pages.length, range: "" }));
    setRows(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = async () => {
    const sources: CombineSource[] = [];
    for (const r of rows) {
      let pages: number[] | undefined;
      if (r.range.trim() && r.pageCount) {
        try {
          pages = parsePageRanges(r.range, r.pageCount);
        } catch (e) {
          toast(`${r.name}: ${(e as Error).message}`, "error");
          return;
        }
      }
      sources.push({ ...r, pages });
    }
    close();
    await withBusy("Combining files…", async (p) => {
      const bytes = await combine(sources, p);
      await openGenerated(bytes, "Combined.pdf");
    });
  };

  const totalPages = rows.reduce((s, r) => {
    if (r.range.trim() && r.pageCount) {
      try {
        return s + parsePageRanges(r.range, r.pageCount).length;
      } catch {
        return s;
      }
    }
    return s + r.pageCount;
  }, 0);

  const openDocs = order.filter((id) => docs[id]?.status === "ready");

  return (
    <Dialog
      title="Combine files"
      icon={<Files size={18} />}
      subtitle="Merge PDFs and images into a single document. Drag to reorder."
      onClose={close}
      width={640}
      dismissable={false}
      footer={
        <>
          <span className="faint" style={{ marginRight: "auto", fontSize: 12 }}>
            {rows.length} files · {totalPages} pages
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go} disabled={rows.length < 1}>
            Combine
          </Button>
        </>
      }
    >
      <div
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation();
          addFiles(Array.from(e.dataTransfer.files));
        }}
        data-drop-zone
      >
        {rows.length === 0 ? (
          <EmptyState icon={<Files size={22} />} title="Add files to combine">
            Drop PDFs or images here, or use the buttons below.
          </EmptyState>
        ) : (
          <div className="file-list scroll-thin">
            {rows.map((r, i) => (
              <div
                key={r.id}
                className={`file-row${dragIdx === i ? " is-dragging" : ""}${overIdx === i && dragIdx !== i ? " drop-target" : ""}`}
                draggable
                onDragStart={() => setDragIdx(i)}
                onDragOver={(e) => {
                  if (dragIdx === null) return;
                  e.preventDefault();
                  setOverIdx(i);
                }}
                onDrop={(e) => {
                  if (dragIdx === null) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setRows((rs) => {
                    const next = [...rs];
                    const [m] = next.splice(dragIdx, 1);
                    next.splice(i, 0, m);
                    return next;
                  });
                  setDragIdx(null);
                  setOverIdx(null);
                }}
                onDragEnd={() => {
                  setDragIdx(null);
                  setOverIdx(null);
                }}
              >
                <GripVertical size={16} className="drag-grip" />
                <div className="file-row-thumb">{r.thumb ? <img src={r.thumb} alt="" /> : r.kind === "image" ? <ImageIcon size={18} /> : <FileText size={18} />}</div>
                <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                  <strong className="ellipsis">{r.name}</strong>
                  <span className="faint" style={{ fontSize: 11.5 }}>
                    {r.kind === "open" ? "Open document" : r.kind === "image" ? "Image" : "PDF"} · {r.pageCount ? `${r.pageCount} page${r.pageCount === 1 ? "" : "s"}` : "protected"}
                    {r.size ? ` · ${formatBytes(r.size)}` : ""}
                  </span>
                </div>
                {r.kind !== "image" && r.pageCount > 1 && (
                  <TextInput style={{ width: 110, height: 28 }} placeholder="All pages" value={r.range} onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, range: e.target.value } : x)))} aria-label="Pages to include" />
                )}
                <button className="icon-btn icon-btn-sm" aria-label="Remove" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="row">
        <Button icon={<Plus size={15} />} onClick={async () => addFiles(await pickFiles("application/pdf,.pdf,image/*", true))}>
          Add files…
        </Button>
        {openDocs.length > 0 && (
          <Button variant="ghost" onClick={(e) => setOpenMenu((e.currentTarget as HTMLElement).getBoundingClientRect())}>
            Add open document…
          </Button>
        )}
        <Menu
          open={!!openMenu}
          anchor={openMenu}
          onClose={() => setOpenMenu(null)}
          items={openDocs.map((id) => ({
            label: docs[id].name,
            onSelect: () => setRows((rs) => [...rs, { id: uid("c"), name: docs[id].name, kind: "open", docId: id, pageCount: docs[id].pages.length, range: "" }]),
          }))}
        />
      </div>
    </Dialog>
  );
}
