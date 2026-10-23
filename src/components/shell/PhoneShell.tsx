import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, GalleryVerticalEnd, LayoutGrid, Menu as MenuIcon, Moon, MoreHorizontal, Search, Sun, X } from "lucide-react";
import { useApp } from "../../state/store";
import { useSettings } from "../../state/settings";
import { getViewer } from "../../state/runtime";
import { showSheet, usePhoneSheet, type PhoneSheet } from "../../state/phone";
import { usePhone } from "../../lib/device";
import { IconButton } from "../ui/Button";
import { Menu, type MenuItem } from "../ui/Menu";
import { MENUS, cmd } from "./menus";
import { PANELS, PanelContent } from "./RightPanel";
import { ToolsList } from "./ToolsPanel";

/**
 * The phone layout: the menus behind a menu button, the side panels and the tools as sheets
 * that cover the screen, and a bar at the bottom (tools, pages, page number, search, more).
 */

export function PhoneMenuButton() {
  return <IconButton icon={<MenuIcon size={20} />} label="Menu" onClick={() => showSheet("menu")} />;
}

function BarButton({ icon, label, badge, onClick, buttonRef }: { icon: ReactNode; label: string; badge?: number; onClick: () => void; buttonRef?: React.Ref<HTMLButtonElement> }) {
  return (
    <button ref={buttonRef} className="phone-bar-btn" onClick={onClick}>
      {icon}
      <span>{label}</span>
      {!!badge && <span className="icon-btn-badge">{badge > 99 ? "99+" : badge}</span>}
    </button>
  );
}

export function PhoneBar({ docId }: { docId: string }) {
  const page = useApp((s) => s.docs[docId].view.page);
  const count = useApp((s) => s.docs[docId].pages.length);
  const comments = useApp((s) => s.docs[docId]?.annotations.filter((a) => a.kind !== "field" && a.kind !== "link" && a.kind !== "textedit" && !a.flatten).length ?? 0);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState<DOMRect | null>(null);
  const v = () => getViewer(docId);
  const panel = (id: PhoneSheet, label: string): MenuItem => ({ label, icon: PANELS.find((p) => p.id === id)?.icon, onSelect: () => showSheet(id) });
  return (
    <nav className="phone-bar" aria-label="Document">
      <BarButton icon={<LayoutGrid size={20} />} label="Tools" onClick={() => showSheet("tools")} />
      <BarButton icon={<GalleryVerticalEnd size={20} />} label="Pages" onClick={() => showSheet("thumbnails")} />
      <div className="phone-pager">
        <button aria-label="Previous page" disabled={page <= 1} onClick={() => v()?.prevPage()}>
          <ChevronLeft size={20} />
        </button>
        <span aria-label={`Page ${page} of ${count}`}>
          {page} / {count}
        </span>
        <button aria-label="Next page" disabled={page >= count} onClick={() => v()?.nextPage()}>
          <ChevronRight size={20} />
        </button>
      </div>
      <BarButton icon={<Search size={20} />} label="Search" onClick={() => showSheet("search")} />
      <BarButton icon={<MoreHorizontal size={20} />} label="More" badge={comments} buttonRef={moreRef} onClick={() => setMore(moreRef.current?.getBoundingClientRect() ?? null)} />
      <Menu
        open={!!more}
        anchor={more}
        placement="top-end"
        onClose={() => setMore(null)}
        items={[
          panel("comments", comments ? `Comments (${comments})` : "Comments"),
          panel("bookmarks", "Bookmarks"),
          panel("attachments", "Attachments"),
          panel("layers", "Layers"),
          panel("fields", "Form fields"),
          { type: "separator" },
          { label: "Fit width", onSelect: () => v()?.setScale("page-width") },
          { label: "Fit page", onSelect: () => v()?.setScale("page-fit") },
          cmd("view.rotateCw"),
        ]}
      />
    </nav>
  );
}

/** The menus as one list: each menu under its name, submenus opening in place. */
function MenuSheet() {
  const theme = useSettings((s) => s.theme);
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const pick = (run: () => void) => () => {
    showSheet(null);
    run();
  };
  const list = (items: MenuItem[]): ReactNode[] =>
    items.map((it, i) => {
      if (it.type === "separator") return <div key={i} className="phone-menu-sep" />;
      if (it.type === "header") return <div key={i} className="phone-menu-heading">{it.label}</div>;
      if (it.type === "submenu") {
        return (
          <details key={i} className="phone-menu-sub">
            <summary className="phone-menu-item" aria-disabled={it.disabled}>
              <span className="phone-menu-icon">{it.icon}</span>
              <span className="phone-menu-label">{it.label}</span>
              <ChevronRight size={16} className="phone-menu-chevron" />
            </summary>
            <div className="phone-menu-nested">{list(typeof it.items === "function" ? it.items() : it.items)}</div>
          </details>
        );
      }
      return (
        <button key={i} className="phone-menu-item" disabled={it.disabled} onClick={pick(it.onSelect)}>
          <span className="phone-menu-icon">{it.icon}</span>
          <span className="phone-menu-label">{it.label}</span>
          {it.checked && <Check size={16} />}
        </button>
      );
    });
  return (
    <div className="phone-menu">
      {MENUS.map((m) => (
        <section key={m.label}>
          <h3 className="phone-menu-title">{m.label}</h3>
          {list(m.items())}
        </section>
      ))}
      <section>
        <h3 className="phone-menu-title">Appearance</h3>
        <button className="phone-menu-item" onClick={pick(() => useSettings.getState().set({ theme: dark ? "light" : "dark" }))}>
          <span className="phone-menu-icon">{dark ? <Sun size={16} /> : <Moon size={16} />}</span>
          <span className="phone-menu-label">{dark ? "Light theme" : "Dark theme"}</span>
        </button>
      </section>
    </div>
  );
}

/** Panels used to go somewhere in the document close once they have. */
const GOES_TO_PAGE = new Set<PhoneSheet>(["thumbnails", "bookmarks", "comments", "search", "fields"]);

export function PhoneSheetHost() {
  const sheet = usePhoneSheet((s) => s.sheet);
  const docId = useApp((s) => s.activeId);
  const phone = usePhone();
  const page = useApp((s) => (s.activeId ? s.docs[s.activeId]?.view.page : undefined));
  const shownAt = useRef(page);
  // Turning a tablet out of the phone layout closes the sheet.
  useEffect(() => {
    if (!phone) showSheet(null);
  }, [phone]);
  useEffect(() => {
    if (sheet && GOES_TO_PAGE.has(sheet) && page !== shownAt.current) showSheet(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  useEffect(() => {
    shownAt.current = page;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);
  if (!phone || !sheet) return null;
  const isPanel = sheet !== "menu" && sheet !== "tools";
  if (isPanel && !docId) return null;
  const title = sheet === "menu" ? "Menu" : sheet === "tools" ? "All tools" : PANELS.find((p) => p.id === sheet)?.label;
  return (
    <div className="phone-sheet" role="dialog" aria-modal aria-label={title}>
      <header className="phone-sheet-head">
        <span>{title}</span>
        <IconButton icon={<X size={20} />} label="Close" onClick={() => showSheet(null)} />
      </header>
      <div className={`phone-sheet-body${isPanel ? " is-panel" : ""}`}>
        {sheet === "menu" && <MenuSheet />}
        {sheet === "tools" && <ToolsList onPick={() => showSheet(null)} />}
        {isPanel && docId && <PanelContent docId={docId} panel={sheet} />}
      </div>
    </div>
  );
}
