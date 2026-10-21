import { Encodings, Font } from "@cantoo/pdf-lib/standard-fonts";
import type { FontFamily } from "../annotations/types";

/**
 * Metrics for the standard 14 fonts, so on-screen text layout (wrapping,
 * stamp widths) matches what is written into the PDF appearance streams.
 */

const cache = new Map<string, { widths: Map<string, number>; font: Font }>();

export function stdFontName(family: FontFamily, bold: boolean, italic: boolean): string {
  switch (family) {
    case "Times":
      return bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
    case "Courier":
      return bold && italic ? "Courier-BoldOblique" : bold ? "Courier-Bold" : italic ? "Courier-Oblique" : "Courier";
    default:
      return bold && italic ? "Helvetica-BoldOblique" : bold ? "Helvetica-Bold" : italic ? "Helvetica-Oblique" : "Helvetica";
  }
}

export const CSS_FONT: Record<FontFamily, string> = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", monospace',
};

function load(name: string) {
  let entry = cache.get(name);
  if (!entry) {
    const font = Font.load(name as never);
    const widths = new Map<string, number>();
    for (const m of font.CharMetrics) widths.set(m.N, m.WX);
    entry = { widths, font };
    cache.set(name, entry);
  }
  return entry;
}

const winAnsi = Encodings.WinAnsi;

/** Whether a character can be encoded with the standard fonts' WinAnsi encoding. */
export function isWinAnsi(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  try {
    return winAnsi.canEncodeUnicodeCodePoint(cp);
  } catch {
    return false;
  }
}

export function charWidth(ch: string, fontName: string): number {
  const { widths } = load(fontName);
  const cp = ch.codePointAt(0)!;
  if (winAnsi.canEncodeUnicodeCodePoint(cp)) {
    const g = winAnsi.encodeUnicodeCodePoint(cp);
    return widths.get(g.name) ?? 556;
  }
  // Unsupported glyphs are rendered with an embedded Unicode font; approximate.
  return 556;
}

export function textWidth(text: string, fontName: string, size: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontName);
  return (w * size) / 1000;
}

export function fontAscent(fontName: string): number {
  const f = load(fontName).font;
  return ((f.Ascender as number) ?? f.FontBBox[3]) / 1000;
}

export function fontDescent(fontName: string): number {
  const f = load(fontName).font;
  return ((f.Descender as number) ?? f.FontBBox[1]) / 1000;
}

/**
 * Greedy word wrap. Explicit newlines are kept; words longer than the line are
 * broken by character.
 */
export function wrapText(text: string, fontName: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r\n|\r|\n/)) {
    if (maxWidth <= 0) {
      lines.push(para);
      continue;
    }
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let line = "";
    for (const word of words) {
      const candidate = line + word;
      if (textWidth(candidate.trimEnd(), fontName, size) <= maxWidth || !line.trim()) {
        if (!line.trim() && textWidth(word, fontName, size) > maxWidth && /\S/.test(word)) {
          // Break a long word.
          let chunk = line;
          for (const ch of word) {
            if (textWidth(chunk + ch, fontName, size) > maxWidth && chunk.trim()) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(word) ? "" : word;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
