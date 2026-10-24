import { diffChars } from "diff";
import { PDFArray, PDFDict, PDFName, PDFRef, addContentStream, addPageResource, fontKeyFor, type FontCache, type FontLook, type LikeFont, type PDFDocument, type PDFFont, type PDFObject, type PDFPage } from "../lib/pdflib";
import { extractGlyphs, redactPage, type GlyphStyle, type PageGlyph, type Region } from "./contentRedact";
import { fmt, hexToPdf } from "../lib/colors";
import { parseContent } from "../lib/contentStream";
import { wrapText } from "../lib/fontMetrics";
import { familyKey } from "../lib/fontNames";
import type { PdfRect } from "../lib/geometry";

/**
 * Edit text that keeps the page's formatting. Old and new text are compared
 * character by character; unchanged lines, and the unchanged start of a
 * changed line, stay exactly as they were. Only changed text is removed from
 * the page content and drawn again, each character in the style of the text
 * it replaces or follows: its original font when the document contains the
 * character in it, its size, color and spacing. A word with a character the
 * document's font lacks is drawn in the font most like it (the same font
 * installed on the computer, or one from the app's library in the same
 * weight), so no word mixes two fonts. Right-aligned, centered and justified
 * paragraphs keep their alignment.
 *
 * Formatting chosen in the editor (bold, italics, font, size, color,
 * underline, strikethrough, alignment) is applied to the characters it was
 * given to: in another font of the document when it has one in that weight
 * and slant, otherwise in the closest font found.
 */

/** One line of the edited paragraph, as the editor showed it. */
export interface EditLine {
  text: string;
  rect: PdfRect;
  baseline: number;
  /** What joins it to the next line in the paragraph's text: " ", "\n" or "" (after a hyphen). */
  sep: string;
}

export type TextAlign = "left" | "right" | "center" | "justify";

/** Formatting given to text in the editor, over its own. */
export interface CharFormat {
  /** Font family, e.g. "Inter". */
  family?: string;
  /** 100–900. */
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Font size in points. */
  size?: number;
  /** Text color (#rrggbb). */
  color?: string;
  /** Highlight behind the text (#rrggbb). */
  highlight?: string;
}

export interface TextEditRequest {
  pageIndex: number;
  lines: EditLine[];
  /** The paragraph's text: its lines joined with their separators. */
  before: string;
  after: string;
  /** For pages whose text can't be edited in place: cover the old text with this color. */
  background: string;
  /** Style of the paragraph for that case. */
  fallback: { size: number; color: string; bold: boolean; italic: boolean; family: "Helvetica" | "Times" | "Courier" };
  /** Formatting given in the editor, by position in `after` (UTF-16 code units); missing or null: unchanged. */
  formats?: (CharFormat | null | undefined)[];
  /** Alignment chosen in the editor. */
  align?: TextAlign;
}

/** A character of the paragraph: original (with its glyph) or new. */
interface Char {
  ch: string;
  /** Original glyph drawn for it (ligatures: on the first character only); null for spaces between glyphs and new text. */
  glyph: PageGlyph | null;
  /** Characters after the first of a ligature glyph. */
  inLigature: boolean;
  /** Style to draw it in: its own, or that of the text next to it. */
  style: GlyphStyle | null;
  size: number;
  /** Width of a space between two original glyphs. */
  gap?: number;
}

interface NewChar extends Char {
  /** Index in `before` of an unchanged character, or -1 for new text. */
  old: number;
  /** For new text: the index in `before` it was inserted before. */
  at: number;
  /** Formatting given to it in the editor. */
  fmt?: CharFormat;
  /** Its font or size was changed: its glyph can't be reused. */
  reshaped?: boolean;
  /** The document's font to draw it in: its own, or another of the document's in the weight and slant asked for. */
  face?: GlyphStyle | null;
  /** The font to look for when that one lacks a character of its word. */
  look?: FontLook;
  /** Drawn in a font like the original (`like`): its word has a character the original font lacks. */
  sub?: boolean;
  like?: LikeFont;
}

interface Placed {
  c: NewChar;
  x: number;
  width: number;
}

const isSpace = (s: string) => /^\s*$/.test(s);
/** Slant given to upright fonts standing in for italics (tan 12°). */
const SLANT = 0.2126;

export async function editPageText(doc: PDFDocument, req: TextEditRequest, fonts: FontCache): Promise<"edited" | "covered" | "unchanged"> {
  const formatted = !!req.formats?.some((f) => f && Object.values(f).some((v) => v !== undefined && v !== false));
  if (req.before === req.after && !formatted && !req.align) return "unchanged";
  const page = doc.getPages()[req.pageIndex];
  if (!page) return "unchanged";
  const all = await extractGlyphs(doc, page).catch(() => null);
  const glyphs = (all ?? []).filter((g) => g.style && g.style.mode !== 3 && g.style.mode !== 7 && Math.abs(g.end.y - g.origin.y) < 0.05 * g.size + 0.01);
  const lineGlyphs = req.lines.map((l) => glyphsOfLine(glyphs, l));
  if (!all || lineGlyphs.some((g) => !g.length)) return cover(doc, page, req, fonts);

  // ----- The paragraph as characters with their glyphs -----
  const oldChars: Char[] = [];
  const lineOf: number[] = [];
  const lineStart: number[] = [];
  const extras: PageGlyph[][] = [];
  for (let i = 0; i < req.lines.length; i++) {
    lineStart.push(oldChars.length);
    const mapped = mapLine(req.lines[i].text, lineGlyphs[i]);
    extras.push(mapped.extra);
    for (const c of mapped.chars) {
      oldChars.push(c);
      lineOf.push(i);
    }
    if (i < req.lines.length - 1) {
      for (const ch of req.lines[i].sep) {
        oldChars.push({ ch, glyph: null, inLigature: false, style: null, size: 0 });
        lineOf.push(i);
      }
    }
  }
  if (oldChars.map((c) => c.ch).join("") !== req.before) return cover(doc, page, req, fonts);
  fillStyles(oldChars);
  if (oldChars.every((c) => !c.style)) return cover(doc, page, req, fonts);

  // ----- Paragraph geometry (spaces drawn at the ends of lines don't count) -----
  const ink = lineGlyphs.map((g) => g.filter((x) => !isSpace(x.text)));
  if (ink.some((g) => !g.length)) return cover(doc, page, req, fonts);
  const left = ink.map((g) => g[0].origin.x);
  const right = ink.map((g) => Math.max(...g.map((x) => x.end.x)));
  const baselines = ink.map((g) => g[0].origin.y);
  const n = req.lines.length;
  const pitch = n > 1 ? (baselines[0] - baselines[n - 1]) / (n - 1) : (oldChars.find((c) => c.size)?.size ?? 12) * 1.2;
  const detected = alignment(ink, left, right, glyphs, baselines[0]);
  // A new alignment lays the whole paragraph out again, between its margins.
  const realign = !!req.align && req.align !== detected;
  const align = req.align ?? detected;
  const limit = n > 1 ? Math.max(...right) + 0.5 : rightLimit(glyphs, baselines[0], right[0], lineGlyphs[0]);
  const margins = realign ? paragraphMargins(page, glyphs, lineGlyphs, left, right, baselines[0]) : null;

  // ----- What changed -----
  const newChars: NewChar[] = [];
  const touched = new Set<number>();
  let oi = 0;
  for (const part of diffChars(req.before, req.after)) {
    if (part.added) {
      // Typed text takes the style of the text before it; at the start of a word, of the word.
      const prev = oldChars[oi - 1];
      const next = oldChars[oi];
      const from = prev && !/\s/.test(prev.ch) ? prev : next && !/\s/.test(next.ch) ? next : (prev ?? next);
      for (const ch of part.value) newChars.push({ ch, glyph: null, inLigature: false, style: from?.style ?? null, size: from?.size ?? req.fallback.size, old: -1, at: oi });
      touched.add(lineOf[Math.min(oi, oldChars.length - 1)]);
    } else if (part.removed) {
      for (let k = 0; k < part.value.length; k++) touched.add(lineOf[oi + k]);
      oi += part.value.length;
    } else {
      for (let k = 0; k < part.value.length; k++) newChars.push({ ...oldChars[oi + k], old: oi + k, at: oi + k });
      oi += part.value.length;
    }
  }
  // Formatting from the editor: what differs from the character's own style.
  let at = 0;
  for (const c of newChars) {
    const f = formatChange(req.formats?.[at], c);
    at += c.ch.length;
    if (!f) continue;
    c.fmt = f;
    c.reshaped = f.family !== undefined || f.weight !== undefined || f.italic !== undefined || f.size !== undefined;
    if (c.old >= 0) touched.add(lineOf[c.old]);
  }
  if (realign) for (let i = 0; i < n; i++) touched.add(i);
  if (!touched.size) return "unchanged";
  const first = Math.min(...touched);
  const sizeOf = (c: NewChar) => c.fmt?.size ?? (c.size || req.fallback.size);
  const resized = newChars.some((c) => c.fmt?.size !== undefined);

  // ----- Fonts: which characters the original fonts can show -----
  // Characters the document draws in each font, on this page and the ones around it.
  const seen = [...all];
  const pages = doc.getPages();
  for (let i = Math.max(0, req.pageIndex - 3); i < Math.min(pages.length, req.pageIndex + 4); i++) {
    if (i !== req.pageIndex) seen.push(...((await extractGlyphs(doc, pages[i]).catch(() => null)) ?? []));
  }
  const encodings = observedCodes(seen);
  const fallbackLook: FontLook = {
    name: "",
    family: req.fallback.family === "Times" ? "serif" : req.fallback.family === "Courier" ? "monospace" : "sans-serif",
    bold: req.fallback.bold,
    italic: req.fallback.italic,
  };
  const codeFor = (s: GlyphStyle | null | undefined, ch: string): { bytes: Uint8Array; width: number } | null => {
    if (!s) return null;
    const seen = encodings.get(fontKey(s))?.get(ch);
    if (seen) return seen;
    const code = s.encode?.(ch);
    return code === undefined ? null : { bytes: Uint8Array.of(code), width: s.codeWidth(code) };
  };
  // The font each character is drawn in: its own, or for a new weight, slant or family, one of
  // the document's fonts in it.
  const faces = documentFaces(seen);
  for (const c of newChars) {
    const s = c.style;
    const f = c.fmt;
    const base = s?.font ?? fallbackLook;
    if (!f || (f.family === undefined && f.weight === undefined && f.italic === undefined)) {
      c.face = s;
      c.look = base;
      continue;
    }
    const familyName = f.family ?? base.familyName ?? "";
    const weight = f.weight ?? base.weight ?? (base.bold ? 700 : 400);
    const italic = f.italic ?? base.italic;
    const other = faces.find(familyName, weight, italic);
    c.face = other && s ? { ...other, fill: s.fill, mode: s.mode, tc: s.tc, tw: s.tw, th: s.th } : other;
    c.look = { name: familyName || base.name, familyName, family: base.family, weight, bold: weight >= 600, italic };
  }
  // Letters of a word in one font are drawn in a font like it when that font lacks one of them.
  const lacking = (c: NewChar) => !/\s/.test(c.ch) && (c.reshaped || (!c.glyph && !c.inLigature)) && !codeFor(c.face, c.ch);
  const faceKey = (c: NewChar) => `${c.face ? fontKey(c.face) : "-"}|${c.look?.familyName ?? ""}|${c.look?.name}|${c.look?.weight}|${c.look?.italic}`;
  for (let i = 0; i < newChars.length; ) {
    let j = i + 1;
    if (!/\s/.test(newChars[i].ch)) while (j < newChars.length && !/\s/.test(newChars[j].ch) && faceKey(newChars[j]) === faceKey(newChars[i])) j++;
    const part = newChars.slice(i, j);
    if (part.some(lacking)) {
      const like = await fonts.like(part[0].look ?? fallbackLook, part.map((c) => c.ch).join(""));
      for (const c of part) {
        c.sub = true;
        c.like = like;
      }
    }
    i = j;
  }
  const advance = (c: NewChar, prev: NewChar | undefined, next: NewChar | undefined): number => {
    const s = c.face ?? c.style;
    const size = sizeOf(c);
    const th = s?.th ?? 1;
    const tc = s?.tc ?? 0;
    if (c.sub && c.like) return (c.like.font.widthOfTextAtSize(c.ch, size) + tc) * th;
    if (c.inLigature && !c.reshaped) return 0;
    const code = codeFor(s, c.ch);
    if (/\s/.test(c.ch)) {
      const usual = ((code ? (code.width / 1000) * size : size * 0.25) + tc) * th;
      // A space next to unchanged text keeps its width, so the gap after a bullet stays as it was;
      // but justified lines are spaced out again from spaces of the usual width.
      const anchored = !c.reshaped && !realign && c.old >= 0 && ((prev !== undefined && prev.old >= 0 && prev.old === c.old - 1) || (next !== undefined && next.old === c.old + 1));
      const width = c.gap ?? (c.glyph ? c.glyph.end.x - c.glyph.origin.x : undefined);
      if (width !== undefined && anchored && (align !== "justify" || width > usual * 2)) return width;
      return usual + (c.ch === " " && align !== "justify" ? (s?.tw ?? 0) * th : 0);
    }
    if (c.glyph && !c.reshaped) return c.glyph.end.x - c.glyph.origin.x;
    if (code) return ((code.width / 1000) * size + tc) * th;
    return (size * 0.5 + tc) * th;
  };

  // ----- Lay out the changed part -----
  const remove = new Set<PageGlyph>();
  const draw: { chars: Placed[]; baseline: number }[] = [];
  // Start of line `first` in the new text.
  let pos = newChars.findIndex((c) => (c.old >= 0 ? c.old : c.at) >= lineStart[first]);
  if (pos < 0) pos = newChars.length;
  // Left-aligned text keeps the unchanged start of the first changed line as it is.
  let keep = 0;
  if (align === "left" && !realign) {
    while (pos + keep < newChars.length && newChars[pos + keep].old === lineStart[first] + keep && lineOf[newChars[pos + keep].old] === first && !newChars[pos + keep].fmt) keep++;
    // A word drawn in another font is drawn again whole.
    if (newChars[pos + keep]?.sub) while (keep > 0 && newChars[pos + keep - 1].sub) keep--;
    // Don't split a ligature, and leave trailing spaces to the layout.
    while (keep > 0 && (newChars[pos + keep]?.inLigature || /\s/.test(newChars[pos + keep - 1].ch))) keep--;
  }
  for (const c of oldChars.slice(lineStart[first] + keep, lineOf.lastIndexOf(first) + 1)) if (c.glyph) remove.add(c.glyph);
  const lastKept = newChars.slice(pos, pos + keep).reverse().find((c) => c.glyph)?.glyph;
  const x = lastKept ? lastKept.end.x : margins ? margins.left : left[first];
  for (const g of extras[first]) if (!lastKept || g.origin.x >= lastKept.end.x - 0.1) remove.add(g);
  pos += keep;

  // Line spacing in proportion to the text's size, for text made bigger or smaller.
  const sizes = oldChars.filter((c) => c.glyph).map((c) => c.size);
  const usualSize = sizes.length ? sizes.reduce((s, v) => s + v, 0) / sizes.length : req.fallback.size;
  const leading = pitch / usualSize;
  let line = first;
  let resynced = false;
  let lastBaseline: number | null = first > 0 ? baselines[first - 1] : null;
  while (pos < newChars.length) {
    const placed: Placed[] = [];
    const lineLeft = margins ? margins.left : line === first ? x : (left[line] ?? left[n - 1]);
    const maxRight = margins ? margins.right : align === "left" || align === "justify" ? limit : Number.POSITIVE_INFINITY;
    let cx = lineLeft;
    let hard = false;
    while (pos < newChars.length) {
      const c = newChars[pos];
      if (c.ch === "\n") {
        pos++;
        hard = true;
        break;
      }
      // The next word, with the spaces before it.
      let end = pos;
      while (end < newChars.length && /\s/.test(newChars[end].ch) && newChars[end].ch !== "\n") end++;
      while (end < newChars.length && !/\s/.test(newChars[end].ch)) end++;
      const widths: number[] = [];
      for (let k = pos; k < end; k++) widths.push(advance(newChars[k], newChars[k - 1], newChars[k + 1]));
      const wordStart = widths.findIndex((_, k) => !/\s/.test(newChars[pos + k].ch));
      const inkEnd = cx + widths.reduce((s, w) => s + w, 0);
      if (placed.length && inkEnd > maxRight + 0.5) {
        // Wrap: the spaces before the word end this line.
        while (pos < newChars.length && /\s/.test(newChars[pos].ch) && newChars[pos].ch !== "\n") pos++;
        break;
      }
      for (let k = pos; k < end; k++) {
        if (k - pos >= wordStart || placed.length) placed.push({ c: newChars[k], x: cx, width: widths[k - pos] });
        cx += widths[k - pos];
      }
      pos = end;
    }
    let baseline = line < n ? baselines[line] : baselines[n - 1] - pitch * (line - n + 1);
    if (resized && lastBaseline !== null) {
      const lineSize = Math.max(0, ...placed.filter((p) => !/\s/.test(p.c.ch)).map((p) => sizeOf(p.c))) || usualSize;
      baseline = lastBaseline - leading * lineSize;
    }
    lastBaseline = baseline;
    placeLine(placed, align, lineLeft, margins ? margins.right : line < n ? right[line] : limit, margins ? margins.right : limit, !hard && pos < newChars.length);
    draw.push({ chars: placed, baseline });
    line++;
    // The rest of the paragraph is unchanged and starts a line as before: keep those lines.
    if (
      !realign &&
      !resized &&
      line < n &&
      pos < newChars.length &&
      newChars[pos].old === lineStart[line] &&
      newChars.slice(pos).every((c, k) => c.old === lineStart[line] + k && !c.fmt) &&
      newChars.length - pos === oldChars.length - lineStart[line]
    ) {
      resynced = true;
      break;
    }
    if (line < n) {
      for (let i = lineStart[line]; i < oldChars.length && lineOf[i] === line; i++) if (oldChars[i].glyph) remove.add(oldChars[i].glyph!);
      for (const g of extras[line]) remove.add(g);
    }
  }
  // Text deleted from the end of the paragraph.
  if (!resynced) {
    for (let l = line; l < n; l++) {
      for (let i = lineStart[l]; i < oldChars.length && lineOf[i] === l; i++) if (oldChars[i].glyph) remove.add(oldChars[i].glyph!);
      for (const g of extras[l]) remove.add(g);
    }
  }

  // ----- Draw the new text where the old was in the page's drawing order, and remove the old -----
  const ops: string[] = [];
  // Highlights go under all the text.
  const under = draw.flatMap((l) => highlights(l.chars, l.baseline, sizeOf));
  const names = new Map<PDFObject | PDFFont, string>();
  const fontName = (key: PDFObject | PDFFont): string => {
    let name = names.get(key);
    if (!name) {
      const ref = key instanceof PDFRef ? key : key instanceof PDFDict ? doc.context.register(key) : (key as PDFFont).ref;
      name = addPageResource(page, "Font", "DxEd", ref);
      names.set(key, name);
    }
    return name;
  };
  for (const l of draw) {
    // Runs of characters drawn the same way, without gaps between them.
    let run: { font: PDFObject | PDFFont; like: LikeFont | null; hex: string[]; text: string; x: number; style: GlyphStyle | null; fill: string; size: number; next: number } | null = null;
    const flush = () => {
      if (!run) return;
      const s = run.style;
      const [r, g, b] = hexToPdf(run.fill);
      const hex = run.font instanceof PDFRef || run.font instanceof PDFDict ? `<${run.hex.join("")}>` : (run.font as PDFFont).encodeText(run.text).toString();
      // Fonts without the weight or slant asked for are emboldened (outlined as well as filled) or slanted.
      const mode = s?.mode ?? 0;
      const bold = !!run.like?.embolden && mode === 0;
      const text = `BT /${fontName(run.font)} ${fmt(run.size)} Tf ${fmt(s?.tc ?? 0)} Tc 0 Tw ${fmt((s?.th ?? 1) * 100)} Tz 0 Ts ${bold ? 2 : mode} Tr ${fmt(r)} ${fmt(g)} ${fmt(b)} rg 1 0 ${run.like?.slant ? SLANT : 0} 1 ${fmt(run.x)} ${fmt(l.baseline)} Tm ${hex} Tj ET`;
      ops.push(bold ? `q ${fmt(run.size * 0.035)} w ${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${text} Q` : text);
      run = null;
    };
    for (const p of l.chars) {
      if (/\s/.test(p.c.ch) || (p.c.inLigature && !p.c.sub && !p.c.reshaped)) {
        flush();
        continue;
      }
      const s = p.c.face ?? p.c.style;
      const size = sizeOf(p.c);
      const own = p.c.reshaped ? undefined : p.c.glyph?.style;
      const style = own ?? s;
      const code = p.c.sub || !style?.fontObj ? null : own ? { bytes: own.bytes } : codeFor(s, p.c.ch);
      const like = code ? null : (p.c.like ?? (await fonts.like(p.c.look ?? fallbackLook, p.c.ch)));
      const font: PDFObject | PDFFont = code ? (style!.fontObj as PDFObject) : like!.font;
      const fill = p.c.fmt?.color ?? style?.fill ?? req.fallback.color;
      const same = run && run.font === font && run.like === like && run.size === size && run.fill === fill && run.style?.tc === style?.tc && run.style?.th === style?.th && run.style?.mode === style?.mode;
      if (!run || !same || Math.abs(run.next - p.x) > 0.05) {
        flush();
        run = { font, like, hex: [], text: "", x: p.x, style, fill, size, next: p.x };
      }
      if (code) run.hex.push(Array.from(code.bytes, (v) => v.toString(16).padStart(2, "0")).join(""));
      run.text += p.c.ch;
      run.next = p.x + p.width;
    }
    flush();
    ops.push(...decorations(l.chars, l.baseline, sizeOf, (c) => c.fmt?.color ?? (c.face ?? c.style)?.fill ?? req.fallback.color));
  }
  const content = [...under, ...ops].join("\n");
  // After the text object of the line's unchanged start, or of the first glyph replaced.
  const anchor = lastKept ?? [...remove].sort((a, b) => all.indexOf(a) - all.indexOf(b))[0];
  const result = await redactPage(doc, page, [...remove].map(tightRegion), {
    text: true,
    images: false,
    graphics: false,
    onlyIfComplete: true,
    insert: anchor && content ? { after: anchor.origin, ops: parseContent(new TextEncoder().encode(content)) } : undefined,
  });
  if (result.unsupported.length || (remove.size && !result.changed)) {
    // Couldn't take the glyphs out of the content: paint over them.
    const [r, g, b] = hexToPdf(req.background);
    const paint = [`q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`];
    for (const gl of remove) {
      const xs = gl.quad.map((p) => p.x),
        ys = gl.quad.map((p) => p.y);
      const x0 = Math.min(...xs) - 0.3,
        y0 = Math.min(...ys) - 0.3;
      paint.push(`${fmt(x0)} ${fmt(y0)} ${fmt(Math.max(...xs) - x0 + 0.6)} ${fmt(Math.max(...ys) - y0 + 0.6)} re f`);
    }
    paint.push("Q");
    appendIsolated(doc, page, [...paint, content].join("\n"));
  } else if (!result.inserted && content) {
    appendIsolated(doc, page, content);
  }
  return "edited";
}

/** How a character of text seen in a picture is drawn: its line's look as seen, with the editor's formatting. */
export interface SeenCharLook {
  family: string;
  kind: "serif" | "sans-serif" | "monospace";
  weight: number;
  italic: boolean;
  size: number;
  /** Space after each letter, in points. */
  spacing: number;
  color: string;
  underline?: boolean;
  strike?: boolean;
  highlight?: string;
}

/** An edit of text seen in a picture of the page (see ops/recognize.ts). */
export interface SeenTextEdit {
  pageIndex: number;
  /** Where the old text is: covered with `background` before the new text is drawn. */
  cover: PdfRect;
  background: string;
  /** A picture of what's behind the text without it, to cover it with instead (where it isn't one color). */
  patch?: { png: Uint8Array; rect: PdfRect };
  /** The block's lines as they were seen. */
  lines: { left: number; right: number; baseline: number }[];
  align: TextAlign;
  text: string;
  /** How each character of `text` (UTF-16 code unit) is drawn. */
  looks: SeenCharLook[];
}

/**
 * Text that's part of a picture, edited: its old letters are covered with the color behind them
 * and the new text is written there as real text, in the fonts, sizes, letter spacing and colors
 * seen (with the formatting given in the editor), aligned as the block was. An invisible OCR
 * layer under it is removed, so searching finds the new text.
 */
export async function editSeenText(doc: PDFDocument, req: SeenTextEdit, fonts: FontCache): Promise<void> {
  const page = doc.getPages()[req.pageIndex];
  if (!page) return;
  // The lines of the new text, each character with its look.
  const lines: { ch: string; look: SeenCharLook; key: string }[][] = [[]];
  let unit = 0;
  for (const ch of req.text) {
    const look = req.looks[unit] ?? req.looks[unit - 1] ?? req.looks[0];
    unit += ch.length;
    if (ch === "\n") lines.push([]);
    else lines[lines.length - 1].push({ ch, look, key: JSON.stringify(look) });
  }
  // One font per look, chosen for all the text in it.
  const keyOf = (l: SeenCharLook) => `${l.family}|${l.weight}|${l.italic}`;
  const texts = new Map<string, { look: SeenCharLook; text: string }>();
  for (const line of lines) for (const c of line) {
    const t = texts.get(keyOf(c.look)) ?? { look: c.look, text: "" };
    t.text += c.ch;
    texts.set(keyOf(c.look), t);
  }
  const like = new Map<string, LikeFont>();
  for (const [key, { look, text }] of texts) {
    like.set(key, await fonts.like({ name: look.family, familyName: look.family, family: look.kind, weight: look.weight, bold: look.weight >= 600, italic: look.italic }, text));
  }
  const names = new Map<PDFFont, string>();
  const nameOf = (font: PDFFont) => {
    let name = names.get(font);
    if (!name) names.set(font, (name = addPageResource(page, "Font", "DxEd", font.ref)));
    return name;
  };

  const seen = req.lines.length ? req.lines : [{ left: req.cover[0], right: req.cover[2], baseline: req.cover[1] }];
  const left = Math.min(...seen.map((l) => l.left));
  const right = Math.max(...seen.map((l) => l.right));
  const firstSize = lines.flat()[0]?.look.size ?? 12;
  const pitch = seen.length > 1 ? (seen[0].baseline - seen[seen.length - 1].baseline) / (seen.length - 1) : firstSize * 1.25;
  const [br, bg, bb] = hexToPdf(req.background);
  const [cx0, cy0, cx1, cy1] = req.cover;
  const box = `${fmt(cx0)} ${fmt(cy0)} ${fmt(cx1 - cx0)} ${fmt(cy1 - cy0)} re`;
  const ops = [`q ${fmt(br)} ${fmt(bg)} ${fmt(bb)} rg ${box} f Q`];
  if (req.patch) {
    // What's behind the text, without it, in place of one color.
    const image = await doc.embedPng(req.patch.png);
    const name = addPageResource(page, "XObject", "DxBg", image.ref);
    const [px0, py0, px1, py1] = req.patch.rect;
    ops[0] = `q ${box} W n ${fmt(px1 - px0)} 0 0 ${fmt(py1 - py0)} ${fmt(px0)} ${fmt(py0)} cm /${name} Do Q`;
  }
  const under: string[] = [];
  const over: string[] = [];
  let baseline = seen[0].baseline;
  lines.forEach((line, li) => {
    if (li > 0) baseline = li < seen.length ? seen[li].baseline : baseline - Math.max(pitch, ...line.map((c) => c.look.size * 1.15));
    // Each character's advance: its width, and the letter spacing after it but the last.
    const advances = line.map((c, i) => like.get(keyOf(c.look))!.font.widthOfTextAtSize(c.ch, c.look.size) + (i < line.length - 1 ? c.look.spacing : 0));
    const width = advances.reduce((s, a) => s + a, 0);
    let x = req.align === "right" ? right - width : req.align === "center" ? (left + right) / 2 - width / 2 : left;
    // Runs of characters in one look.
    for (let i = 0; i < line.length; ) {
      let j = i + 1;
      while (j < line.length && line[j].key === line[i].key) j++;
      const look = line[i].look;
      const lf = like.get(keyOf(look))!;
      const text = line.slice(i, j).map((c) => c.ch).join("");
      const runWidth = advances.slice(i, j).reduce((s, a) => s + a, 0);
      const [r, g, b] = hexToPdf(look.color);
      if (look.highlight) {
        const [hr, hg, hb] = hexToPdf(look.highlight);
        under.push(`q ${fmt(hr)} ${fmt(hg)} ${fmt(hb)} rg ${fmt(x)} ${fmt(baseline - look.size * 0.24)} ${fmt(runWidth)} ${fmt(look.size * 1.16)} re f Q`);
      }
      if (text.trim()) {
        const bold = lf.embolden;
        const drawn = `BT /${nameOf(lf.font)} ${fmt(look.size)} Tf ${fmt(look.spacing)} Tc 0 Tw 100 Tz 0 Ts ${bold ? 2 : 0} Tr ${fmt(r)} ${fmt(g)} ${fmt(b)} rg 1 0 ${lf.slant ? SLANT : 0} 1 ${fmt(x)} ${fmt(baseline)} Tm ${lf.font.encodeText(text).toString()} Tj ET`;
        over.push(bold ? `q ${fmt(look.size * 0.035)} w ${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${drawn} Q` : drawn);
      }
      for (const kind of ["underline", "strike"] as const) {
        if (!look[kind]) continue;
        const h = Math.max(0.5, look.size * 0.055);
        const y = kind === "underline" ? baseline - look.size * 0.12 - h / 2 : baseline + look.size * 0.28 - h / 2;
        over.push(`q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${fmt(x)} ${fmt(y)} ${fmt(runWidth - (j === line.length ? 0 : look.spacing))} ${fmt(h)} re f Q`);
      }
      x += runWidth;
      i = j;
    }
  });

  // An invisible OCR layer under the old letters goes with them (searching would find the old text).
  const glyphs = (await extractGlyphs(doc, page).catch(() => null)) ?? [];
  const hidden = glyphs.filter((g) => {
    if (g.style?.mode !== 3 && g.style?.mode !== 7) return false;
    const x = (g.origin.x + g.end.x) / 2;
    return x >= cx0 && x <= cx1 && g.origin.y >= cy0 - g.size * 0.3 && g.origin.y <= cy1;
  });
  if (hidden.length) await redactPage(doc, page, hidden.map(tightRegion), { text: true, images: false, graphics: false });
  appendIsolated(doc, page, [...ops, ...under, ...over].join("\n"));
}

/** The formatting asked for a character, less what it already has; undefined when nothing changes. */
function formatChange(f: CharFormat | null | undefined, c: NewChar): CharFormat | undefined {
  if (!f) return undefined;
  const font = c.style?.font;
  const out: CharFormat = {};
  if (f.family !== undefined && familyKey(f.family) !== familyKey(font?.familyName ?? "")) out.family = f.family;
  if (f.weight !== undefined && f.weight !== (font?.weight ?? 400)) out.weight = f.weight;
  if (f.italic !== undefined && f.italic !== (font?.italic ?? false)) out.italic = f.italic;
  if (f.size !== undefined && Math.abs(f.size - c.size) >= 0.05) out.size = f.size;
  if (f.color !== undefined && f.color.toLowerCase() !== (c.style?.fill ?? "").toLowerCase()) out.color = f.color;
  if (f.underline) out.underline = true;
  if (f.strike) out.strike = true;
  if (f.highlight) out.highlight = f.highlight;
  return Object.keys(out).length ? out : undefined;
}

/** The document's fonts by family, weight and slant, to draw text given another weight or slant in. */
function documentFaces(glyphs: PageGlyph[]) {
  const list: GlyphStyle[] = [];
  const known = new Set<string>();
  for (const g of glyphs) {
    const s = g.style;
    if (!s?.fontObj || !s.font.familyName) continue;
    const key = fontKey(s);
    if (known.has(key)) continue;
    known.add(key);
    list.push(s);
  }
  return {
    find(family: string, weight: number, italic: boolean): GlyphStyle | null {
      const key = familyKey(family);
      if (!key) return null;
      const same = list.filter((s) => familyKey(s.font.familyName) === key && s.font.italic === italic && Math.abs(s.font.weight - weight) < 50);
      return same[0] ?? null;
    },
  };
}

/**
 * Where a paragraph given a new alignment is laid out: between its own left and right edges, or
 * for a single line, the page's text margins.
 */
function paragraphMargins(page: PDFPage, glyphs: PageGlyph[], lines: PageGlyph[][], left: number[], right: number[], baseline: number): { left: number; right: number } {
  if (lines.length > 1) return { left: Math.min(...left), right: Math.max(...right) };
  const mine = new Set(lines[0]);
  const others = glyphs.filter((g) => !mine.has(g) && !isSpace(g.text) && Math.abs(g.origin.y - baseline) > g.size);
  if (others.length) {
    return { left: Math.min(left[0], ...others.map((g) => g.origin.x)), right: Math.max(right[0], ...others.map((g) => g.end.x)) };
  }
  const { x, width } = page.getMediaBox();
  return { left: Math.min(left[0], x + 72), right: Math.max(right[0], x + width - 72) };
}

/** Highlights of a laid-out line, from below the descenders to above the ascenders (spaces between highlighted words too). */
function highlights(chars: Placed[], baseline: number, sizeOf: (c: NewChar) => number): string[] {
  const out: string[] = [];
  let seg: { x0: number; x1: number; size: number; color: string } | null = null;
  const close = () => {
    if (seg && seg.x1 > seg.x0) {
      const [r, g, b] = hexToPdf(seg.color);
      out.push(`q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${fmt(seg.x0)} ${fmt(baseline - seg.size * 0.24)} ${fmt(seg.x1 - seg.x0)} ${fmt(seg.size * 1.16)} re f Q`);
    }
    seg = null;
  };
  for (const p of chars) {
    const color = p.c.fmt?.highlight;
    if (!color || (seg && seg.color !== color)) close();
    if (!color) continue;
    if (!seg) seg = { x0: p.x, x1: p.x + p.width, size: sizeOf(p.c), color };
    else {
      seg.x1 = p.x + p.width;
      seg.size = Math.max(seg.size, sizeOf(p.c));
    }
  }
  close();
  return out;
}

/** Underlines and strikethroughs of a laid-out line: across the words given them and the spaces between those. */
function decorations(chars: Placed[], baseline: number, sizeOf: (c: NewChar) => number, colorOf: (c: NewChar) => string): string[] {
  const out: string[] = [];
  for (const kind of ["underline", "strike"] as const) {
    let seg: { x0: number; x1: number; size: number; color: string } | null = null;
    const close = () => {
      if (seg && seg.x1 > seg.x0) {
        const [r, g, b] = hexToPdf(seg.color);
        const h = Math.max(0.5, seg.size * 0.055);
        const y = kind === "underline" ? baseline - seg.size * 0.12 - h / 2 : baseline + seg.size * 0.28 - h / 2;
        out.push(`q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${fmt(seg.x0)} ${fmt(y)} ${fmt(seg.x1 - seg.x0)} ${fmt(h)} re f Q`);
      }
      seg = null;
    };
    for (const p of chars) {
      const on = !!p.c.fmt?.[kind];
      const space = /\s/.test(p.c.ch);
      const color = colorOf(p.c);
      if (!on || (seg && !space && seg.color !== color)) close();
      if (!on) continue;
      if (space) continue;
      if (!seg) seg = { x0: p.x, x1: p.x + p.width, size: sizeOf(p.c), color };
      else {
        seg.x1 = p.x + p.width;
        seg.size = Math.max(seg.size, sizeOf(p.c));
      }
    }
    close();
  }
  return out;
}

/** The glyphs of one line of the paragraph, left to right. */
function glyphsOfLine(glyphs: PageGlyph[], line: EditLine): PageGlyph[] {
  const [x0, , x1] = line.rect;
  return glyphs
    .filter((g) => Math.abs(g.origin.y - line.baseline) <= Math.max(0.4 * g.size, 1) && g.origin.x >= x0 - 1 && g.origin.x <= x1 + 0.5)
    .sort((a, b) => a.origin.x - b.origin.x);
}

/**
 * Pairs the characters of a line's text with its glyphs. Spaces may be glyphs or just gaps;
 * a ligature glyph stands for several characters; text drawn twice (shadows, fake bold) is
 * removed with the glyph it doubles.
 */
function mapLine(text: string, glyphs: PageGlyph[]): { chars: Char[]; extra: PageGlyph[] } {
  const chars: Char[] = [];
  const extra: PageGlyph[] = [];
  let gi = 0;
  let off = 0;
  const norm = glyphs.map((g) => g.text.normalize("NFKC"));
  let prev: PageGlyph | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (off === 0 && gi < glyphs.length && /^\s+$/.test(norm[gi])) {
        chars.push({ ch, glyph: glyphs[gi], inLigature: false, style: glyphs[gi].style ?? null, size: glyphs[gi].size });
        prev = glyphs[gi++];
      } else {
        const next = glyphs[gi];
        const gap = prev && next && off === 0 ? next.origin.x - prev.end.x : undefined;
        chars.push({ ch, glyph: null, inLigature: false, style: null, size: 0, gap: gap !== undefined && gap > 0 ? gap : undefined });
      }
      continue;
    }
    while (off === 0 && gi < glyphs.length && isSpace(norm[gi])) extra.push(glyphs[gi++]);
    // Resynchronise after characters pdf.js and the content disagree about.
    if (off === 0 && gi < glyphs.length && norm[gi][0] !== ch) {
      const ahead = norm.slice(gi, gi + 4).findIndex((t) => t[0] === ch);
      if (ahead > 0) for (let k = 0; k < ahead; k++) extra.push(glyphs[gi++]);
    }
    const g = glyphs[gi];
    if (!g || norm[gi][off] !== ch) {
      chars.push({ ch, glyph: null, inLigature: false, style: null, size: 0 });
      continue;
    }
    chars.push({ ch, glyph: off === 0 ? g : null, inLigature: off > 0, style: g.style ?? null, size: g.size });
    off++;
    if (off >= norm[gi].length) {
      prev = g;
      gi++;
      off = 0;
      // The same text drawn again at (almost) the same place.
      while (gi < glyphs.length && norm[gi] === norm[gi - 1] && Math.abs(glyphs[gi].origin.x - g.origin.x) < 0.3 * g.size) extra.push(glyphs[gi++]);
    }
  }
  for (; gi < glyphs.length; gi++) extra.push(glyphs[gi]);
  return { chars, extra };
}

/** Spaces and unmatched characters take the style of the text next to them. */
function fillStyles(chars: Char[]) {
  let last: Char | null = null;
  for (const c of chars) {
    if (c.style) last = c;
    else if (last) {
      c.style = last.style;
      c.size = last.size;
    }
  }
  let next: Char | null = null;
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i];
    if (c.glyph || (c.style && c.size)) next = c;
    else if (next && !c.style) {
      c.style = next.style;
      c.size = next.size;
    }
  }
}

/** Codes the document already uses for each character, per font: those glyphs are certainly in the font. */
function observedCodes(glyphs: PageGlyph[]): Map<string, Map<string, { bytes: Uint8Array; width: number }>> {
  const out = new Map<string, Map<string, { bytes: Uint8Array; width: number }>>();
  for (const g of glyphs) {
    const s = g.style;
    if (!s || !g.text) continue;
    const key = fontKey(s);
    let m = out.get(key);
    if (!m) out.set(key, (m = new Map()));
    const t = g.text.normalize("NFKC");
    if (t.length === 1 && !m.has(t)) m.set(t, { bytes: s.bytes, width: s.width });
  }
  return out;
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
/** Identity of a font: its reference, or the dictionary itself when it isn't one. */
function fontKey(s: GlyphStyle): string {
  const o = s.fontObj;
  if (o instanceof PDFRef) return o.tag;
  if (!o) return "none";
  let id = objectIds.get(o);
  if (!id) objectIds.set(o, (id = nextObjectId++));
  return `direct${id}`;
}

/** How the paragraph is aligned, judged from its lines (and, for one line, from the page's text). */
function alignment(ink: PageGlyph[][], left: number[], right: number[], glyphs: PageGlyph[], baseline: number): "left" | "right" | "center" | "justify" {
  const n = left.length;
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  if (n > 1) {
    const maxRight = Math.max(...right);
    const lefts = left.every((x) => near(x, left[0], 1.5));
    const flush = right.slice(0, -1).every((x) => near(x, maxRight, 1.5));
    if (lefts && flush && right[n - 1] < maxRight - 3 && spacedOut(ink)) return "justify";
    if (!lefts && right.every((x) => near(x, right[0], 1))) return "right";
    const centers = left.map((l, i) => (l + right[i]) / 2);
    if (!lefts && centers.every((c) => near(c, centers[0], 1.5))) return "center";
    return "left";
  }
  // One line: right-aligned when it ends where the page's text ends and starts past the middle.
  const others = glyphs.filter((g) => !isSpace(g.text) && Math.abs(g.origin.y - baseline) > g.size);
  if (!others.length) return "left";
  const pageLeft = Math.min(...others.map((g) => g.origin.x));
  const pageRight = Math.max(...others.map((g) => g.end.x));
  const mid = (pageLeft + pageRight) / 2;
  if (near(right[0], pageRight, 2) && left[0] > mid) return "right";
  if (near((left[0] + right[0]) / 2, mid, 2) && left[0] > pageLeft + 20) return "center";
  return "left";
}

/**
 * Whether the word spaces of a paragraph's full lines were widened or narrowed to fill them, as
 * in justified text: compared with its last line's, or with the width of a space.
 */
function spacedOut(ink: PageGlyph[][]): boolean {
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const full = ink.slice(0, -1).flatMap(wordGaps);
  if (!full.length) return false;
  const size = ink[0][0].size;
  const tol = Math.max(0.15, size * 0.02);
  const last = wordGaps(ink[ink.length - 1]);
  if (last.length) return Math.abs(avg(full) - avg(last)) > tol;
  return ink.length > 2;
}

/** Distances between the words of a line: from the end of one word's last glyph to the next word's first. */
function wordGaps(ink: PageGlyph[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < ink.length; i++) {
    const gap = ink[i].origin.x - ink[i - 1].end.x;
    if (gap > 0.15 * ink[i].size) gaps.push(gap);
  }
  return gaps;
}

/** How far a single line may grow: up to the next text on the same line, or the page's text margin. */
function rightLimit(glyphs: PageGlyph[], baseline: number, lineRight: number, own: PageGlyph[]): number {
  const mine = new Set(own);
  const size = own[0]?.size ?? 12;
  const text = glyphs.filter((g) => !isSpace(g.text));
  const after = text.filter((g) => !mine.has(g) && Math.abs(g.origin.y - baseline) <= 0.4 * g.size && g.origin.x > lineRight + 0.5);
  if (after.length) return Math.min(...after.map((g) => g.origin.x)) - size * 0.8;
  const margin = Math.max(...text.map((g) => g.end.x));
  return Math.max(margin, lineRight);
}

/** Positions a laid-out line for the paragraph's alignment. */
function placeLine(chars: Placed[], align: string, lineLeft: number, oldRight: number, limit: number, notLast: boolean) {
  while (chars.length && /\s/.test(chars[chars.length - 1].c.ch)) chars.pop();
  if (!chars.length) return;
  const end = chars[chars.length - 1].x + chars[chars.length - 1].width;
  let shift = 0;
  if (align === "right") shift = oldRight - end;
  else if (align === "center") shift = (lineLeft + oldRight) / 2 - (chars[0].x + end) / 2;
  else if (align === "justify" && notLast) {
    const gaps = chars.filter((p, i) => i > 0 && /\s/.test(p.c.ch) && !/\s/.test(chars[i - 1].c.ch)).length;
    const extra = limit - 0.5 - end;
    if (gaps && extra > 0 && extra < (end - chars[0].x) * 0.25) {
      let added = 0;
      for (let i = 1; i < chars.length; i++) {
        if (/\s/.test(chars[i].c.ch) && !/\s/.test(chars[i - 1].c.ch)) added += extra / gaps;
        chars[i].x += added;
      }
    }
  }
  if (shift) for (const p of chars) p.x += shift;
}

/** A region over a glyph only: removing it can't touch the glyphs beside it. */
function tightRegion(g: PageGlyph): Region {
  const q = g.quad;
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const w = Math.max(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), g.size * 0.1);
  const h = Math.max(Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y), g.size * 0.1);
  const hw = w * 0.35,
    hh = h * 0.3;
  return [
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh },
  ];
}

/**
 * For pages whose text can't be read exactly (unusual fonts or encodings): paint over the
 * old lines and write the new text in the paragraph's style.
 */
async function cover(doc: PDFDocument, page: PDFPage, req: TextEditRequest, fonts: FontCache): Promise<"covered"> {
  const f = req.fallback;
  const key = fontKeyFor(f.family, f.bold, f.italic);
  const font = await fonts.forText(key, req.after);
  const name = addPageResource(page, "Font", "DxEd", font.ref);
  const rect: PdfRect = [Math.min(...req.lines.map((l) => l.rect[0])), Math.min(...req.lines.map((l) => l.rect[1])), Math.max(...req.lines.map((l) => l.rect[2])), Math.max(...req.lines.map((l) => l.rect[3]))];
  const [br, bg, bb] = hexToPdf(req.background);
  const [r, g, b] = hexToPdf(f.color);
  const pitch = req.lines.length > 1 ? (req.lines[0].baseline - req.lines[req.lines.length - 1].baseline) / (req.lines.length - 1) : f.size * 1.2;
  const ops = [`q ${fmt(br)} ${fmt(bg)} ${fmt(bb)} rg ${fmt(rect[0] - 0.5)} ${fmt(rect[1] - 0.5)} ${fmt(rect[2] - rect[0] + 1)} ${fmt(rect[3] - rect[1] + 1)} re f Q`];
  ops.push(`BT /${name} ${fmt(f.size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`);
  let y = req.lines[0].baseline;
  for (const line of wrapText(req.after, key, f.size, rect[2] - rect[0])) {
    if (line) ops.push(`1 0 0 1 ${fmt(rect[0])} ${fmt(y)} Tm ${font.encodeText(line).toString()} Tj`);
    y -= pitch;
  }
  ops.push("ET");
  appendIsolated(doc, page, ops.join("\n"));
  return "covered";
}

/** Adds content after the page's own, which is wrapped in q/Q so a graphics state it leaves behind can't affect it. */
function appendIsolated(doc: PDFDocument, page: PDFPage, ops: string) {
  const ctx = doc.context;
  const contents = page.node.get(PDFName.of("Contents"));
  if (contents && !(page.node.Contents() instanceof PDFArray)) page.node.set(PDFName.of("Contents"), ctx.obj([contents]));
  page.node.wrapContentStreams(ctx.getPushGraphicsStateContentStream(), ctx.getPopGraphicsStateContentStream());
  addContentStream(doc, page, ctx.register(ctx.flateStream(ops)));
}
