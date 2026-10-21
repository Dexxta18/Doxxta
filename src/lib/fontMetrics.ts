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

// ----- Metrics for reading existing PDFs (non-embedded standard fonts) -----

const encodingTables = new Map<string, Map<number, string>>();

/** Character code → glyph name for the built-in encodings. */
export function encodingTable(name: "WinAnsi" | "Symbol" | "ZapfDingbats"): Map<number, string> {
  let t = encodingTables.get(name);
  if (!t) {
    t = new Map();
    const enc = Encodings[name];
    for (const cp of enc.supportedCodePoints) {
      const { code, name: glyph } = enc.encodeUnicodeCodePoint(cp);
      if (!t.has(code)) t.set(code, glyph);
    }
    encodingTables.set(name, t);
  }
  return t;
}

/** Width (1/1000 em) of a named glyph in one of the standard 14 fonts. */
export function stdGlyphWidth(fontName: string, glyph: string): number | undefined {
  return load(fontName).widths.get(glyph);
}

/** Maps a BaseFont name (and common aliases such as Arial or TimesNewRomanPSMT) to a standard 14 font. */
export function standardFontName(baseFont: string): string | null {
  const n = baseFont.replace(/^[A-Z]{6}\+/, "").toLowerCase().replace(/[\s_,-]/g, "");
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique/.test(n);
  if (n.startsWith("symbol")) return "Symbol";
  if (n.includes("zapf") || n.includes("dingbats")) return "ZapfDingbats";
  if (n.includes("courier")) return bold && italic ? "Courier-BoldOblique" : bold ? "Courier-Bold" : italic ? "Courier-Oblique" : "Courier";
  if (n.includes("times")) return bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
  if (n.includes("helvetica") || n.includes("arial")) return bold && italic ? "Helvetica-BoldOblique" : bold ? "Helvetica-Bold" : italic ? "Helvetica-Oblique" : "Helvetica";
  return null;
}

let nameToUnicode: Map<string, string> | null = null;

/** Unicode text for a glyph name (standard names, uniXXXX, uXXXX[XX], ligatures like f_i). */
export function glyphUnicode(name: string): string {
  if (!nameToUnicode) {
    nameToUnicode = new Map();
    for (const enc of [Encodings.WinAnsi, Encodings.Symbol, Encodings.ZapfDingbats]) {
      for (const cp of enc.supportedCodePoints) {
        const g = enc.encodeUnicodeCodePoint(cp).name;
        if (!nameToUnicode.has(g)) nameToUnicode.set(g, String.fromCodePoint(cp));
      }
    }
    for (const [g, s] of [["ff", "ff"], ["fi", "fi"], ["fl", "fl"], ["ffi", "ffi"], ["ffl", "ffl"], ["dotlessi", "ı"], ["nbspace", " "], ["sfthyphen", "­"], ["minus", "−"]] as const) nameToUnicode.set(g, s);
  }
  const direct = nameToUnicode.get(name);
  if (direct !== undefined) return direct;
  const base = name.split(".")[0];
  if (base !== name && base) return glyphUnicode(base);
  if (base.includes("_")) return base.split("_").map(glyphUnicode).join("");
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(base);
  if (m) return m[1].match(/.{4}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join("");
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  if (/^[A-Za-z]$/.test(base)) return base;
  return "";
}
