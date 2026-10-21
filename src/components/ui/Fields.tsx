import { useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Popover } from "./Popover";
import { PALETTE } from "../../lib/colors";
import { Ban } from "lucide-react";

export function Field({ label, hint, error, children, inline }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; inline?: boolean }) {
  return (
    <label className={`field${inline ? " field-inline" : ""}${error ? " has-error" : ""}`}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...props} className={`input ${props.className ?? ""}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input textarea ${props.className ?? ""}`} />;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & { value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <span className={`number-input ${className}`}>
      <input
        type="number"
        className="input"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        {...rest}
      />
      {suffix && <span className="number-suffix">{suffix}</span>}
    </span>
  );
}

export function Select({ options, className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <select {...rest} className={`input select ${className}`}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className={`checkbox${disabled ? " is-disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox-box" aria-hidden />
      <span className="checkbox-text">
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Radio<T extends string>({ value, current, onChange, label, hint, disabled }: { value: T; current: T; onChange: (v: T) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`radio${disabled ? " is-disabled" : ""}`}>
      <input type="radio" checked={value === current} disabled={disabled} onChange={() => onChange(value)} />
      <span className="radio-dot" aria-hidden />
      <span className="checkbox-text">
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden>
        <span className="switch-thumb" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Slider({ value, onChange, min, max, step = 1, format, onCommit }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string; onCommit?: () => void }) {
  return (
    <span className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={onCommit}
        style={{ ["--pct" as string]: `${((value - min) / (max - min)) * 100}%` }}
      />
      <span className="slider-value">{format ? format(value) : value}</span>
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-tip={o.title}
          className={o.value === value ? "is-active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} className={`tab${t.value === value ? " is-active" : ""}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function ColorSwatches({ value, onChange, colors = PALETTE, allowNone, size = 22 }: { value: string | null; onChange: (c: string | null) => void; colors?: string[]; allowNone?: boolean; size?: number }) {
  const id = useId();
  return (
    <div className="swatches" role="radiogroup" aria-labelledby={id}>
      {allowNone && (
        <button
          type="button"
          className={`swatch swatch-none${value === null ? " is-active" : ""}`}
          style={{ width: size, height: size }}
          aria-label="No color"
          data-tip="No color"
          onClick={() => onChange(null)}
        >
          <Ban size={size - 8} />
        </button>
      )}
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch${value?.toLowerCase() === c.toLowerCase() ? " is-active" : ""}`}
          style={{ background: c, width: size, height: size }}
          aria-label={c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="swatch swatch-custom" style={{ width: size, height: size }} data-tip="Custom color">
        <input type="color" value={value ?? "#000000"} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

/** A compact color button that opens a swatch popover. */
export function ColorButton({ value, onChange, allowNone, label = "Color", colors }: { value: string | null; onChange: (c: string | null) => void; allowNone?: boolean; label?: string; colors?: string[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} type="button" className="color-btn" data-tip={label} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <span className={`color-btn-chip${value === null ? " is-none" : ""}`} style={{ background: value ?? "transparent" }} />
      </button>
      <Popover open={open} anchor={ref} onClose={() => setOpen(false)} ignoreRefs={[ref]} className="popover-pad">
        <div className="popover-title">{label}</div>
        <ColorSwatches
          value={value}
          colors={colors}
          allowNone={allowNone}
          onChange={(c) => {
            onChange(c);
          }}
        />
      </Popover>
    </>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action}
    </div>
  );
}
