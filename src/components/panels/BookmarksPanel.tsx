import { useEffect, useState } from "react";
import { BookmarkPlus, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Pencil, Trash2, Crosshair, Bookmark, CornerDownRight } from "lucide-react";
import { useApp, openContextMenu, toast } from "../../state/store";
import type { OutlineNode } from "../../state/types";
import { currentDestination, findNode, goToOutlineNode, insertNode, isDescendant, loadOutline, mapTree, removeNode, setOutline } from "../../core/outline";
import { EmptyState } from "../ui/Fields";
import { Spinner } from "../ui/Button";
import { uid } from "../../lib/util";

type DropPos = { id: string; where: "before" | "after" | "inside" } | null;

export default function BookmarksPanel({ docId }: { docId: string }) {
  const outline = useApp((s) => s.docs[docId].outline);
  const version = useApp((s) => s.docs[docId].version);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropPos>(null);

  useEffect(() => {
    if (outline === null) loadOutline(docId).catch(() => setOutline(docId, []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, version]);

  if (outline === null)
    return (
      <div className="center-fill">
        <Spinner />
      </div>
    );

  const addBookmark = (asChild = false) => {
    const dest = currentDestination(docId);
    if (!dest) return;
    const node: OutlineNode = { id: uid("o"), title: "Untitled bookmark", pageId: dest.pageId, top: dest.top, children: [] };
    setOutline(docId, insertNode(outline, node, selected, asChild ? "inside" : "after"));
    setSelected(node.id);
    setRenaming(node.id);
  };

  const rename = (id: string, title: string) => {
    setOutline(docId, mapTree(outline, (n) => (n.id === id ? { ...n, title: title.trim() || n.title } : n)));
    setRenaming(null);
  };

  const remove = (id: string) => {
    setOutline(docId, removeNode(outline, id));
    if (selected === id) setSelected(null);
  };

  const setDest = (id: string) => {
    const dest = currentDestination(docId);
    if (!dest) return;
    setOutline(docId, mapTree(outline, (n) => (n.id === id ? { ...n, pageId: dest.pageId, top: dest.top, url: undefined } : n)));
    toast("Bookmark now points to the current view", "success");
  };

  const toggleAll = (expand: boolean) => {
    if (expand) setCollapsed(new Set());
    else {
      const ids = new Set<string>();
      const walk = (ns: OutlineNode[]) => ns.forEach((n) => n.children.length && (ids.add(n.id), walk(n.children)));
      walk(outline);
      setCollapsed(ids);
    }
  };

  const onDrop = () => {
    if (!dragId || !drop || dragId === drop.id || isDescendant(outline, dragId, drop.id)) {
      setDragId(null);
      setDrop(null);
      return;
    }
    const node = findNode(outline, dragId)!;
    setOutline(docId, insertNode(removeNode(outline, dragId), node, drop.id, drop.where));
    setDragId(null);
    setDrop(null);
  };

  const menu = (e: React.MouseEvent, n: OutlineNode) => {
    e.preventDefault();
    setSelected(n.id);
    openContextMenu(e.clientX, e.clientY, [
      { type: "item", label: "Go to bookmark", icon: <Bookmark size={15} />, run: () => goToOutlineNode(docId, n) },
      { type: "item", label: "Rename", icon: <Pencil size={15} />, run: () => setRenaming(n.id) },
      { type: "item", label: "Set destination to current view", icon: <Crosshair size={15} />, run: () => setDest(n.id) },
      { type: "item", label: "Add child bookmark", icon: <CornerDownRight size={15} />, run: () => addBookmark(true) },
      { type: "item", label: n.bold ? "Remove bold" : "Bold", run: () => setOutline(docId, mapTree(outline, (x) => (x.id === n.id ? { ...x, bold: !x.bold } : x))) },
      { type: "item", label: n.italic ? "Remove italic" : "Italic", run: () => setOutline(docId, mapTree(outline, (x) => (x.id === n.id ? { ...x, italic: !x.italic } : x))) },
      { type: "separator" },
      { type: "item", label: "Delete", icon: <Trash2 size={15} />, danger: true, run: () => remove(n.id) },
    ]);
  };

  const renderNodes = (nodes: OutlineNode[], depth: number) =>
    nodes.map((n) => {
      const isCollapsed = collapsed.has(n.id);
      const dropHere = drop?.id === n.id ? drop.where : null;
      return (
        <div key={n.id} role="treeitem" aria-expanded={n.children.length ? !isCollapsed : undefined} aria-selected={selected === n.id}>
          <div
            className={`bm-row${selected === n.id ? " is-selected" : ""}${dropHere ? ` drop-${dropHere}` : ""}${dragId === n.id ? " is-dragging" : ""}`}
            style={{ paddingLeft: 6 + depth * 16 }}
            draggable={renaming !== n.id}
            onDragStart={(e) => {
              setDragId(n.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", n.title);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const y = (e.clientY - r.top) / r.height;
              setDrop({ id: n.id, where: y < 0.28 ? "before" : y > 0.72 ? "after" : "inside" });
            }}
            onDragEnd={() => {
              setDragId(null);
              setDrop(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDrop();
            }}
            onClick={() => {
              setSelected(n.id);
              goToOutlineNode(docId, n);
            }}
            onDoubleClick={() => setRenaming(n.id)}
            onContextMenu={(e) => menu(e, n)}
            onKeyDown={(e) => {
              if (e.key === "F2") setRenaming(n.id);
              if (e.key === "Delete") remove(n.id);
            }}
            tabIndex={0}
          >
            <button
              className="bm-toggle"
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              style={{ visibility: n.children.length ? "visible" : "hidden" }}
              onClick={(e) => {
                e.stopPropagation();
                const next = new Set(collapsed);
                if (isCollapsed) next.delete(n.id);
                else next.add(n.id);
                setCollapsed(next);
              }}
            >
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
            {renaming === n.id ? (
              <input
                className="input bm-input"
                autoFocus
                defaultValue={n.title}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => rename(n.id, e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") rename(n.id, (e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onFocus={(e) => e.target.select()}
              />
            ) : (
              <span className="bm-title" style={{ fontWeight: n.bold ? 700 : undefined, fontStyle: n.italic ? "italic" : undefined, color: n.color ?? undefined }}>
                {n.title}
              </span>
            )}
          </div>
          {!isCollapsed && n.children.length > 0 && <div role="group">{renderNodes(n.children, depth + 1)}</div>}
        </div>
      );
    });

  return (
    <div className="bookmarks-panel">
      <div className="panel-toolbar">
        <button className="btn btn-subtle btn-sm" onClick={() => addBookmark(false)} data-tip="Bookmark the current view">
          <BookmarkPlus size={15} /> Add
        </button>
        <span className="spacer" />
        <button className="icon-btn icon-btn-sm" aria-label="Expand all" data-tip="Expand all" onClick={() => toggleAll(true)}>
          <ChevronsUpDown size={15} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Collapse all" data-tip="Collapse all" onClick={() => toggleAll(false)}>
          <ChevronsDownUp size={15} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Rename" data-tip="Rename (F2)" disabled={!selected} onClick={() => selected && setRenaming(selected)}>
          <Pencil size={15} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Delete" data-tip="Delete" disabled={!selected} onClick={() => selected && remove(selected)}>
          <Trash2 size={15} />
        </button>
      </div>
      {outline.length === 0 ? (
        <EmptyState icon={<Bookmark size={22} />} title="No bookmarks">
          Bookmarks help readers jump to sections. Navigate to a spot and click Add.
        </EmptyState>
      ) : (
        <div className="bm-tree scroll-thin" role="tree" onDragOver={(e) => dragId && e.preventDefault()}>
          {renderNodes(outline, 0)}
        </div>
      )}
    </div>
  );
}
