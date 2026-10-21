import { useRef, useState } from "react";
import { Home, Moon, Plus, Sun, X, Save, Lock } from "lucide-react";
import { useApp } from "../../state/store";
import { useSettings } from "../../state/settings";
import { Menu } from "../ui/Menu";
import { MENUS } from "./menus";
import { closeDocument } from "../../core/document";
import { openFilesFromPicker, runCommand } from "../../core/commands";
import { IconButton } from "../ui/Button";

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden>
      <rect x="5" y="5" width="54" height="54" rx="14" fill="var(--accent)" />
      <path d="M47.5 13.5C33 15.5 22.5 25.5 18.6 40.6l-1.7 6.6 6.4-2.4C37.4 39.4 45.6 28.3 47.5 13.5z" fill="#fff" />
      <path d="M44 18L20.2 44.6" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M16.6 48.6l-3 3.9" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path d="M27 51.5h21" stroke="#9fb4ff" strokeWidth="3.6" strokeLinecap="round" />
    </svg>
  );
}

function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const show = (i: number) => {
    setAnchor(refs.current[i]?.getBoundingClientRect() ?? null);
    setOpen(i);
  };
  return (
    <nav className="menubar" aria-label="Main menu">
      {MENUS.map((m, i) => (
        <button
          key={m.label}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`menubar-item${open === i ? " is-open" : ""}`}
          onPointerDown={(e) => {
            e.preventDefault();
            if (open === i) setOpen(null);
            else show(i);
          }}
          onPointerEnter={() => open !== null && open !== i && show(i)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
              e.preventDefault();
              show(i);
            }
          }}
        >
          {m.label}
        </button>
      ))}
      {open !== null && (
        <Menu open anchor={anchor} items={MENUS[open].items()} onClose={() => setOpen(null)} ignore={refs.current[open]} />
      )}
    </nav>
  );
}

function Tabs() {
  const order = useApp((s) => s.order);
  const docs = useApp((s) => s.docs);
  const activeId = useApp((s) => s.activeId);
  return (
    <div className="tabs-strip scroll-thin" role="tablist">
      <button role="tab" aria-selected={activeId === null} className={`doc-tab doc-tab-home${activeId === null ? " is-active" : ""}`} onClick={() => useApp.setState({ activeId: null })} data-tip="Home">
        <Home size={15} />
      </button>
      {order.map((id) => {
        const d = docs[id];
        if (!d) return null;
        return (
          <div
            key={id}
            role="tab"
            aria-selected={activeId === id}
            className={`doc-tab${activeId === id ? " is-active" : ""}`}
            onClick={() => useApp.setState({ activeId: id })}
            onAuxClick={(e) => e.button === 1 && closeDocument(id)}
            title={d.name}
          >
            {d.status === "loading" ? <span className="spinner spinner-sm" /> : d.security.encrypted ? <Lock size={12} className="faint" /> : null}
            <span className="doc-tab-name">{d.name}</span>
            {d.dirty && <span className="doc-tab-dirty" aria-label="Unsaved changes" />}
            <button
              className="doc-tab-close"
              aria-label={`Close ${d.name}`}
              onClick={(e) => {
                e.stopPropagation();
                closeDocument(id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      <button className="doc-tab-new" aria-label="Open file" data-tip="Open file" data-tip-key="Mod+O" onClick={() => openFilesFromPicker()}>
        <Plus size={15} />
      </button>
    </div>
  );
}

export function TopBar() {
  const theme = useSettings((s) => s.theme);
  const activeDoc = useApp((s) => (s.activeId ? s.docs[s.activeId] : undefined));
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Logo />
        <span>Quillmark</span>
      </div>
      <MenuBar />
      <Tabs />
      <div className="topbar-actions">
        {activeDoc?.status === "ready" && (
          <button className={`btn btn-sm ${activeDoc.dirty ? "btn-primary" : "btn-ghost"}`} onClick={() => runCommand("file.save")} data-tip="Save" data-tip-key="Mod+S">
            <Save size={15} />
            <span className="btn-label hide-narrow">Save</span>
          </button>
        )}
        <IconButton
          icon={dark ? <Sun size={17} /> : <Moon size={17} />}
          label={dark ? "Light theme" : "Dark theme"}
          onClick={() => useSettings.getState().set({ theme: dark ? "light" : "dark" })}
        />
      </div>
    </header>
  );
}
