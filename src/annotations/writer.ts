import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  addAnnotRef,
  addPageContent,
  addPageResource,
  fontKeyFor,
  pdfText,
  type FontCache,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from "../lib/pdflib";
import type {
  Annotation,
  FreeTextAnnot,
  ImageAnnot,
  InkAnnot,
  LineAnnot,
  LinkAnnot,
  NoteAnnot,
  PolyAnnot,
  RedactAnnot,
  ShapeAnnot,
  StampAnnot,
  SymbolAnnot,
  TextMarkupAnnot,
  LineEnding,
} from "./types";
import { fmt, hexToPdf } from "../lib/colors";
import { normalizeRotation, rotationMatrix, multiply, type Matrix, type PdfRect, type Point } from "../lib/geometry";
import {
  cloudPath,
  cloudRectPath,
  ellipseInRect,
  lineEnding,
  polylinePath,
  quadLine,
  rectPath,
  smoothPath,
  squigglyPath,
  toPdfOps,
  trimForEnding,
  type Path,
} from "./paths";
import { computeRect } from "./geometry";
import { measureText } from "./render";
import { stampLayout } from "./stamps";
import { isoToPdfDate } from "../lib/pdfjs";
import { dataUrlToBytes } from "../lib/util";
import { wrapText } from "../lib/fontMetrics";

/** Key under which the full Folio model is stored, so annotations round-trip exactly. */
export const FOLIO_KEY = "FolioData";

const SUBTYPE: Partial<Record<Annotation["kind"], string>> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "StrikeOut",
  squiggly: "Squiggly",
  note: "Text",
  freetext: "FreeText",
  ink: "Ink",
  rect: "Square",
  ellipse: "Circle",
  line: "Line",
  polygon: "Polygon",
  polyline: "PolyLine",
  stamp: "Stamp",
  image: "Stamp",
  symbol: "Stamp",
  redact: "Redact",
  link: "Link",
};

const STD_STAMP_NAMES = new Set(["Approved", "Experimental", "NotApproved", "AsIs", "Expired", "NotForPublicRelease", "Confidential", "Final", "Sold", "Departmental", "ForComment", "TopSecret", "Draft", "ForPublicRelease"]);

interface Ctx {
  doc: PDFDocument;
  fonts: FontCache;
  pageRefs: Map<string, PDFRef>;
  imageCache: Map<string, PDFRef>;
}

interface Appearance {
  ops: string;
  resources: Record<string, unknown>;
}

const color = (hex: string, stroke: boolean) => {
  const [r, g, b] = hexToPdf(hex);
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${stroke ? "RG" : "rg"}`;
};
const pdfColor = (hex: string | null | undefined) => (hex ? hexToPdf(hex) : undefined);

function gsResources(doc: PDFDocument, opacity: number, multiply = false) {
  const gs = doc.context.obj({ Type: "ExtGState", CA: opacity, ca: opacity, ...(multiply ? { BM: "Multiply" } : {}) });
  return { ExtGState: { GS0: doc.context.register(gs) } };
}

function dashOps(style: string, w: number) {
  return style === "dashed" ? `[${fmt(Math.max(2, w * 3))} ${fmt(Math.max(2, w * 2))}] 0 d` : "";
}

/** Content-frame transform for upright text/images at the authored rotation. */
function frameMatrix(rect: PdfRect, rotation: number): { m: Matrix; w: number; h: number } {
  const r = normalizeRotation(rotation);
  const W = rect[2] - rect[0];
  const H = rect[3] - rect[1];
  const swap = r === 90 || r === 270;
  const w = swap ? H : W;
  const h = swap ? W : H;
  const cx = (rect[0] + rect[2]) / 2;
  const cy = (rect[1] + rect[3]) / 2;
  const m = multiply(multiply([1, 0, 0, 1, cx, cy], rotationMatrix(r)), [1, 0, 0, 1, -w / 2, -h / 2]);
  return { m, w, h };
}

const cm = (m: Matrix) => `${m.map(fmt).join(" ")} cm`;

/** Baseline offset (from the top of a 1.2em line box) matching the browser rendering. */
const BASELINE: Record<string, number> = { Helvetica: 0.946, Times: 0.937, Courier: 0.867 };

async function textBlockOps(
  ctx: Ctx,
  text: string,
  opts: { family: "Helvetica" | "Times" | "Courier"; bold: boolean; italic: boolean; size: number; colorHex: string; width: number; height: number; pad: number; align: "left" | "center" | "right"; lineHeight?: number },
  fonts: Record<string, PDFFont>,
): Promise<string> {
  const key = fontKeyFor(opts.family, opts.bold, opts.italic);
  const font = await ctx.fonts.forText(key, text);
  const fname = `F${Object.keys(fonts).length + 1}`;
  fonts[fname] = font;
  const lh = opts.size * (opts.lineHeight ?? 1.2);
  const maxW = opts.width - opts.pad * 2;
  const lines = wrapText(text, key, opts.size, maxW);
  const out: string[] = ["BT", `/${fname} ${fmt(opts.size)} Tf`, color(opts.colorHex, false)];
  let y = opts.height - opts.pad - (lh - opts.size * 1.2) / 2 - opts.size * BASELINE[opts.family];
  for (const line of lines) {
    if (line) {
      const w = font.widthOfTextAtSize(line, opts.size);
      const x = opts.align === "center" ? (opts.width - w) / 2 : opts.align === "right" ? opts.width - opts.pad - w : opts.pad;
      out.push(`1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`, `${font.encodeText(line).toString()} Tj`);
    }
    y -= lh;
  }
  out.push("ET");
  return out.join("\n");
}

function fontResources(fonts: Record<string, PDFFont>) {
  const dict: Record<string, PDFRef> = {};
  for (const [k, f] of Object.entries(fonts)) dict[k] = f.ref;
  return { Font: dict };
}

async function imageRef(ctx: Ctx, src: string): Promise<PDFRef> {
  let ref = ctx.imageCache.get(src);
  if (!ref) {
    const bytes = dataUrlToBytes(src);
    const img = src.startsWith("data:image/jpeg") || src.startsWith("data:image/jpg") ? await ctx.doc.embedJpg(bytes) : await ctx.doc.embedPng(bytes);
    ref = img.ref;
    ctx.imageCache.set(src, ref);
  }
  return ref;
}

function endingOps(kind: LineEnding, tip: Point, from: Point, w: number, strokeHex: string, fillHex: string | null): string {
  const e = lineEnding(kind, tip, from, w);
  if (!e) return "";
  const p = toPdfOps(e.path);
  return e.filled ? `${color(fillHex ?? strokeHex, false)}\n${p}\nB` : `${p}\nS`;
}

function stampRoundRect(x: number, y: number, w: number, h: number, r: number): Path {
  const k = 0.5523 * r;
  return [
    { op: "M", p: { x: x + r, y } },
    { op: "L", p: { x: x + w - r, y } },
    { op: "C", c1: { x: x + w - r + k, y }, c2: { x: x + w, y: y + r - k }, p: { x: x + w, y: y + r } },
    { op: "L", p: { x: x + w, y: y + h - r } },
    { op: "C", c1: { x: x + w, y: y + h - r + k }, c2: { x: x + w - r + k, y: y + h }, p: { x: x + w - r, y: y + h } },
    { op: "L", p: { x: x + r, y: y + h } },
    { op: "C", c1: { x: x + r - k, y: y + h }, c2: { x, y: y + h - r + k }, p: { x, y: y + h - r } },
    { op: "L", p: { x, y: y + r } },
    { op: "C", c1: { x, y: y + r - k }, c2: { x: x + r - k, y }, p: { x: x + r, y } },
    { op: "Z" },
  ];
}

/** Builds the normal appearance of an annotation in PDF user space. */
export async function buildAppearance(ctx: Ctx, a: Annotation): Promise<Appearance | null> {
  const doc = ctx.doc;
  switch (a.kind) {
    case "highlight": {
      const ops = ["/GS0 gs", color(a.color, false), ...a.quads.map((q) => `${toPdfOps(polylinePath([{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[6], y: q[7] }, { x: q[4], y: q[5] }], true))}\nf`)];
      return { ops: ops.join("\n"), resources: gsResources(doc, a.opacity, true) };
    }
    case "underline":
    case "strikeout": {
      const ops = ["/GS0 gs", color(a.color, true)];
      for (const q of a.quads) {
        const { path, width } = quadLine(q, a.kind === "underline" ? 0.08 : 0.42);
        ops.push(`${fmt(width)} w`, toPdfOps(path), "S");
      }
      return { ops: ops.join("\n"), resources: gsResources(doc, a.opacity) };
    }
    case "squiggly": {
      const ops = ["/GS0 gs", color(a.color, true), "0.9 w 1 j"];
      for (const q of a.quads) ops.push(toPdfOps(squigglyPath(q)), "S");
      return { ops: ops.join("\n"), resources: gsResources(doc, a.opacity) };
    }
    case "ink": {
      const ops = ["/GS0 gs", color(a.color, true), `${fmt(a.strokeWidth)} w 1 J 1 j`];
      for (const p of a.paths) ops.push(toPdfOps(smoothPath(p)), "S");
      return { ops: ops.join("\n"), resources: gsResources(doc, a.opacity, !!a.highlighter) };
    }
    case "rect":
    case "ellipse": {
      const inset = a.strokeWidth / 2;
      const r: PdfRect = [a.rect[0] + inset, a.rect[1] + inset, a.rect[2] - inset, a.rect[3] - inset];
      const path =
        a.borderStyle === "cloudy"
          ? a.kind === "rect"
            ? cloudRectPath(a.rect, Math.max(4, a.strokeWidth * 3))
            : cloudPath(Array.from({ length: 24 }, (_, i) => ({ x: (r[0] + r[2]) / 2 + ((r[2] - r[0]) / 2) * Math.cos((i / 24) * Math.PI * 2), y: (r[1] + r[3]) / 2 + ((r[3] - r[1]) / 2) * Math.sin((i / 24) * Math.PI * 2) })), Math.max(4, a.strokeWidth * 3))
          : a.kind === "rect"
            ? rectPath(r)
            : ellipseInRect(r);
      const stroke = a.strokeWidth > 0;
      const ops = ["/GS0 gs", `${fmt(a.strokeWidth)} w 1 j`, dashOps(a.borderStyle, a.strokeWidth), color(a.color, true)];
      if (a.fillColor) ops.push(color(a.fillColor, false));
      ops.push(toPdfOps(path), a.fillColor ? (stroke ? "B" : "f") : "S");
      return { ops: ops.filter(Boolean).join("\n"), resources: gsResources(doc, a.opacity) };
    }
    case "line": {
      const [p0, p1] = a.points;
      const s0 = trimForEnding(a.startEnding, p0, p1, a.strokeWidth);
      const s1 = trimForEnding(a.endEnding, p1, p0, a.strokeWidth);
      const ops = ["/GS0 gs", `${fmt(a.strokeWidth)} w`, dashOps(a.borderStyle, a.strokeWidth), color(a.color, true), toPdfOps(polylinePath([s0, s1])), "S", "[] 0 d", "0 j"];
      ops.push(endingOps(a.startEnding, p0, p1, a.strokeWidth, a.color, a.fillColor), endingOps(a.endEnding, p1, p0, a.strokeWidth, a.color, a.fillColor));
      const fonts: Record<string, PDFFont> = {};
      if (a.measure) {
        for (const [p, o] of [
          [p0, p1],
          [p1, p0],
        ] as const)
          ops.push(endingOps("Butt", p, o, a.strokeWidth * 1.5, a.color, null));
        const label = measureText(a)!;
        ops.push(await labelOps(ctx, label, { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, a.color, fonts, Math.atan2(p1.y - p0.y, p1.x - p0.x)));
      }
      return { ops: ops.filter(Boolean).join("\n"), resources: { ...gsResources(doc, a.opacity), ...fontResources(fonts) } };
    }
    case "polygon":
    case "polyline": {
      const closed = a.kind === "polygon";
      const path = closed && a.borderStyle === "cloudy" ? cloudPath(a.vertices, Math.max(4, a.strokeWidth * 3)) : polylinePath(a.vertices, closed);
      const ops = ["/GS0 gs", `${fmt(a.strokeWidth)} w 1 j 1 J`, dashOps(a.borderStyle, a.strokeWidth), color(a.color, true)];
      if (closed && a.fillColor) {
        // Measured areas use a translucent fill like the on-screen preview.
        if (a.measure) ops.push("q", "/GS1 gs", color(a.fillColor, false), toPdfOps(path), "f", "Q");
        else ops.push(color(a.fillColor, false));
      }
      ops.push(toPdfOps(path), closed && a.fillColor && !a.measure ? "B" : "S");
      const fonts: Record<string, PDFFont> = {};
      const resources: Record<string, unknown> = { ExtGState: { GS0: doc.context.register(doc.context.obj({ CA: a.opacity, ca: a.opacity })), GS1: doc.context.register(doc.context.obj({ ca: 0.15 * a.opacity })) } };
      if (a.measure) {
        const label = measureText(a)!;
        const n = a.vertices.length || 1;
        const at = closed ? { x: a.vertices.reduce((s, p) => s + p.x, 0) / n, y: a.vertices.reduce((s, p) => s + p.y, 0) / n } : a.vertices[a.vertices.length - 1];
        ops.push(await labelOps(ctx, label, at, a.color, fonts, 0));
      }
      return { ops: ops.filter(Boolean).join("\n"), resources: { ...resources, ...fontResources(fonts) } };
    }
    case "note": {
      // Speech-bubble icon in a 20x20 box anchored at the rect's top-left.
      const x = a.rect[0],
        top = a.rect[3];
      const s = Math.min(a.rect[2] - a.rect[0], a.rect[3] - a.rect[1]) / 20;
      const P = (px: number, py: number) => `${fmt(x + px * s)} ${fmt(top - py * s)}`;
      const ops = [
        "/GS0 gs",
        color(a.color, false),
        "0.235 0.235 0.235 RG",
        `${fmt(0.9 * s)} w 1 j`,
        `${P(3, 2.5)} m ${P(17, 2.5)} l ${P(19, 4.5)} ${P(19, 4.5)} ${P(19, 4.5)} c ${P(19, 13.5)} l ${P(17, 15.5)} l ${P(9, 15.5)} l ${P(4.5, 19)} l ${P(4.5, 15.5)} l ${P(3, 15.5)} l ${P(1, 13.5)} l ${P(1, 4.5)} l h B`,
        `${fmt(1 * s)} w 1 J`,
        `${P(5, 6.5)} m ${P(15, 6.5)} l S ${P(5, 9.2)} m ${P(15, 9.2)} l S ${P(5, 11.9)} m ${P(11.5, 11.9)} l S`,
      ];
      return { ops: ops.join("\n"), resources: gsResources(doc, a.opacity) };
    }
    case "freetext": {
      const fonts: Record<string, PDFFont> = {};
      const { m, w, h } = frameMatrix(a.rect, a.rotation);
      const ops: string[] = ["/GS0 gs"];
      if (a.callout?.length) {
        const bw = Math.max(1, a.borderWidth);
        ops.push(`${fmt(bw)} w`, color(a.borderColor ?? a.color, true), toPdfOps(polylinePath(a.callout)), "S");
        ops.push(endingOps("OpenArrow", a.callout[0], a.callout[1] ?? a.callout[0], bw, a.borderColor ?? a.color, null));
      }
      ops.push("q", cm(m));
      if (a.fillColor) ops.push(color(a.fillColor, false), `0 0 ${fmt(w)} ${fmt(h)} re f`);
      if (a.borderColor && a.borderWidth > 0) {
        const bw = a.borderWidth;
        ops.push(`${fmt(bw)} w`, color(a.borderColor, true), `${fmt(bw / 2)} ${fmt(bw / 2)} ${fmt(w - bw)} ${fmt(h - bw)} re S`);
      }
      ops.push(`0 0 ${fmt(w)} ${fmt(h)} re W n`);
      ops.push(
        await textBlockOps(ctx, a.text, { family: a.fontFamily, bold: a.bold, italic: a.italic, size: a.fontSize, colorHex: a.textColor, width: w, height: h, pad: 2 + a.borderWidth, align: a.align }, fonts),
      );
      ops.push("Q");
      return { ops: ops.join("\n"), resources: { ...gsResources(doc, a.opacity), ...fontResources(fonts) } };
    }
    case "stamp": {
      const fonts: Record<string, PDFFont> = {};
      const { m, w, h } = frameMatrix(a.rect, a.rotation);
      const L = stampLayout(a.label, a.sublabel);
      const sx = w / L.width,
        sy = h / L.height;
      const font = ctx.fonts.get("Helvetica-Bold");
      fonts.F1 = font;
      // SVG layout is y-down; flip into the content frame.
      const ops = [
        "/GS0 gs",
        "q",
        cm(m),
        `${fmt(sx)} 0 0 ${fmt(-sy)} 0 ${fmt(h)} cm`,
        "q 1 1 1 rg /GS1 gs",
        toPdfOps(stampRoundRect(1, 1, L.width - 2, L.height - 2, L.size * 0.35)),
        "f Q",
        color(a.color, true),
        "2.2 w",
        toPdfOps(stampRoundRect(1, 1, L.width - 2, L.height - 2, L.size * 0.35)),
        "S 0.8 w",
        toPdfOps(stampRoundRect(4, 4, L.width - 8, L.height - 8, L.size * 0.25)),
        "S",
        color(a.color, false),
        "BT",
        `/F1 ${fmt(L.size)} Tf`,
        `1 0 0 -1 ${fmt((L.width - L.labelW) / 2)} ${fmt(L.pad + L.size * 0.8)} Tm`,
        `${font.encodeText(a.label).toString()} Tj`,
      ];
      if (a.sublabel) {
        const sub = await ctx.fonts.forText("Helvetica-Bold", a.sublabel);
        fonts.F2 = sub;
        ops.push(`/F2 ${fmt(L.subSize)} Tf`, `1 0 0 -1 ${fmt((L.width - L.subW) / 2)} ${fmt(L.pad + L.size * 0.95 + L.subSize * 1.15)} Tm`, `${sub.encodeText(a.sublabel).toString()} Tj`);
      }
      ops.push("ET", "Q");
      const res = { ExtGState: { GS0: doc.context.register(doc.context.obj({ CA: a.opacity, ca: a.opacity })), GS1: doc.context.register(doc.context.obj({ ca: 0.55 })) }, ...fontResources(fonts) };
      return { ops: ops.join("\n"), resources: res };
    }
    case "image": {
      const ref = await imageRef(ctx, a.src);
      const { m, w, h } = frameMatrix(a.rect, a.rotation);
      const ops = ["/GS0 gs", "q", cm(m), `${fmt(w)} 0 0 ${fmt(h)} 0 0 cm`, "/Im0 Do", "Q"];
      return { ops: ops.join("\n"), resources: { ...gsResources(doc, a.opacity), XObject: { Im0: ref } } };
    }
    case "symbol": {
      const { m, w, h } = frameMatrix(a.rect, a.rotation);
      const ops = ["/GS0 gs", "q", cm(m), `1 0 0 -1 0 ${fmt(h)} cm`, color(a.color, true), color(a.color, false), `${fmt(a.strokeWidth)} w 1 J 1 j`];
      const P = (fx: number, fy: number) => `${fmt(w * fx)} ${fmt(h * fy)}`;
      switch (a.symbol) {
        case "check":
          ops.push(`${P(0.12, 0.55)} m ${P(0.4, 0.82)} l ${P(0.9, 0.18)} l S`);
          break;
        case "cross":
          ops.push(`${P(0.15, 0.15)} m ${P(0.85, 0.85)} l S ${P(0.85, 0.15)} m ${P(0.15, 0.85)} l S`);
          break;
        case "dot": {
          const r = Math.min(w, h) * 0.32;
          ops.push(toPdfOps(ellipseInRect([w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r])), "f");
          break;
        }
        case "circle":
          ops.push(toPdfOps(ellipseInRect([1, 1, w - 1, h - 1])), "S");
          break;
        case "line":
          ops.push(`${P(0, 0.5)} m ${P(1, 0.5)} l S`);
          break;
        case "rectangle":
          ops.push(`${P(0.04, 0.04)} ${fmt(w * 0.92)} ${fmt(h * 0.92)} re S`);
          break;
      }
      ops.push("Q");
      return { ops: ops.join("\n"), resources: gsResources(doc, a.opacity) };
    }
    case "redact": {
      const shapes = a.quads?.length ? a.quads.map((q) => polylinePath([{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[6], y: q[7] }, { x: q[4], y: q[5] }], true)) : [rectPath(a.rect)];
      const ops = ["0.898 0.22 0.231 RG 1 w", ...shapes.map((p) => `${toPdfOps(p)}\nS`)];
      return { ops: ops.join("\n"), resources: {} };
    }
    default:
      return null;
  }
}

async function labelOps(ctx: Ctx, label: string, at: Point, colorHex: string, fonts: Record<string, PDFFont>, angle: number): Promise<string> {
  const font = await ctx.fonts.forText("Helvetica-Bold", label);
  const name = `F${Object.keys(fonts).length + 1}`;
  fonts[name] = font;
  const size = 9;
  const w = font.widthOfTextAtSize(label, size) + 8;
  let ang = angle;
  if (ang > Math.PI / 2) ang -= Math.PI;
  if (ang < -Math.PI / 2) ang += Math.PI;
  const c = Math.cos(ang),
    s = Math.sin(ang);
  return [
    "q",
    `${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} ${fmt(at.x)} ${fmt(at.y)} cm`,
    "1 1 1 rg",
    color(colorHex, true),
    "0.6 w",
    `${fmt(-w / 2)} 0 ${fmt(w)} ${fmt(size + 6)} re B`,
    color(colorHex, false),
    "BT",
    `/${name} ${size} Tf`,
    `1 0 0 1 ${fmt(-w / 2 + 4)} 4 Tm`,
    `${font.encodeText(label).toString()} Tj`,
    "ET",
    "Q",
  ].join("\n");
}

function appearanceStream(ctx: Ctx, ap: Appearance, bbox: PdfRect): PDFRef {
  const stream = ctx.doc.context.flateStream(ap.ops, {
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: bbox.map((v) => Math.round(v * 1000) / 1000),
    Resources: ap.resources,
  } as never);
  return ctx.doc.context.register(stream);
}

/** Folio-only fields are stored as JSON so the annotation can be restored exactly. */
function folioData(a: Annotation): string {
  const { ...copy } = a as Annotation & { src?: string };
  if (a.kind === "image") delete (copy as { src?: string }).src; // image lives in the appearance stream
  return JSON.stringify({ v: 1, ...copy });
}

function commonEntries(a: Annotation, pageRef: PDFRef | undefined) {
  const entries: Record<string, unknown> = {
    Type: "Annot",
    Subtype: SUBTYPE[a.kind],
    Rect: computeRect(a).map((v) => Math.round(v * 1000) / 1000),
    F: 4 | (a.locked ? 128 : 0),
    NM: pdfText(a.id),
    M: pdfText(isoToPdfDate(a.modifiedAt)),
    CreationDate: pdfText(isoToPdfDate(a.createdAt)),
    T: pdfText(a.author),
  };
  if (pageRef) entries.P = pageRef;
  if (a.contents) entries.Contents = pdfText(a.contents);
  if (a.subject) entries.Subj = pdfText(a.subject);
  if (a.opacity < 1) entries.CA = a.opacity;
  const c = pdfColor(a.kind === "freetext" ? a.fillColor : a.color);
  if (c && a.kind !== "redact") entries.C = c;
  return entries;
}

function specificEntries(a: Annotation): Record<string, unknown> {
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return { QuadPoints: a.quads.flat().map((v) => Math.round(v * 1000) / 1000) };
    case "note":
      return { Name: a.icon, Open: false };
    case "freetext": {
      const fontName = a.fontFamily === "Times" ? "TiRo" : a.fontFamily === "Courier" ? "Cour" : "Helv";
      const [r, g, b] = hexToPdf(a.textColor);
      const e: Record<string, unknown> = {
        DA: pdfText(`/${fontName} ${fmt(a.fontSize)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`),
        DS: pdfText(`font: ${a.fontFamily} ${fmt(a.fontSize)}pt; text-align:${a.align}; color:${a.textColor}`),
        Q: a.align === "center" ? 1 : a.align === "right" ? 2 : 0,
        Contents: pdfText(a.text),
        BS: { W: a.borderColor ? a.borderWidth : 0 },
        Rotate: normalizeRotation(a.rotation),
      };
      if (a.fillColor) e.IC = hexToPdf(a.fillColor);
      if (a.callout?.length) {
        e.IT = "FreeTextCallout";
        e.CL = a.callout.flatMap((p) => [p.x, p.y]);
        e.LE = "OpenArrow";
      } else if (a.plain) e.IT = "FreeTextTypeWriter";
      return e;
    }
    case "ink":
      return { InkList: a.paths.map((p) => p.flatMap((pt) => [Math.round(pt.x * 100) / 100, Math.round(pt.y * 100) / 100])), BS: { W: a.strokeWidth } };
    case "rect":
    case "ellipse": {
      const e: Record<string, unknown> = { BS: { W: a.strokeWidth, S: a.borderStyle === "dashed" ? "D" : "S" } };
      if (a.fillColor) e.IC = hexToPdf(a.fillColor);
      if (a.borderStyle === "cloudy") e.BE = { S: "C", I: 1 };
      return e;
    }
    case "line": {
      const e: Record<string, unknown> = {
        L: a.points.flatMap((p) => [p.x, p.y]),
        LE: [a.startEnding, a.endEnding],
        BS: { W: a.strokeWidth, S: a.borderStyle === "dashed" ? "D" : "S" },
      };
      if (a.fillColor) e.IC = hexToPdf(a.fillColor);
      if (a.measure) {
        e.IT = "LineDimension";
        e.Measure = measureDict(a.measure);
        e.Cap = true;
      }
      return e;
    }
    case "polygon":
    case "polyline": {
      const e: Record<string, unknown> = { Vertices: a.vertices.flatMap((p) => [p.x, p.y]), BS: { W: a.strokeWidth, S: a.borderStyle === "dashed" ? "D" : "S" } };
      if (a.fillColor && a.kind === "polygon") e.IC = hexToPdf(a.fillColor);
      if (a.borderStyle === "cloudy") {
        e.BE = { S: "C", I: 1 };
        e.IT = "PolygonCloud";
      }
      if (a.measure) {
        e.IT = a.kind === "polygon" ? "PolygonDimension" : "PolyLineDimension";
        e.Measure = measureDict(a.measure);
      }
      return e;
    }
    case "stamp":
      return { Name: STD_STAMP_NAMES.has(a.stampName) ? a.stampName : `#${a.stampName}`, Rotate: normalizeRotation(a.rotation) };
    case "image":
      return { Name: a.role === "signature" ? "#Signature" : a.role === "initials" ? "#Initials" : "#Image", Rotate: normalizeRotation(a.rotation) };
    case "symbol":
      return { Name: `#${a.symbol}` };
    case "redact": {
      const e: Record<string, unknown> = { IC: hexToPdf(a.fillColor), OC: [0.898, 0.22, 0.231] };
      if (a.quads?.length) e.QuadPoints = a.quads.flat();
      if (a.overlayText) e.OverlayText = pdfText(a.overlayText);
      return e;
    }
    default:
      return {};
  }
}

function measureDict(m: NonNullable<LineAnnot["measure"]>) {
  const numberFormat = (unit: string, factor: number) => [{ Type: "NumberFormat", U: pdfText(unit), C: factor, D: 10 ** m.precision, F: "D" }];
  return {
    Type: "Measure",
    Subtype: "RL",
    R: pdfText(m.scaleLabel),
    X: numberFormat(m.unit, m.factor),
    D: numberFormat(m.unit, 1),
    A: numberFormat(`sq ${m.unit}`, m.factor * m.factor),
  };
}

function toPdfObjects(doc: PDFDocument, entries: Record<string, unknown>) {
  // pdf-lib turns plain JS strings into names; "#Name" marks a non-standard name.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined) continue;
    out[k] = typeof v === "string" && v.startsWith("#") ? v.slice(1) : v;
  }
  return doc.context.obj(out as never) as unknown as PDFDict;
}

export interface WriteOptions {
  /** Draw every annotation into the page content instead of keeping it editable. */
  flattenAll?: boolean;
  fonts: FontCache;
}

/**
 * Writes Folio annotations into the document. `pageIds[i]` is the id of the
 * i-th page. Text edits, redactions marks and form fields are handled by
 * their own writers.
 */
export async function writeAnnotations(doc: PDFDocument, annots: Annotation[], pageIds: string[], opts: WriteOptions) {
  const pages = doc.getPages();
  const pageIndex = new Map(pageIds.map((id, i) => [id, i]));
  const ctx: Ctx = { doc, fonts: opts.fonts, pageRefs: new Map(pageIds.map((id, i) => [id, pages[i]?.ref])), imageCache: new Map() };
  const refs = new Map<string, PDFRef>();
  for (const a of annots) {
    if (a.kind === "textedit" || a.kind === "field") continue;
    const pi = pageIndex.get(a.pageId);
    if (pi === undefined) continue;
    const page = pages[pi];
    if (a.kind === "link") {
      addAnnotRef(page, writeLink(doc, a, ctx));
      continue;
    }
    const ap = await buildAppearance(ctx, a);
    if (!ap) continue;
    const rect = computeRect(a);
    const flatten = (opts.flattenAll || a.flatten) && a.kind !== "redact";
    if (flatten) {
      flattenAppearance(doc, page, ap, rect);
      continue;
    }
    const apRef = appearanceStream(ctx, ap, rect);
    const dict = toPdfObjects(doc, { ...commonEntries(a, ctx.pageRefs.get(a.pageId)), ...specificEntries(a) });
    dict.set(PDFName.of("AP"), doc.context.obj({ N: apRef }));
    dict.set(PDFName.of(FOLIO_KEY), pdfText(folioData(a)));
    const ref = doc.context.register(dict);
    refs.set(a.id, ref);
    addAnnotRef(page, ref);
    if (a.kind === "note") addPopup(doc, page, dict, ref, a);
    writeThread(doc, page, a, ref);
  }
  return refs;
}

function flattenAppearance(doc: PDFDocument, page: PDFPage, ap: Appearance, bbox: PdfRect) {
  const ctx = doc.context;
  const form = ctx.register(
    ctx.flateStream(ap.ops, { Type: "XObject", Subtype: "Form", BBox: bbox, Resources: ap.resources } as never),
  );
  const name = addPageResource(page, "XObject", "FolioFl", form);
  addPageContent(doc, page, `q /${name} Do Q`);
}

function addPopup(doc: PDFDocument, page: PDFPage, parent: PDFDict, parentRef: PDFRef, a: NoteAnnot) {
  const { width } = page.getSize();
  const x = Math.min(a.rect[2] + 10, width - 200);
  const popup = doc.context.obj({
    Type: "Annot",
    Subtype: "Popup",
    Rect: [x, a.rect[3] - 120, x + 190, a.rect[3]],
    Parent: parentRef,
    Open: false,
    F: 28,
  });
  const ref = doc.context.register(popup);
  parent.set(PDFName.of("Popup"), ref);
  addAnnotRef(page, ref);
}

/** Replies and review states are separate Text annotations pointing at the parent (/IRT). */
function writeThread(doc: PDFDocument, page: PDFPage, a: Annotation, parentRef: PDFRef) {
  if (!a.replies.length && a.status === "None") return;
  const rect = computeRect(a);
  const r = [rect[0], rect[3] - 20, rect[0] + 20, rect[3]];
  // Replies aren't drawn by Acrobat; an empty appearance keeps other viewers
  // from showing them as extra note icons.
  const empty = doc.context.register(doc.context.flateStream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] } as never));
  for (const reply of a.replies) {
    const dict = doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: r,
      IRT: parentRef,
      RT: PDFName.of("R"),
      F: 28,
      NM: pdfText(reply.id),
      T: pdfText(reply.author),
      Contents: pdfText(reply.contents),
      M: pdfText(isoToPdfDate(reply.modifiedAt)),
      CreationDate: pdfText(isoToPdfDate(reply.createdAt)),
      Open: false,
      AP: { N: empty },
    });
    addAnnotRef(page, doc.context.register(dict));
  }
  if (a.status !== "None") {
    const dict = doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: r,
      IRT: parentRef,
      F: 30,
      StateModel: pdfText("Review"),
      State: pdfText(a.status),
      T: pdfText(a.author),
      Contents: pdfText(`${a.status} set by ${a.author}`),
      NM: pdfText(`${a.id}-state`),
      M: pdfText(isoToPdfDate(a.modifiedAt)),
      AP: { N: empty },
    });
    addAnnotRef(page, doc.context.register(dict));
  }
}

function writeLink(doc: PDFDocument, a: LinkAnnot, ctx: Ctx): PDFRef {
  const entries: Record<string, unknown> = {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: a.rect,
    Border: [0, 0, a.showBorder ? 1 : 0],
    C: hexToPdf(a.color),
    F: 4,
    NM: pdfText(a.id),
  };
  if (a.target.type === "url") {
    entries.A = doc.context.obj({ Type: "Action", S: "URI", URI: pdfText(a.target.url) });
  } else {
    const pageRef = ctx.pageRefs.get(a.target.pageId);
    if (pageRef) entries.Dest = [pageRef, PDFName.of("XYZ"), null, a.target.top ?? null, null];
  }
  const dict = doc.context.obj(entries as never) as unknown as PDFDict;
  dict.set(PDFName.of(FOLIO_KEY), pdfText(folioData(a)));
  return doc.context.register(dict);
}

export type { InkAnnot, ShapeAnnot, PolyAnnot, StampAnnot, ImageAnnot, SymbolAnnot, RedactAnnot, TextMarkupAnnot, FreeTextAnnot };
export { PDFArray };
