import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { stageBox, type RenderCtx } from "../annotations/render";
import type { CharFormat, TextAlign } from "../ops/editText";
import type { PdfRect } from "../lib/geometry";
import { familyKey } from "../lib/fontNames";
import {
  formatRange,
  isTidy,
  lookOf,
  normalizeFormat,
  readRich,
  renderRich,
  restyleRich,
  selectRange,
  selectionIn,
  stepSize,
  toggled,
  type BaseStyle,
  type Look,
  type RichChar,
  type Toggle,
} from "./richText";
import { TextFormatBar, type FontMenu, type FormatState } from "./TextFormatBar";
import { usePhone } from "../lib/device";

/** Text being edited in Edit text, with its styles. */
export interface RichEditing {
  rect: PdfRect;
  /** How far right the text may run. */
  maxRight: number;
  bases: BaseStyle[];
  chars: RichChar[];
  /** The paragraph's alignment when editing starts. */
  align: TextAlign;
  /** Line spacing as a multiple of the font size. */
  leading: number;
  /** The text's color, as sampled from the page. */
  color?: string;
  /** The color behind the text on the page. */
  background?: string;
  /** Whether the text can be formatted (not edits made by earlier versions). */
  formatting: boolean;
}

export interface EditorResult {
  text: string;
  /** Formatting given to each character (UTF-16 code unit) of `text`; null: none. */
  formats: (CharFormat | null)[];
  /** The new alignment, when it was changed. */
  align?: TextAlign;
  /** The base style of each character (UTF-16 code unit) of `text`. */
  bases: number[];
}

interface HistoryEntry {
  chars: RichChar[];
  sel: [number, number];
  align: TextAlign;
  kind: string;
  time: number;
}

const GENERIC = { serif: "serif", "sans-serif": "sans-serif", monospace: "monospace" } as const;

/**
 * The in-place editor of Edit text with its formatting toolbar. Formatting works like Word's:
 * Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+Shift+> and < for size, Ctrl+L/E/R/J to align, Ctrl+Space to
 * clear; with nothing selected it applies to what is typed next.
 */
export function TextEditorBox({
  editing,
  ctx,
  scale,
  geo,
  pageFaces,
  fonts,
  resultRef,
  onCommit,
  onCancel,
}: {
  editing: RichEditing;
  ctx: RenderCtx;
  scale: number;
  geo: { width: number; height: number };
  /** pdf.js names of the page's fonts, by "family key|weight|italic". */
  pageFaces: Map<string, string>;
  fonts: FontMenu;
  resultRef: React.MutableRefObject<(() => EditorResult) | null>;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  const bases = editing.bases;
  // Style of text typed where there's no span (into an emptied editor).
  const typing = useRef<{ base: number; f: CharFormat }>({ base: editing.chars[0]?.base ?? 0, f: {} });
  // Formatting chosen with nothing selected, for the text typed next at that place.
  const pending = useRef<{ at: number; base: number; f: CharFormat } | null>(null);
  const saved = useRef<[number, number]>([editing.chars.length, editing.chars.length]);
  const align = useRef<TextAlign>(editing.align);
  const history = useRef<{ entries: HistoryEntry[]; at: number }>({ entries: [], at: -1 });
  const [ui, setUi] = useState<FormatState>({ bold: false, italic: false, underline: false, strike: false, align: editing.align });
  const [fontTick, setFontTick] = useState(0);
  const [height, setHeight] = useState(0);
  const [barSize, setBarSize] = useState({ width: 0, height: 0 });
  const matched = useRef(new Map<string, string>());
  // The fonts found, by the same keys: whether each is the font itself or one standing in for it.
  const found = useRef(new Map<string, { family: string; exact: boolean }>());
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  /** Whether a character is in its own font, and the key of the font most like the one it's in. */
  const fontOf = (b: BaseStyle, l: Look) => {
    const own = familyKey(l.family) === familyKey(b.family) && l.weight === b.weight && l.italic === b.italic;
    return { own, key: `${own ? b.psName || b.family : l.family}|${b.kind}|${l.weight}|${l.italic}` };
  };

  /** CSS family of the font most like a font, once it's found (the app's library or the computer's). */
  const likeCss = (key: string): string => {
    const hit = matched.current.get(key);
    if (hit !== undefined) return hit;
    matched.current.set(key, "");
    const [name, kind, weight, italic] = key.split("|");
    void import("../lib/fontMatch")
      .then(async ({ matchFont, cssFamily }) => {
        const choice = await matchFont({ name, family: kind as BaseStyle["kind"], weight: Number(weight), bold: Number(weight) >= 600, italic: italic === "true" });
        matched.current.set(key, cssFamily(choice.family));
        found.current.set(key, { family: choice.family.family, exact: choice.exact });
        setFontTick((t) => t + 1);
      })
      .catch(() => {});
    return "";
  };

  /** How a character is shown: in the PDF's own font where it can be, else the font most like it. */
  const styleOf = (c: RichChar): Partial<CSSStyleDeclaration> => {
    const b = bases[c.base];
    const l = lookOf(bases, c);
    const { own, key } = fontOf(b, l);
    const pdfFont = own ? b.fontName : pageFaces.get(`${familyKey(l.family)}|${l.weight}|${l.italic}`);
    const like = likeCss(key);
    return {
      fontFamily: [pdfFont && `"${pdfFont}"`, like, GENERIC[b.kind]].filter(Boolean).join(", "),
      fontWeight: String(l.weight),
      fontStyle: l.italic ? "italic" : "normal",
      fontSize: `${l.size}px`,
      letterSpacing: b.spacing ? `${b.spacing}px` : "",
      color: l.color ?? "",
      textDecorationLine: [l.underline && "underline", l.strike && "line-through"].filter(Boolean).join(" ") || "none",
      backgroundColor: l.highlight ?? "",
      // The PDF's fonts are loaded as one face each: don't embolden or slant them again.
      fontSynthesis: pdfFont ? "none" : "",
    };
  };

  const model = () => (el.current ? readRich(el.current, typing.current) : editing.chars);

  const show = (chars: RichChar[], sel: [number, number]) => {
    const root = el.current;
    if (!root) return;
    renderRich(root, chars, styleOf);
    selectRange(root, sel[0], sel[1]);
    saved.current = sel;
  };

  /** The character whose style text typed at `at` takes: the one before it, or at the start of a line, the one after. */
  const caretChar = (chars: RichChar[], at: number): RichChar => {
    const before = chars[at - 1];
    if (before && before.ch !== "\n") return before;
    const after = chars[at];
    if (after && after.ch !== "\n") return after;
    return before ?? after ?? { ch: "", base: typing.current.base, f: typing.current.f };
  };

  const refreshUi = () => {
    const chars = model();
    const [s, e] = saved.current;
    let looks: Look[];
    let first: RichChar | undefined;
    if (s === e) {
      const c = caretChar(chars, s);
      const p = pending.current?.at === s ? pending.current : null;
      first = { ch: "", base: p?.base ?? c.base, f: p?.f ?? c.f };
      looks = [lookOf(bases, first)];
    } else {
      const picked = chars.slice(s, e).filter((c) => c.ch !== "\n");
      first = picked[0];
      looks = picked.map((c) => lookOf(bases, c));
    }
    // A font that isn't on the computer: which one stands in for it.
    const choice = first && bases[first.base] ? found.current.get(fontOf(bases[first.base], lookOf(bases, first)).key) : undefined;
    const same = <T,>(get: (l: Look) => T): T | undefined => (looks.length && looks.every((l) => get(l) === get(looks[0])) ? get(looks[0]) : undefined);
    const all = (test: (l: Look) => boolean) => looks.length > 0 && looks.every(test);
    setUi({
      family: same((l) => l.family),
      size: same((l) => l.size),
      bold: all((l) => l.weight >= 600),
      italic: all((l) => l.italic),
      underline: all((l) => l.underline),
      strike: all((l) => l.strike),
      color: same((l) => l.color),
      highlight: same((l) => l.highlight),
      align: align.current,
      standIn: choice && !choice.exact && looks[0]?.family ? choice.family : undefined,
    });
  };

  const record = (kind: string) => {
    const h = history.current;
    const entry: HistoryEntry = { chars: model(), sel: (el.current && selectionIn(el.current)) || saved.current, align: align.current, kind, time: Date.now() };
    h.entries.length = h.at + 1;
    const top = h.entries[h.at];
    // Typing in one go is undone at once.
    if (kind === "typing" && top?.kind === "typing" && entry.time - top.time < 1000) h.entries[h.at] = entry;
    else {
      h.entries.push(entry);
      h.at++;
    }
  };

  const restore = (entry: HistoryEntry) => {
    align.current = entry.align;
    pending.current = null;
    el.current?.focus({ preventScroll: true });
    show(entry.chars, entry.sel);
    refreshUi();
  };
  const undo = () => {
    const h = history.current;
    if (h.at > 0) restore(h.entries[--h.at]);
  };
  const redo = () => {
    const h = history.current;
    if (h.at < h.entries.length - 1) restore(h.entries[++h.at]);
  };

  /** Formats the selection; with nothing selected, the text typed next. */
  const format = (patch: (looks: Look[]) => (look: Look, base: BaseStyle) => CharFormat, refocus = true) => {
    const root = el.current;
    if (!root || !editing.formatting) return;
    const chars = model();
    const [s, e] = selectionIn(root) ?? saved.current;
    if (refocus) root.focus({ preventScroll: true });
    if (s === e) {
      const c = caretChar(chars, s);
      const cur = pending.current?.at === s ? pending.current : { at: s, base: c.base, f: c.f };
      const look = lookOf(bases, { ch: "", base: cur.base, f: cur.f });
      pending.current = { at: s, base: cur.base, f: normalizeFormat(bases[cur.base], { ...cur.f, ...patch([look])(look, bases[cur.base]) }) };
      selectRange(root, s, s);
      saved.current = [s, s];
      refreshUi();
      return;
    }
    const looks = chars
      .slice(s, e)
      .filter((c) => c.ch !== "\n")
      .map((c) => lookOf(bases, c));
    show(formatRange(chars, bases, s, e, patch(looks)), [s, e]);
    record("format");
    refreshUi();
  };

  const toggle = (kind: Toggle) => format((looks) => toggled(kind, looks));
  const setFamily = (family: string) => format(() => () => ({ family }));
  const setSize = (size: number | null, refocus: boolean) => {
    if (size !== null) format(() => () => ({ size }), refocus);
    else if (refocus) {
      el.current?.focus({ preventScroll: true });
      if (el.current) selectRange(el.current, ...saved.current);
    }
  };
  const step = (up: boolean) => format(() => (look) => ({ size: stepSize(look.size, up) }));
  const nudge = (delta: number) => format(() => (look) => ({ size: Math.max(1, Math.round(look.size + delta)) }));
  // The color picker stays open while it's used: leave the focus in it.
  const setColor = (color: string | null) => format(() => () => ({ color: color ?? undefined }), document.activeElement?.getAttribute("type") !== "color");
  const setHighlight = (color: string | null) => format(() => () => ({ highlight: color ?? undefined }), document.activeElement?.getAttribute("type") !== "color");
  const clear = () => {
    const root = el.current;
    if (!root || !editing.formatting) return;
    const chars = model();
    const [s, e] = selectionIn(root) ?? saved.current;
    root.focus({ preventScroll: true });
    if (s === e) {
      const c = caretChar(chars, s);
      pending.current = { at: s, base: c.base, f: {} };
      selectRange(root, s, s);
      refreshUi();
      return;
    }
    show(
      chars.map((c, i) => (i >= s && i < e ? { ...c, f: {} } : c)),
      [s, e],
    );
    record("format");
    refreshUi();
  };
  const setAlign = (a: TextAlign) => {
    if (!editing.formatting) return;
    align.current = a;
    el.current?.focus({ preventScroll: true });
    record("align");
    refreshUi();
  };

  // ----- Typing -----
  useLayoutEffect(() => {
    const root = el.current;
    if (!root) return;
    show(editing.chars, [editing.chars.length, editing.chars.length]);
    root.focus({ preventScroll: true });
    history.current = { entries: [], at: -1 };
    record("start");
    refreshUi();

    /** Puts text in place of the selection, in a given style. */
    const insert = (e: Event, text: string, style: { base: number; f: CharFormat }, kind = "typing") => {
      e.preventDefault();
      const chars = model();
      const [s, end] = selectionIn(root) ?? saved.current;
      const added = [...text].map((ch) => ({ ch, base: style.base, f: style.f }));
      show([...chars.slice(0, s), ...added, ...chars.slice(end)], [s + added.length, s + added.length]);
      pending.current = null;
      record(kind);
      refreshUi();
    };
    const onBeforeInput = (e: InputEvent) => {
      const type = e.inputType;
      if (type === "historyUndo" || type === "historyRedo") {
        e.preventDefault();
        if (type === "historyUndo") undo();
        else redo();
        return;
      }
      if (type === "formatBold" || type === "formatItalic" || type === "formatUnderline" || type === "formatStrikeThrough") {
        e.preventDefault();
        toggle(type === "formatBold" ? "bold" : type === "formatItalic" ? "italic" : type === "formatUnderline" ? "underline" : "strike");
        return;
      }
      if (e.isComposing) return;
      const chars = model();
      const [s, end] = selectionIn(root) ?? saved.current;
      // New text takes the style of the text it replaces, or of the text before it.
      const c = s === end ? caretChar(chars, s) : chars[s];
      typing.current = { base: c?.base ?? typing.current.base, f: c?.f ?? {} };
      const p = pending.current && s === end && pending.current.at === s ? pending.current : null;
      if (type === "insertParagraph" || type === "insertLineBreak") insert(e, "\n", p ?? typing.current);
      else if (type === "insertText" && e.data && (p || s !== end)) insert(e, e.data, p ?? typing.current);
    };
    const onInput = (e: Event) => {
      if ((e as InputEvent).isComposing) return;
      // Keep the editor to its spans, so what's shown is what will be written.
      if (!isTidy(root)) {
        const sel = selectionIn(root);
        const chars = model();
        show(chars, sel ?? [chars.length, chars.length]);
      }
      record("typing");
      refreshUi();
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      const [s, end] = selectionIn(root) ?? saved.current;
      const chars = model();
      const p = pending.current && s === end && pending.current.at === s ? pending.current : null;
      const c = s === end ? caretChar(chars, s) : chars[s];
      insert(e, text.replace(/\r\n?/g, "\n"), p ?? { base: c?.base ?? typing.current.base, f: c?.f ?? {} }, "paste");
    };
    const onDrop = (e: DragEvent) => e.preventDefault();
    const onSelection = () => {
      const sel = selectionIn(root);
      if (!sel) return;
      saved.current = sel;
      if (pending.current && (sel[0] !== sel[1] || sel[0] !== pending.current.at)) pending.current = null;
      refreshUi();
    };
    // Clicking anywhere else ends editing.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (root.contains(t) || bar.current?.contains(t) || t.closest?.(".popover")) return;
      // A size being typed in the toolbar is applied first.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && bar.current?.contains(active)) active.blur();
      commitRef.current();
    };
    root.addEventListener("beforeinput", onBeforeInput);
    root.addEventListener("input", onInput);
    root.addEventListener("compositionend", onInput);
    root.addEventListener("paste", onPaste);
    root.addEventListener("drop", onDrop);
    document.addEventListener("selectionchange", onSelection);
    document.addEventListener("pointerdown", onDown, true);
    resultRef.current = () => {
      const chars = model();
      const formats: (CharFormat | null)[] = [];
      for (const c of chars) for (let i = 0; i < c.ch.length; i++) formats.push(Object.keys(c.f).length ? c.f : null);
      return { text: chars.map((c) => c.ch).join(""), formats, align: align.current !== editing.align ? align.current : undefined, bases: chars.flatMap((c) => Array<number>(c.ch.length).fill(c.base)) };
    };
    return () => {
      root.removeEventListener("beforeinput", onBeforeInput);
      root.removeEventListener("input", onInput);
      root.removeEventListener("compositionend", onInput);
      root.removeEventListener("paste", onPaste);
      root.removeEventListener("drop", onDrop);
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("pointerdown", onDown, true);
    };
    // The editor is set up once per edit; its handlers read the current text from the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing.chars]);

  // Fonts found after the editor opened.
  useEffect(() => {
    if (fontTick && el.current) restyleRich(el.current, styleOf);
    if (fontTick) refreshUi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontTick]);

  // The toolbar goes above the text, or below it when there's no room; it moves as the text grows.
  useLayoutEffect(() => {
    const root = el.current;
    if (!root) return;
    const toolbar = bar.current;
    const ro = new ResizeObserver(() => {
      setHeight(root.offsetHeight);
      if (toolbar) setBarSize({ width: toolbar.offsetWidth, height: toolbar.offsetHeight });
    });
    ro.observe(root);
    if (toolbar) {
      ro.observe(toolbar);
      setBarSize({ width: toolbar.offsetWidth, height: toolbar.offsetHeight });
    }
    return () => ro.disconnect();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const act = (f: () => void) => {
      e.preventDefault();
      f();
    };
    if (e.key === "Enter") return act(onCommit);
    if (k === "z") return act(e.shiftKey ? redo : undo);
    if (k === "y") return act(redo);
    if (k === "b" && !e.shiftKey) return act(() => toggle("bold"));
    if (k === "i" && !e.shiftKey) return act(() => toggle("italic"));
    if (k === "u" && !e.shiftKey) return act(() => toggle("underline"));
    if (k === "x" && e.shiftKey) return act(() => toggle("strike"));
    if (e.key === ">" || (e.shiftKey && e.code === "Period")) return act(() => step(true));
    if (e.key === "<" || (e.shiftKey && e.code === "Comma")) return act(() => step(false));
    if (e.key === "]") return act(() => nudge(1));
    if (e.key === "[") return act(() => nudge(-1));
    if (k === "l") return act(() => setAlign("left"));
    if (k === "e") return act(() => setAlign("center"));
    if (k === "r") return act(() => setAlign("right"));
    if (k === "j") return act(() => setAlign("justify"));
    if (e.code === "Space") return act(clear);
  };

  const box = stageBox(ctx.m, editing.rect);
  const room = stageBox(ctx.m, [editing.rect[0], editing.rect[1], Math.max(editing.rect[2], editing.maxRight), editing.rect[3]]);
  // Above the text (the toolbar is on two rows in a narrow window), or below it when there's no room.
  const above = box.y * scale - (barSize.height || 38) - 8;
  const barTop = above >= 4 ? above : (box.y - 2) * scale + Math.max(height, box.h + 4) * scale + 8;
  const barLeft = Math.max(4, Math.min((box.x - 2) * scale, geo.width * scale - barSize.width - 4));
  return (
    <>
      <div className="doxxta-stage doxxta-textedit-live" style={{ width: geo.width, height: geo.height }}>
        <div className="doxxta-textedit-cover is-live" style={{ left: box.x - 1, top: box.y - 1, width: box.w + 2, height: box.h + 2, background: editing.background }} />
        <div
          ref={el}
          className="doxxta-textedit-editor"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          role="textbox"
          aria-multiline
          aria-label="Edit text"
          style={{
            left: box.x - 2,
            top: box.y - 2,
            width: "max-content",
            minWidth: box.w + 4,
            maxWidth: room.w + 4,
            minHeight: box.h + 4,
            lineHeight: editing.leading,
            textAlign: ui.align,
            color: editing.color,
            background: editing.background,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        />
      </div>
      {editing.formatting && (
        <TextFormatBar
          barRef={bar}
          state={ui}
          fonts={fonts}
          ownColor={editing.color ?? "#000000"}
          left={barLeft}
          top={barTop}
          docked={phone}
          onFamily={setFamily}
          onSize={setSize}
          onStep={step}
          onToggle={toggle}
          onColor={setColor}
          onHighlight={setHighlight}
          onAlign={setAlign}
          onClear={clear}
          onDone={onCommit}
        />
      )}
    </>
  );
}
