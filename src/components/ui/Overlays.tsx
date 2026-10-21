import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { closeContextMenu, dismissToast, useApp } from "../../state/store";
import { MenuList, type MenuItem } from "./Menu";
import { shortcutLabel } from "../../lib/util";

/**
 * One tooltip for the whole app: any element with `data-tip` gets a tooltip
 * (with an optional `data-tip-key` shortcut) after a short hover delay.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; key?: string; rect: DOMRect; side: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const current = useRef<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Once a tooltip has been shown, neighbouring buttons show theirs quickly.
    let lastShownAt = 0;
    const hide = () => {
      clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as HTMLElement)?.closest?.<HTMLElement>("[data-tip]");
      if (el === current.current) return;
      clearTimeout(timer.current);
      current.current = el;
      if (!el || !el.dataset.tip) {
        setTip((t) => {
          if (t) lastShownAt = Date.now();
          return null;
        });
        return;
      }
      const delay = Date.now() - lastShownAt < 700 ? 40 : 450;
      timer.current = setTimeout(() => {
        if (!el.isConnected) return;
        lastShownAt = Date.now();
        setTip({ text: el.dataset.tip!, key: el.dataset.tipKey, rect: el.getBoundingClientRect(), side: el.dataset.tipSide ?? "bottom" });
      }, delay);
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("blur", hide);
    document.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("blur", hide);
      document.removeEventListener("scroll", hide, true);
    };
  }, []);

  useEffect(() => {
    if (!tip || !ref.current) {
      setPos(null);
      return;
    }
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    const r = tip.rect;
    let x = r.left + r.width / 2 - w / 2;
    let y = r.bottom + 6;
    if (tip.side === "top" || y + h > window.innerHeight - 4) y = r.top - h - 6;
    if (tip.side === "right") {
      x = r.right + 8;
      y = r.top + r.height / 2 - h / 2;
    }
    if (tip.side === "left") {
      x = r.left - w - 8;
      y = r.top + r.height / 2 - h / 2;
    }
    x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
    setPos({ x, y });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" role="tooltip" style={{ left: pos?.x ?? -999, top: pos?.y ?? -999, opacity: pos ? 1 : 0 }}>
      {tip.text}
      {tip.key && <span className="tooltip-key">{shortcutLabel(tip.key)}</span>}
    </div>,
    document.body,
  );
}

const TOAST_ICONS = {
  info: <Info size={17} />,
  success: <CheckCircle2 size={17} />,
  error: <XCircle size={17} />,
  warning: <AlertTriangle size={17} />,
};

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span className="toast-icon">{TOAST_ICONS[t.kind]}</span>
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function BusyOverlay() {
  const busy = useApp((s) => s.busy);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShow(false);
      return;
    }
    // Avoid flashing the overlay for quick operations.
    const t = setTimeout(() => setShow(true), 180);
    return () => clearTimeout(t);
  }, [busy]);
  if (!busy) return null;
  return createPortal(
    <div className={`busy-backdrop${show ? " is-visible" : ""}`}>
      {show && (
        <div className="busy-card" role="status">
          <div className="busy-row">
            <span className="spinner spinner-md" />
            <div className="col" style={{ gap: 2, minWidth: 0 }}>
              <strong>{busy.message}</strong>
              {busy.detail && <span className="muted ellipsis">{busy.detail}</span>}
            </div>
          </div>
          {busy.progress !== undefined && (
            <div className="progress">
              <div className="progress-bar" style={{ width: `${Math.round(busy.progress * 100)}%` }} />
            </div>
          )}
          {busy.cancel && (
            <button className="btn btn-secondary btn-sm" onClick={busy.cancel}>
              Cancel
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

export function ContextMenuHost() {
  const menu = useApp((s) => s.contextMenu);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".menu")) closeContextMenu();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", closeContextMenu);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", closeContextMenu);
    };
  }, [menu]);
  if (!menu) return null;
  const items: MenuItem[] = menu.items.map((it) =>
    it.type === "separator"
      ? { type: "separator" }
      : { label: it.label, icon: it.icon, shortcut: it.shortcut, danger: it.danger, disabled: it.disabled, onSelect: it.run },
  );
  return createPortal(
    <div className="menu-root">
      <MenuList items={items} anchor={new DOMRect(menu.x, menu.y, 0, 0)} onClose={closeContextMenu} />
    </div>,
    document.body,
  );
}
