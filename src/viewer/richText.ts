import type { CharFormat } from "../ops/editText";
import { familyKey } from "../lib/fontNames";

/**
 * The text of Edit text's editor with its formatting: each character has the PDF's own style
 * (a base) and the formatting given to it in the editor. Shown as one span per run of
 * characters formatted alike; typing goes into the span at the caret, so new text takes the
 * style of the text before it.
 */

/** The PDF's own style of a piece of the edited text. */
export interface BaseStyle {
  /** pdf.js name of its font, which is also a CSS font family once pdf.js has loaded the font. */
  fontName: string;
  /** Its family, e.g. "Helvetica Neue" (empty when the PDF doesn't name it). */
  family: string;
  /** Its PostScript name, for finding a font like it. */
  psName: string;
  kind: "serif" | "sans-serif" | "monospace";
  weight: number;
  italic: boolean;
  size: number;
  /** Its color in the PDF, when known. */
  color?: string;
  /** Space after each letter, in points (letter-spaced text). */
  spacing?: number;
}

export interface RichChar {
  ch: string;
  /** Index of its base style. */
  base: number;
  /** Formatting given to it (only what differs from its base). */
  f: CharFormat;
}

/** A character's style as shown: its own, with the formatting given to it. */
export interface Look {
  family: string;
  weight: number;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  size: number;
  /** null: the paragraph's color. */
  color: string | null;
  /** Highlight color, or null. */
  highlight: string | null;
}

export function lookOf(bases: BaseStyle[], c: RichChar): Look {
  const b = bases[c.base];
  return {
    family: c.f.family ?? b.family,
    weight: c.f.weight ?? b.weight,
    italic: c.f.italic ?? b.italic,
    underline: !!c.f.underline,
    strike: !!c.f.strike,
    size: c.f.size ?? b.size,
    color: c.f.color ?? b.color ?? null,
    highlight: c.f.highlight ?? null,
  };
}

/** Keeps only the formatting that differs from the base, in a fixed order. */
export function normalizeFormat(b: BaseStyle, f: CharFormat): CharFormat {
  const out: CharFormat = {};
  if (f.family !== undefined && familyKey(f.family) !== familyKey(b.family)) out.family = f.family;
  if (f.weight !== undefined && f.weight !== b.weight) out.weight = f.weight;
  if (f.italic !== undefined && f.italic !== b.italic) out.italic = f.italic;
  if (f.size !== undefined && Math.abs(f.size - b.size) >= 0.05) out.size = Math.round(f.size * 10) / 10;
  if (f.color && f.color.toLowerCase() !== b.color?.toLowerCase()) out.color = f.color;
  if (f.underline) out.underline = true;
  if (f.strike) out.strike = true;
  if (f.highlight) out.highlight = f.highlight;
  return out;
}

const runKey = (c: RichChar) => `${c.base}|${JSON.stringify(c.f)}`;

/** Shows the text in the editor. */
export function renderRich(root: HTMLElement, chars: RichChar[], styleOf: (c: RichChar) => Partial<CSSStyleDeclaration>) {
  root.textContent = "";
  for (let i = 0; i < chars.length; ) {
    let j = i + 1;
    const key = runKey(chars[i]);
    while (j < chars.length && runKey(chars[j]) === key) j++;
    const span = document.createElement("span");
    span.dataset.b = String(chars[i].base);
    span.dataset.f = JSON.stringify(chars[i].f);
    Object.assign(span.style, styleOf(chars[i]));
    span.textContent = chars
      .slice(i, j)
      .map((c) => c.ch)
      .join("");
    root.appendChild(span);
    i = j;
  }
  // A line break at the end only shows (and takes the caret) with something after it.
  if (!chars.length || chars[chars.length - 1].ch === "\n") {
    const br = document.createElement("br");
    br.dataset.end = "1";
    root.appendChild(br);
  }
}

/** Styles the spans again (fonts found later), leaving the text and the caret alone. */
export function restyleRich(root: HTMLElement, styleOf: (c: RichChar) => Partial<CSSStyleDeclaration>) {
  for (const span of root.querySelectorAll<HTMLElement>("span[data-b]")) {
    Object.assign(span.style, styleOf({ ch: "", base: Number(span.dataset.b), f: JSON.parse(span.dataset.f ?? "{}") as CharFormat }));
  }
}

/**
 * Reads the text back. Text typed where there's no span (into an empty editor) takes `typing`;
 * line breaks and blocks the browser made count as "\n", except a break it leaves at the very
 * end (after deleting everything, say), which shows no line (unless `all`, for counting positions).
 */
export function readRich(root: Node, typing: { base: number; f: CharFormat }, all = false): RichChar[] {
  const out: RichChar[] = [];
  let endsWithBreak = false;
  const walk = (node: Node, base: number, f: CharFormat) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        for (const ch of child.nodeValue ?? "") out.push({ ch, base, f });
        if (child.nodeValue) endsWithBreak = false;
      } else if (child instanceof HTMLElement) {
        if (child.tagName === "BR") {
          if (!child.dataset.end) {
            out.push({ ch: "\n", base, f });
            endsWithBreak = true;
          }
          return;
        }
        const b = child.dataset.b !== undefined ? Number(child.dataset.b) : base;
        const ff = child.dataset.f !== undefined ? (JSON.parse(child.dataset.f) as CharFormat) : f;
        if ((child.tagName === "DIV" || child.tagName === "P") && out.length && out[out.length - 1].ch !== "\n") out.push({ ch: "\n", base: b, f: ff });
        walk(child, b, ff);
      }
    });
  };
  walk(root, typing.base, typing.f);
  if (endsWithBreak && !all) out.pop();
  return out;
}

/** Whether the editor holds only what renderRich makes (the browser adds its own elements at times). */
export function isTidy(root: HTMLElement): boolean {
  const kids = [...root.childNodes];
  return kids.every((n, i) =>
    n instanceof HTMLSpanElement
      ? n.dataset.b !== undefined && n.childNodes.length <= 1 && (!n.firstChild || n.firstChild.nodeType === Node.TEXT_NODE)
      : n instanceof HTMLBRElement && !!n.dataset.end && i === kids.length - 1,
  );
}

/** The text index of a position in the editor. */
export function indexAt(root: HTMLElement, node: Node, offset: number): number {
  if (!root.contains(node)) return 0;
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return readRich(range.cloneContents(), { base: 0, f: {} }, true).length;
}

/** The editor's selection as text indexes (start ≤ end), or null when it's elsewhere. */
export function selectionIn(root: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.focusNode || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const a = indexAt(root, sel.anchorNode, sel.anchorOffset);
  const b = indexAt(root, sel.focusNode, sel.focusOffset);
  return a <= b ? [a, b] : [b, a];
}

/** The position of a text index in a rendered editor: at a boundary, the end of the span before it. */
function positionOf(root: HTMLElement, index: number): { node: Node; offset: number } {
  let left = index;
  for (const s of root.childNodes) {
    const t = s.firstChild;
    if (!(s instanceof HTMLSpanElement) || !t || t.nodeType !== Node.TEXT_NODE) continue;
    const chars = [...(t.nodeValue ?? "")];
    if (left <= chars.length) return { node: t, offset: chars.slice(0, left).join("").length };
    left -= chars.length;
  }
  const end = root.lastChild instanceof HTMLBRElement ? root.childNodes.length - 1 : root.childNodes.length;
  return { node: root, offset: Math.max(0, end) };
}

/** Selects text indexes [start, end) in a rendered editor. */
export function selectRange(root: HTMLElement, start: number, end: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const a = positionOf(root, start);
  const b = positionOf(root, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

export type Toggle = "bold" | "italic" | "underline" | "strike";

const isOn = (kind: Toggle, l: Look) => (kind === "bold" ? l.weight >= 600 : kind === "italic" ? l.italic : kind === "underline" ? l.underline : l.strike);

/**
 * The formatting a toggle gives characters: on unless all of them have it. Bold turns light or
 * regular text bold; turned off, text goes back to its own weight (or regular if that was bold).
 */
export function toggled(kind: Toggle, looks: Look[]): (look: Look, base: BaseStyle) => CharFormat {
  const on = !looks.length || !looks.every((l) => isOn(kind, l));
  return (_look, base) => {
    if (kind === "bold") return { weight: on ? (base.weight >= 600 ? base.weight : 700) : base.weight < 600 ? base.weight : 400 };
    if (kind === "italic") return { italic: on };
    return { [kind]: on || undefined };
  };
}

/** Gives characters [start, end) the formatting `patch` makes for each. */
export function formatRange(chars: RichChar[], bases: BaseStyle[], start: number, end: number, patch: (look: Look, base: BaseStyle) => CharFormat): RichChar[] {
  return chars.map((c, i) => {
    if (i < start || i >= end || c.ch === "\n") return c;
    const base = bases[c.base];
    return { ...c, f: normalizeFormat(base, { ...c.f, ...patch(lookOf(bases, c), base) }) };
  });
}

/** Font sizes offered, and stepped through by grow and shrink (as in Word). */
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

export function stepSize(size: number, up: boolean): number {
  if (up) return FONT_SIZES.find((s) => s > size + 0.05) ?? Math.min(1638, Math.round(size + 10));
  return [...FONT_SIZES].reverse().find((s) => s < size - 0.05) ?? Math.max(1, Math.round(size - 1));
}
