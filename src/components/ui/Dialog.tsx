import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface DialogProps {
  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  /** Closing by clicking the backdrop (off for dialogs with unsaved input). */
  dismissable?: boolean;
  className?: string;
  bodyClassName?: string;
}

export function Dialog({ title, icon, subtitle, onClose, children, footer, width = 480, dismissable = true, className = "", bodyClassName = "" }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<Element | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement;
    const el = ref.current;
    // Focus the first input, else the dialog itself.
    const first = el?.querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]):not([disabled]), textarea, select");
    (first ?? el)?.focus();
    return () => {
      if (prevFocus.current instanceof HTMLElement) prevFocus.current.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
    if (e.key === "Tab" && ref.current) {
      const focusables = Array.from(
        ref.current.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      ).filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    e.stopPropagation();
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`dialog ${className}`}
        style={{ width }}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-header">
          {icon && <span className="dialog-icon">{icon}</span>}
          <div className="dialog-titles">
            <h2 className="dialog-title">{title}</h2>
            {subtitle && <p className="dialog-subtitle">{subtitle}</p>}
          </div>
          <button className="icon-btn icon-btn-md dialog-close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className={`dialog-body scroll-thin ${bodyClassName}`}>{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
