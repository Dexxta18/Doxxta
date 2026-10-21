import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { computePosition, type Placement } from "./Popover";
import { shortcutLabel } from "../../lib/util";

export type MenuItem =
  | {
      type?: "item";
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      hint?: string;
      onSelect: () => void;
    }
  | { type: "submenu"; label: string; icon?: ReactNode; disabled?: boolean; items: MenuItem[] | (() => MenuItem[]) }
  | { type: "separator" }
  | { type: "header"; label: string };

interface MenuListProps {
  items: MenuItem[];
  onClose: () => void;
  anchor: DOMRect;
  placement?: Placement;
  /** Close the whole menu chain (submenus pass the root closer). */
  depth?: number;
  onKeyLeft?: () => void;
  className?: string;
}

function isActionable(it: MenuItem) {
  return (it.type === undefined || it.type === "item" || it.type === "submenu") && !("disabled" in it && it.disabled);
}

export function MenuList({ items, onClose, anchor, placement = "bottom-start", depth = 0, onKeyLeft, className = "" }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(computePosition(anchor, { width: el.offsetWidth, height: el.offsetHeight }, placement));
  }, [anchor, placement, items]);

  useEffect(() => {
    if (depth === 0) ref.current?.focus();
  }, [depth]);

  const openSub = (index: number) => {
    const el = ref.current?.querySelectorAll<HTMLElement>("[data-menu-index]")[index];
    if (el) setSub({ index, rect: el.getBoundingClientRect() });
  };

  const activate = (index: number) => {
    const it = items[index];
    if (!it || !isActionable(it)) return;
    if (it.type === "submenu") {
      openSub(index);
      return;
    }
    if (it.type === undefined || it.type === "item") {
      onClose();
      // Let the menu unmount before running (dialogs may take focus).
      setTimeout(() => it.onSelect(), 0);
    }
  };

  const move = (dir: 1 | -1) => {
    if (!items.length) return;
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (isActionable(items[i])) {
        setActive(i);
        return;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (sub) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "ArrowRight":
        if (active >= 0 && items[active]?.type === "submenu") {
          e.preventDefault();
          openSub(active);
        }
        break;
      case "ArrowLeft":
        if (depth > 0) {
          e.preventDefault();
          onKeyLeft?.();
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        activate(active);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (depth > 0) onKeyLeft?.();
        else onClose();
        break;
    }
  };

  const subItems = sub ? items[sub.index] : null;

  return (
    <>
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        className={`menu ${className}`}
        onKeyDown={onKeyDown}
        style={{ position: "fixed", left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? "visible" : "hidden" }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => {
          if (it.type === "separator") return <div key={i} className="menu-sep" role="separator" />;
          if (it.type === "header") return <div key={i} className="menu-header">{it.label}</div>;
          const disabled = !!it.disabled;
          const isSub = it.type === "submenu";
          return (
            <div
              key={i}
              data-menu-index={i}
              role="menuitem"
              aria-disabled={disabled}
              aria-haspopup={isSub || undefined}
              className={`menu-item${active === i ? " is-active" : ""}${disabled ? " is-disabled" : ""}${
                !isSub && it.danger ? " is-danger" : ""
              }`}
              onPointerEnter={() => {
                setActive(i);
                clearTimeout(hoverTimer.current);
                if (isSub && !disabled) hoverTimer.current = setTimeout(() => openSub(i), 120);
                else hoverTimer.current = setTimeout(() => setSub(null), 150);
              }}
              onClick={() => activate(i)}
            >
              <span className="menu-icon">
                {!isSub && it.checked !== undefined ? it.checked ? <Check size={15} /> : null : it.icon}
              </span>
              <span className="menu-label">{it.label}</span>
              {!isSub && it.hint && <span className="menu-hint">{it.hint}</span>}
              {!isSub && it.shortcut && <span className="menu-shortcut">{shortcutLabel(it.shortcut)}</span>}
              {isSub && <ChevronRight size={14} className="menu-chevron" />}
            </div>
          );
        })}
      </div>
      {sub && subItems?.type === "submenu" && (
        <MenuList
          items={typeof subItems.items === "function" ? subItems.items() : subItems.items}
          anchor={sub.rect}
          placement="right-start"
          depth={depth + 1}
          onClose={onClose}
          onKeyLeft={() => {
            setSub(null);
            ref.current?.focus();
          }}
        />
      )}
    </>
  );
}

interface MenuRootProps {
  open: boolean;
  anchor: DOMRect | null;
  items: MenuItem[];
  onClose: () => void;
  placement?: Placement;
  ignore?: HTMLElement | null;
  className?: string;
}

/** A floating menu with outside-click handling, rendered in a portal. */
export function Menu({ open, anchor, items, onClose, placement, ignore, className }: MenuRootProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (ignore?.contains(t)) return;
      close();
    };
    const onBlur = () => close();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, close, ignore]);
  if (!open || !anchor) return null;
  return createPortal(
    <div ref={rootRef} className="menu-root">
      <MenuList items={items} anchor={anchor} placement={placement} onClose={close} className={className} />
    </div>,
    document.body,
  );
}

interface MenuButtonProps {
  items: MenuItem[] | (() => MenuItem[]);
  children: (props: { open: boolean; ref: React.RefObject<HTMLButtonElement | null>; onClick: () => void }) => ReactNode;
  placement?: Placement;
}

export function MenuButton({ items, children, placement }: MenuButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setAnchor(ref.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  };
  return (
    <>
      {children({ open, ref, onClick: toggle })}
      <Menu
        open={open}
        anchor={anchor}
        items={open ? (typeof items === "function" ? items() : items) : []}
        onClose={() => setOpen(false)}
        placement={placement}
        ignore={ref.current}
      />
    </>
  );
}
