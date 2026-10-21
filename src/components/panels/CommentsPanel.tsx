import { useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Highlighter,
  StickyNote,
  Type,
  PenLine,
  Square,
  Circle,
  Minus,
  Pentagon,
  Stamp,
  Image as ImageIcon,
  Check,
  EyeOff,
  Underline,
  Strikethrough,
  Waves,
  Send,
  Trash2,
  Download,
  Upload,
  FileText,
  Spline,
} from "lucide-react";
import { useApp, openContextMenu, updateDoc } from "../../state/store";
import { getViewer } from "../../state/runtime";
import { annotLabel, isCommentKind, type Annotation, type ReviewStatus } from "../../annotations/types";
import { addReply, editReply, setStatus } from "../../core/annotOps";
import { deleteAnnotations, updateAnnotation } from "../../state/annotActions";
import { formatRelative, formatDateTime } from "../../lib/util";
import { EmptyState } from "../ui/Fields";
import { Menu, type MenuItem } from "../ui/Menu";
import { runCommand } from "../../core/commands";
import { selectionRect } from "../../annotations/geometry";

const KIND_ICON: Partial<Record<Annotation["kind"], React.ReactNode>> = {
  highlight: <Highlighter size={14} />,
  underline: <Underline size={14} />,
  strikeout: <Strikethrough size={14} />,
  squiggly: <Waves size={14} />,
  note: <StickyNote size={14} />,
  freetext: <Type size={14} />,
  ink: <PenLine size={14} />,
  rect: <Square size={14} />,
  ellipse: <Circle size={14} />,
  line: <Minus size={14} />,
  polygon: <Pentagon size={14} />,
  polyline: <Spline size={14} />,
  stamp: <Stamp size={14} />,
  image: <ImageIcon size={14} />,
  symbol: <Check size={14} />,
  redact: <EyeOff size={14} />,
};

type SortKey = "page" | "date" | "author" | "type";

export function scrollToAnnotation(docId: string, a: Annotation, pageIndex: number) {
  const v = getViewer(docId);
  if (!v) return;
  const r = selectionRect(a);
  v.scrollToPoint(pageIndex, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2, { center: true });
}

export default function CommentsPanel({ docId }: { docId: string }) {
  const annotations = useApp((s) => s.docs[docId].annotations);
  const pages = useApp((s) => s.docs[docId].pages);
  const selection = useApp((s) => s.docs[docId].selection);
  const focusId = useApp((s) => s.focusCommentId);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("page");
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [authors, setAuthors] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<ReviewStatus>>(new Set());
  const [filterMenu, setFilterMenu] = useState<DOMRect | null>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pageIndex = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages]);
  const comments = useMemo(() => annotations.filter(isCommentKind), [annotations]);
  const allAuthors = useMemo(() => [...new Set(comments.map((a) => a.author))], [comments]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = comments.filter((a) => {
      if (kinds.size && !kinds.has(a.kind)) return false;
      if (authors.size && !authors.has(a.author)) return false;
      if (statuses.size && !statuses.has(a.status)) return false;
      if (q) {
        const hay = [a.contents, a.author, annotLabel(a), "markedText" in a ? a.markedText : "", a.kind === "freetext" ? a.text : "", ...a.replies.map((r) => r.contents)].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sort) {
        case "date":
          return b.modifiedAt.localeCompare(a.modifiedAt);
        case "author":
          return a.author.localeCompare(b.author);
        case "type":
          return annotLabel(a).localeCompare(annotLabel(b));
        default: {
          const d = (pageIndex.get(a.pageId) ?? 0) - (pageIndex.get(b.pageId) ?? 0);
          return d || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0];
        }
      }
    });
    return list;
  }, [comments, query, kinds, authors, statuses, sort, pageIndex]);

  useEffect(() => {
    if (!focusId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-comment-id="${focusId}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => el.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 250);
      useApp.setState({ focusCommentId: null });
    }
  }, [focusId, filtered]);

  const filterItems = (): MenuItem[] => [
    { type: "header", label: "Sort by" },
    ...(["page", "date", "author", "type"] as SortKey[]).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), checked: sort === k, onSelect: () => setSort(k) })),
    { type: "header", label: "Type" },
    ...[...new Set(comments.map((c) => c.kind))].map((k) => ({
      label: annotLabel(comments.find((c) => c.kind === k)!).replace(/^Stamp: .*/, "Stamp"),
      checked: kinds.has(k),
      onSelect: () => setKinds(toggle(kinds, k)),
    })),
    { type: "header", label: "Reviewer" },
    ...allAuthors.map((au) => ({ label: au, checked: authors.has(au), onSelect: () => setAuthors(toggle(authors, au)) })),
    { type: "header", label: "Status" },
    ...(["None", "Accepted", "Rejected", "Cancelled", "Completed"] as ReviewStatus[]).map((s) => ({ label: s === "None" ? "No status" : s, checked: statuses.has(s), onSelect: () => setStatuses(toggle(statuses, s)) })),
    { type: "separator" },
    { label: "Clear filters", onSelect: () => (setKinds(new Set()), setAuthors(new Set()), setStatuses(new Set())) },
  ];

  const filtersOn = kinds.size + authors.size + statuses.size > 0;
  let lastPage = -1;

  return (
    <div className="comments-panel">
      <div className="panel-toolbar">
        <div className="search-input">
          <Search size={14} />
          <input placeholder="Search comments" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <button ref={filterRef} className={`icon-btn icon-btn-sm${filtersOn ? " is-active" : ""}`} aria-label="Filter and sort" data-tip="Filter & sort" onClick={() => setFilterMenu(filterRef.current!.getBoundingClientRect())}>
          <SlidersHorizontal size={15} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          aria-label="More"
          data-tip="More"
          onClick={(e) =>
            openContextMenu(e.clientX, e.clientY, [
              { type: "item", label: "Export comments (XFDF)", icon: <Download size={15} />, run: () => runCommand("tool.exportComments") },
              { type: "item", label: "Import comments (XFDF)…", icon: <Upload size={15} />, run: () => runCommand("tool.importComments") },
              { type: "item", label: "Summarize comments (PDF)", icon: <FileText size={15} />, run: () => runCommand("tool.summarizeComments") },
              { type: "separator" },
              { type: "item", label: "Delete all comments", icon: <Trash2 size={15} />, danger: true, run: async () => (await import("../../core/annotOps")).deleteAllComments(docId) },
            ])
          }
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      <Menu open={!!filterMenu} anchor={filterMenu} items={filterMenu ? filterItems() : []} onClose={() => setFilterMenu(null)} placement="bottom-end" />
      {filtered.length === 0 ? (
        <EmptyState icon={<MessageSquare size={22} />} title={comments.length ? "No matching comments" : "No comments yet"}>
          {comments.length ? "Try a different search or clear the filters." : "Use the Comment tools to highlight text, add notes, draw and more."}
        </EmptyState>
      ) : (
        <div ref={listRef} className="comments-list scroll-thin">
          <div className="faint comments-count">
            {filtered.length} of {comments.length} comments
          </div>
          {filtered.map((a) => {
            const pi = pageIndex.get(a.pageId) ?? 0;
            const header = sort === "page" && pi !== lastPage;
            lastPage = pi;
            return (
              <div key={a.id}>
                {header && <div className="comments-page">Page {pages[pi]?.label ?? pi + 1}</div>}
                <CommentCard docId={docId} a={a} pageIndex={pi} selected={selection.includes(a.id)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  return n;
}

function CommentCard({ docId, a, pageIndex, selected }: { docId: string; a: Annotation; pageIndex: number; selected: boolean }) {
  const [text, setText] = useState(a.contents);
  const [reply, setReply] = useState("");
  const [editingReply, setEditingReply] = useState<string | null>(null);
  useEffect(() => setText(a.contents), [a.contents]);
  const marked = "markedText" in a ? a.markedText : undefined;
  const color = a.kind === "freetext" ? a.textColor : a.color;

  const select = () => {
    updateDoc(docId, { selection: [a.id] });
    scrollToAnnotation(docId, a, pageIndex);
  };

  return (
    <div data-comment-id={a.id} className={`comment-card${selected ? " is-selected" : ""}`} onClick={select}>
      <div className="comment-head">
        <span className="comment-kind" style={{ color, background: `${color}22` }}>
          {KIND_ICON[a.kind] ?? <MessageSquare size={14} />}
        </span>
        <div className="col" style={{ gap: 0, minWidth: 0, flex: 1 }}>
          <span className="comment-author ellipsis">{a.author}</span>
          <span className="faint comment-date" title={formatDateTime(a.modifiedAt)}>
            {annotLabel(a)} · {formatRelative(a.modifiedAt)}
          </span>
        </div>
        {a.status !== "None" && <span className={`badge ${a.status === "Accepted" || a.status === "Completed" ? "badge-success" : a.status === "Rejected" ? "badge-danger" : ""}`}>{a.status}</span>}
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Comment options"
          onClick={(e) => {
            e.stopPropagation();
            openContextMenu(e.clientX, e.clientY, [
              ...(["Accepted", "Rejected", "Cancelled", "Completed", "None"] as const).map((s) => ({
                type: "item" as const,
                label: s === "None" ? "Clear status" : `Set status: ${s}`,
                run: () => setStatus(docId, [a.id], s),
              })),
              { type: "separator" as const },
              { type: "item" as const, label: "Delete", icon: <Trash2 size={15} />, danger: true, run: () => deleteAnnotations(docId, [a.id]) },
            ]);
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
      {marked && <blockquote className="comment-quote">{marked}</blockquote>}
      {a.kind === "freetext" && <div className="comment-quote">{a.text}</div>}
      <textarea
        className="comment-text"
        placeholder={a.kind === "freetext" ? "Add a comment…" : "Add a comment…"}
        value={text}
        rows={Math.min(8, Math.max(1, text.split("\n").length))}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
        }}
        onBlur={() => text !== a.contents && updateAnnotation(docId, a.id, { contents: text }, "Edit comment")}
      />
      {a.replies.length > 0 && (
        <div className="comment-replies">
          {a.replies.map((r) => (
            <div key={r.id} className="comment-reply" onClick={(e) => e.stopPropagation()}>
              <div className="row" style={{ gap: 6 }}>
                <strong className="ellipsis" style={{ fontSize: 12 }}>
                  {r.author}
                </strong>
                <span className="faint" style={{ fontSize: 11 }}>
                  {formatRelative(r.modifiedAt)}
                </span>
                <span className="spacer" />
                <button className="link-btn" onClick={() => setEditingReply(editingReply === r.id ? null : r.id)}>
                  Edit
                </button>
                <button className="link-btn" onClick={() => editReply(docId, a.id, r.id, null)}>
                  Delete
                </button>
              </div>
              {editingReply === r.id ? (
                <textarea
                  className="comment-text"
                  autoFocus
                  defaultValue={r.contents}
                  onKeyDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    if (e.target.value !== r.contents) editReply(docId, a.id, r.id, e.target.value);
                    setEditingReply(null);
                  }}
                />
              ) : (
                <div className="comment-reply-text">{r.contents}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {selected && (
        <form
          className="comment-reply-form"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            addReply(docId, a.id, reply.trim());
            setReply("");
          }}
        >
          <input className="input" placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button type="submit" className="icon-btn icon-btn-md" aria-label="Send reply" disabled={!reply.trim()}>
            <Send size={15} />
          </button>
        </form>
      )}
    </div>
  );
}
