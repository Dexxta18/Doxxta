import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, loading, block, className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`btn btn-${variant} btn-${size}${block ? " btn-block" : ""} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner spinner-sm" /> : icon}
      {children != null && <span className="btn-label">{children}</span>}
      {iconRight}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: "sm" | "md" | "lg";
  badge?: ReactNode;
  tipSide?: "top" | "bottom" | "left" | "right";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, active, size = "md", badge, className = "", tipSide, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-tip={label}
      data-tip-key={shortcut}
      data-tip-side={tipSide}
      className={`icon-btn icon-btn-${size}${active ? " is-active" : ""} ${className}`}
      {...rest}
    >
      {icon}
      {badge != null && <span className="icon-btn-badge">{badge}</span>}
    </button>
  );
});

export function Spinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return <span className={`spinner spinner-${size}`} role="status" aria-label="Loading" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
