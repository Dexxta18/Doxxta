import { lazy, Suspense, useRef } from "react";
import { Bookmark, GalleryVerticalEnd, Layers, MessageSquare, Paperclip, Search, FormInput, PanelRightClose } from "lucide-react";
import { useSettings } from "../../state/settings";
import { useApp } from "../../state/store";
import type { RightPanelId } from "../../state/types";
import { Spinner } from "../ui/Button";

const ThumbnailsPanel = lazy(() => import("../panels/ThumbnailsPanel"));
const BookmarksPanel = lazy(() => import("../panels/BookmarksPanel"));
const CommentsPanel = lazy(() => import("../panels/CommentsPanel"));
const AttachmentsPanel = lazy(() => import("../panels/AttachmentsPanel"));
const LayersPanel = lazy(() => import("../panels/LayersPanel"));
const SearchPanel = lazy(() => import("../panels/SearchPanel"));
const FieldsPanel = lazy(() => import("../panels/FieldsPanel"));

const PANELS: { id: RightPanelId; label: string; icon: React.ReactNode; forms?: boolean }[] = [
  { id: "thumbnails", label: "Page thumbnails", icon: <GalleryVerticalEnd size={18} /> },
  { id: "bookmarks", label: "Bookmarks", icon: <Bookmark size={18} /> },
  { id: "comments", label: "Comments", icon: <MessageSquare size={18} /> },
  { id: "search", label: "Search", icon: <Search size={18} /> },
  { id: "attachments", label: "Attachments", icon: <Paperclip size={18} /> },
  { id: "layers", label: "Layers", icon: <Layers size={18} /> },
  { id: "fields", label: "Form fields", icon: <FormInput size={18} /> },
];

export function RightPanel({ docId }: { docId: string }) {
  const panel = useSettings((s) => s.rightPanel);
  const width = useSettings((s) => s.rightPanelWidth);
  const commentCount = useApp((s) => s.docs[docId]?.annotations.filter((a) => a.kind !== "field" && a.kind !== "link" && a.kind !== "textedit" && !a.flatten).length ?? 0);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const set = (id: RightPanelId | null) => useSettings.getState().set({ rightPanel: id });

  return (
    <div className="right-area">
      {panel && (
        <section className="right-panel" style={{ width }} aria-label={PANELS.find((p) => p.id === panel)?.label}>
          <div
            className="right-panel-resizer"
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, w: width };
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              const w = Math.max(220, Math.min(560, drag.current.w - (e.clientX - drag.current.x)));
              useSettings.getState().set({ rightPanelWidth: w });
            }}
            onPointerUp={() => (drag.current = null)}
          />
          <header className="right-panel-head">
            <span className="right-panel-title">{PANELS.find((p) => p.id === panel)?.label}</span>
            <button className="icon-btn icon-btn-sm" aria-label="Close panel" data-tip="Close panel" onClick={() => set(null)}>
              <PanelRightClose size={16} />
            </button>
          </header>
          <div className="right-panel-body">
            <Suspense
              fallback={
                <div className="center-fill">
                  <Spinner />
                </div>
              }
            >
              {panel === "thumbnails" && <ThumbnailsPanel docId={docId} />}
              {panel === "bookmarks" && <BookmarksPanel docId={docId} />}
              {panel === "comments" && <CommentsPanel docId={docId} />}
              {panel === "attachments" && <AttachmentsPanel docId={docId} />}
              {panel === "layers" && <LayersPanel docId={docId} />}
              {panel === "search" && <SearchPanel docId={docId} />}
              {panel === "fields" && <FieldsPanel docId={docId} />}
            </Suspense>
          </div>
        </section>
      )}
      <nav className="right-rail" aria-label="Side panels">
        {PANELS.map((p) => (
          <button
            key={p.id}
            className={`icon-btn icon-btn-lg${panel === p.id ? " is-active" : ""}`}
            aria-label={p.label}
            aria-pressed={panel === p.id}
            data-tip={p.label}
            data-tip-side="left"
            onClick={() => set(panel === p.id ? null : p.id)}
          >
            {p.icon}
            {p.id === "comments" && commentCount > 0 && <span className="icon-btn-badge">{commentCount > 99 ? "99+" : commentCount}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
