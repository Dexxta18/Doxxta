import { useEffect, useId, useRef, useState } from "react";
import { AArrowDown, AArrowUp, AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, Bold, Check, Highlighter, Italic, RemoveFormatting, Strikethrough, Underline } from "lucide-react";
import { IconButton } from "../components/ui/Button";
import { ColorSwatches } from "../components/ui/Fields";
import { Popover } from "../components/ui/Popover";
import type { TextAlign } from "../ops/editText";
import { HIGHLIGHT_COLORS, TEXT_COLORS } from "../lib/colors";
import { FONT_SIZES, type Toggle } from "./richText";

/** The formatting of the selection, as the toolbar shows it (undefined where it's mixed). */
export interface FormatState {
  family?: string;
  size?: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Color given to the text; null: its own. */
  color?: string | null;
  /** Highlight color; null: none. */
  highlight?: string | null;
  align: TextAlign;
  /** The font isn't on the computer: the one used for letters the PDF doesn't include. */
  standIn?: string;
}

export interface FontMenu {
  /** Families the page uses. */
  document: string[];
  /** The app's fonts, then the computer's. */
  others: { family: string; installed: boolean }[];
}

const MIXED = "\u0000";
const sizeLabel = (s: number | undefined) => (s === undefined ? "" : String(Math.round(s * 2) / 2));

/** Word-style formatting for the text being edited: font, size, bold, italics, underline, color, alignment. */
export function TextFormatBar({
  state,
  fonts,
  ownColor,
  left,
  top,
  barRef,
  onFamily,
  onSize,
  onStep,
  onToggle,
  onColor,
  onHighlight,
  onAlign,
  onClear,
  onDone,
}: {
  state: FormatState;
  fonts: FontMenu;
  /** The text's own color. */
  ownColor: string;
  left: number;
  top: number;
  barRef: React.RefObject<HTMLDivElement | null>;
  onFamily: (family: string) => void;
  /** A new size (null: unchanged), and whether to go back to the text. */
  onSize: (size: number | null, refocus: boolean) => void;
  onStep: (up: boolean) => void;
  onToggle: (kind: Toggle) => void;
  onColor: (color: string | null) => void;
  onHighlight: (color: string | null) => void;
  onAlign: (align: TextAlign) => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const sizes = useId();
  const colorRef = useRef<HTMLButtonElement>(null);
  const markRef = useRef<HTMLButtonElement>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);
  const [sizeText, setSizeText] = useState(sizeLabel(state.size));
  useEffect(() => setSizeText(sizeLabel(state.size)), [state.size]);

  const applySize = (text: string, refocus: boolean) => {
    const v = Number.parseFloat(text.replace(",", "."));
    if (Number.isFinite(v) && v >= 1 && v <= 1638) {
      if (v !== state.size) onSize(Math.round(v * 10) / 10, refocus);
      else if (refocus) onSize(null, true);
    } else setSizeText(sizeLabel(state.size));
  };

  const family = state.family ?? MIXED;
  const known = new Set([...fonts.document, ...fonts.others.map((f) => f.family)]);
  const color = state.color === undefined ? null : (state.color ?? ownColor);

  return (
    <div
      ref={barRef}
      className="annot-toolbar text-format-bar"
      role="toolbar"
      aria-label="Text formatting"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      // Buttons don't take the focus, so the text stays selected in the editor.
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("select, input")) e.preventDefault();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <select
        className={`annot-toolbar-select text-format-font${state.standIn ? " is-stand-in" : ""}`}
        value={family}
        data-tip={state.standIn && state.family ? `${state.family} isn't on this computer: letters the PDF doesn't include are written in ${state.standIn}, the closest match` : "Font"}
        aria-label="Font"
        onChange={(e) => e.target.value !== MIXED && onFamily(e.target.value)}
      >
        {family === MIXED && <option value={MIXED}> </option>}
        {family !== MIXED && !known.has(family) && <option value={family}>{family || "Font of the PDF"}</option>}
        {fonts.document.length > 0 && (
          <optgroup label="In this document">
            {fonts.document.map((f) => (
              <option key={`d-${f}`} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Fonts">
          {fonts.others
            .filter((f) => !f.installed && !fonts.document.includes(f.family))
            .map((f) => (
              <option key={`l-${f.family}`} value={f.family}>
                {f.family}
              </option>
            ))}
        </optgroup>
        {fonts.others.some((f) => f.installed) && (
          <optgroup label="On this computer">
            {fonts.others
              .filter((f) => f.installed && !fonts.document.includes(f.family))
              .map((f) => (
                <option key={`s-${f.family}`} value={f.family}>
                  {f.family}
                </option>
              ))}
          </optgroup>
        )}
      </select>
      <input
        className="annot-toolbar-select text-format-size"
        aria-label="Font size"
        data-tip="Font size"
        list={sizes}
        value={sizeText}
        inputMode="decimal"
        onChange={(e) => {
          setSizeText(e.target.value);
          // Picked from the list.
          if ((e.nativeEvent as InputEvent).inputType === undefined || (e.nativeEvent as InputEvent).inputType === "insertReplacementText") applySize(e.target.value, true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            applySize(sizeText, true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setSizeText(sizeLabel(state.size));
            onSize(null, true);
          }
        }}
        onBlur={() => applySize(sizeText, false)}
        onFocus={(e) => e.target.select()}
      />
      <datalist id={sizes}>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <IconButton size="sm" icon={<AArrowUp size={16} />} label="Bigger" shortcut="Mod+Shift+>" onClick={() => onStep(true)} />
      <IconButton size="sm" icon={<AArrowDown size={16} />} label="Smaller" shortcut="Mod+Shift+<" onClick={() => onStep(false)} />
      <span className="annot-toolbar-sep" />
      <IconButton size="sm" icon={<Bold size={15} />} label="Bold" shortcut="Mod+B" active={state.bold} onClick={() => onToggle("bold")} />
      <IconButton size="sm" icon={<Italic size={15} />} label="Italic" shortcut="Mod+I" active={state.italic} onClick={() => onToggle("italic")} />
      <IconButton size="sm" icon={<Underline size={15} />} label="Underline" shortcut="Mod+U" active={state.underline} onClick={() => onToggle("underline")} />
      <IconButton size="sm" icon={<Strikethrough size={15} />} label="Strikethrough" shortcut="Mod+Shift+X" active={state.strike} onClick={() => onToggle("strike")} />
      <button ref={colorRef} type="button" className="icon-btn icon-btn-sm text-color-btn" aria-label="Font color" data-tip="Font color" onClick={() => setColorOpen((o) => !o)}>
        <Baseline size={15} />
        <span className="text-color-bar" style={{ background: color ?? "linear-gradient(90deg, #d33, #3a3, #36d)" }} />
      </button>
      <Popover open={colorOpen} anchor={colorRef} onClose={() => setColorOpen(false)} ignoreRefs={[colorRef]} className="popover-pad">
        <div className="popover-title">Font color</div>
        <button
          type="button"
          className="text-color-own"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onColor(null);
            setColorOpen(false);
          }}
        >
          <span className="color-btn-chip" style={{ background: ownColor }} /> Original color
        </button>
        <div onMouseDown={(e) => !(e.target as HTMLElement).closest("input") && e.preventDefault()}>
          <ColorSwatches
            value={state.color ?? null}
            colors={TEXT_COLORS}
            onChange={(c) => {
              if (!c) return;
              onColor(c);
              // A swatch closes the popover; the color picker stays open while it's being used.
              if (document.activeElement?.getAttribute("type") !== "color") setColorOpen(false);
            }}
          />
        </div>
      </Popover>
      <button ref={markRef} type="button" className="icon-btn icon-btn-sm text-color-btn" aria-label="Highlight color" data-tip="Highlight color" onClick={() => setMarkOpen((o) => !o)}>
        <Highlighter size={15} />
        <span className="text-color-bar" style={{ background: state.highlight ?? "transparent" }} />
      </button>
      <Popover open={markOpen} anchor={markRef} onClose={() => setMarkOpen(false)} ignoreRefs={[markRef]} className="popover-pad">
        <div className="popover-title">Highlight color</div>
        <div onMouseDown={(e) => !(e.target as HTMLElement).closest("input") && e.preventDefault()}>
          <ColorSwatches
            value={state.highlight ?? null}
            colors={HIGHLIGHT_COLORS}
            allowNone
            onChange={(c) => {
              onHighlight(c);
              if (document.activeElement?.getAttribute("type") !== "color") setMarkOpen(false);
            }}
          />
        </div>
      </Popover>
      <span className="annot-toolbar-sep" />
      <IconButton size="sm" icon={<AlignLeft size={15} />} label="Align left" shortcut="Mod+L" active={state.align === "left"} onClick={() => onAlign("left")} />
      <IconButton size="sm" icon={<AlignCenter size={15} />} label="Center" shortcut="Mod+E" active={state.align === "center"} onClick={() => onAlign("center")} />
      <IconButton size="sm" icon={<AlignRight size={15} />} label="Align right" shortcut="Mod+R" active={state.align === "right"} onClick={() => onAlign("right")} />
      <IconButton size="sm" icon={<AlignJustify size={15} />} label="Justify" shortcut="Mod+J" active={state.align === "justify"} onClick={() => onAlign("justify")} />
      <span className="annot-toolbar-sep" />
      <IconButton size="sm" icon={<RemoveFormatting size={15} />} label="Clear formatting" shortcut="Mod+Space" onClick={onClear} />
      <IconButton size="sm" icon={<Check size={16} />} label="Done" shortcut="Mod+Enter" onClick={onDone} />
    </div>
  );
}
