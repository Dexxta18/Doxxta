import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEffect } from "react";

export type Placement = "bottom-start" | "bottom-end" | "bottom" | "top-start" | "top-end" | "top" | "right-start" | "left-start";

/** Computes a fixed position for a floating element next to an anchor, flipping to stay on screen. */
export function computePosition(anchor: DOMRect, floating: { width: number; height: number }, placement: Placement, gap = 6) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = anchor.left;
  let y = anchor.bottom + gap;
  switch (placement) {
    case "bottom-end":
      x = anchor.right - floating.width;
      break;
    case "bottom":
      x = anchor.left + anchor.width / 2 - floating.width / 2;
      break;
    case "top-start":
      y = anchor.top - floating.height - gap;
      break;
    case "top-end":
      x = anchor.right - floating.width;
      y = anchor.top - floating.height - gap;
      break;
    case "top":
      x = anchor.left + anchor.width / 2 - floating.width / 2;
      y = anchor.top - floating.height - gap;
      break;
    case "right-start":
      x = anchor.right + 2;
      y = anchor.top - 4;
      if (x + floating.width > vw - 8) x = anchor.left - floating.width - 2;
      break;
    case "left-start":
      x = anchor.left - floating.width - 2;
      y = anchor.top - 4;
      if (x < 8) x = anchor.right + 2;
      break;
  }
  if (placement.startsWith("bottom") && y + floating.height > vh - 8 && anchor.top - floating.height - gap > 8) {
    y = anchor.top - floating.height - gap;
  }
  if (placement.startsWith("top") && y < 8) y = anchor.bottom + gap;
  x = Math.max(8, Math.min(x, vw - floating.width - 8));
  y = Math.max(8, Math.min(y, vh - floating.height - 8));
  return { x, y };
}

interface PopoverProps {
  open: boolean;
  anchor: RefObject<HTMLElement | null> | DOMRect | null;
  onClose: () => void;
  placement?: Placement;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Elements whose clicks should not close the popover (e.g. the trigger). */
  ignoreRefs?: RefObject<HTMLElement | null>[];
  role?: string;
}

export function Popover({ open, anchor, onClose, placement = "bottom-start", children, className = "", style, ignoreRefs = [], role }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = anchor instanceof DOMRect ? anchor : anchor?.current?.getBoundingClientRect();
      if (!rect) return;
      setPos(computePosition(rect, { width: el.offsetWidth, height: el.offsetHeight }, placement));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [open, anchor, placement]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (ignoreRefs.some((r) => r.current?.contains(t))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      className={`popover ${className}`}
      style={{ position: "fixed", left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? "visible" : "hidden", ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}
