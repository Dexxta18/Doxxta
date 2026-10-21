import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  decodeText,
  loadPdfLib,
  nameOf,
  num,
  numbers,
  pageTreeWasRepaired,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from "../lib/pdflib";
import type { Annotation, LineEnding, MeasureInfo, NoteIcon, ReviewStatus } from "./types";
import { pdfColorToHex } from "../lib/colors";
import { pdfDateToIso } from "../lib/pdfjs";
import { invert, normRect, stageTransform, type PdfRect, type Point, type Quad } from "../lib/geometry";
import { nowIso, uid } from "../lib/util";
import { computeRect } from "./geometry";
import { QUILLMARK_KEY } from "./writer";

export interface ImportResult {
  bytes: Uint8Array;
  changed: boolean;
  annotations: { pageIndex: number; annot: Annotation }[];
  /** Annotations left in the file because they can't be edited (foreign stamps, links, widgets…). */
  skipped: number;
}

const MARKUP = new Set(["Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly", "StrikeOut", "Ink", "Stamp", "Redact"]);
const NOTE_ICONS = new Set(["Comment", "Note", "Help", "Insert", "Key", "NewParagraph", "Paragraph"]);
const ENDINGS = new Set(["None", "OpenArrow", "ClosedArrow", "Circle", "Square", "Diamond", "Butt", "Slash", "ROpenArrow", "RClosedArrow"]);

const get = (d: PDFDict, k: string) => d.get(PDFName.of(k));
const lookup = (doc: PDFDocument, o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);

/**
 * Lifts editable annotations out of a PDF into the Quillmark model and returns
 * the document without them (so pdf.js doesn't draw them a second time).
 * Decrypts the document when a password is given.
 */
export async function importAnnotations(bytes: Uint8Array, password?: string): Promise<ImportResult> {
  const doc = await loadPdfLib(bytes, password);
  const pages = doc.getPages();
  const out: { pageIndex: number; annot: Annotation }[] = [];
  const refToModel = new Map<string, Annotation>();
  let skipped = 0;
  // A repaired page tree is kept too: viewers trust a damaged one's page count and may hide pages.
  let changed = password !== undefined || pageTreeWasRepaired(doc);

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const annotsObj = lookup(doc, page.node.get(PDFName.of("Annots")));
    if (!(annotsObj instanceof PDFArray)) continue;
    const entries: { ref: PDFObject; dict: PDFDict }[] = [];
    for (let i = 0; i < annotsObj.size(); i++) {
      const ref = annotsObj.get(i);
      const dict = lookup(doc, ref);
      if (dict instanceof PDFDict) entries.push({ ref, dict });
    }
    const removed = new Set<PDFObject>();
    const rotation = page.getRotation().angle;
    const view = pageView(page);

    // Pass 1: top-level markup annotations.
    for (const e of entries) {
      const subtype = nameOf(get(e.dict, "Subtype"));
      if (!subtype || !MARKUP.has(subtype)) {
        if (subtype && subtype !== "Popup" && subtype !== "Link" && subtype !== "Widget") skipped++;
        continue;
      }
      if (get(e.dict, "IRT")) continue; // replies & states, pass 2
      const flags = num(get(e.dict, "F"));
      if (flags & 2) continue; // hidden
      let annot: Annotation | null = null;
      try {
        annot = convert(doc, e.dict, subtype, rotation, view);
      } catch (err) {
        console.warn("Could not import annotation", subtype, err);
      }
      if (!annot) {
        skipped++;
        continue;
      }
      out.push({ pageIndex: pi, annot });
      if (e.ref instanceof PDFRef) refToModel.set(e.ref.tag, annot);
      removed.add(e.ref);
    }

    // Pass 2: replies / review states attached to imported parents; popups of imported parents.
    for (const e of entries) {
      const subtype = nameOf(get(e.dict, "Subtype"));
      if (subtype === "Popup") {
        const parent = get(e.dict, "Parent");
        if (parent instanceof PDFRef && refToModel.has(parent.tag)) removed.add(e.ref);
        else if (!parent) removed.add(e.ref);
        continue;
      }
      const irt = get(e.dict, "IRT");
      if (!(irt instanceof PDFRef) || subtype !== "Text") continue;
      const parent = refToModel.get(irt.tag);
      if (!parent) continue;
      const stateModel = decodeText(get(e.dict, "StateModel"));
      const state = decodeText(get(e.dict, "State")) as ReviewStatus;
      if (stateModel === "Review" && ["Accepted", "Rejected", "Cancelled", "Completed", "None"].includes(state)) {
        parent.status = state;
      } else if (stateModel !== "Marked") {
        const replyId = decodeText(get(e.dict, "NM")) || uid("r");
        // Quillmark-written parents already carry their thread in the private data.
        if (parent.replies.some((r) => r.id === replyId)) {
          removed.add(e.ref);
          continue;
        }
        parent.replies.push({
          id: replyId,
          author: decodeText(get(e.dict, "T")) || "Unknown",
          contents: decodeText(get(e.dict, "Contents")),
          createdAt: pdfDateToIso(decodeText(get(e.dict, "CreationDate"))) ?? nowIso(),
          modifiedAt: pdfDateToIso(decodeText(get(e.dict, "M"))) ?? nowIso(),
        });
        // Replies to replies are flattened into the parent's thread.
        if (e.ref instanceof PDFRef) refToModel.set(e.ref.tag, parent);
      }
      removed.add(e.ref);
    }

    if (removed.size) {
      changed = true;
      const keep = entries.filter((e) => !removed.has(e.ref)).map((e) => e.ref);
      if (keep.length) page.node.set(PDFName.of("Annots"), doc.context.obj(keep));
      else page.node.delete(PDFName.of("Annots"));
    }
  }
  for (const { annot } of out) annot.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!changed) return { bytes, changed: false, annotations: [], skipped };
  const saved = await doc.save({ useObjectStreams: true });
  return { bytes: saved, changed: true, annotations: out, skipped };
}

export function pageView(page: PDFPage): number[] {
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const x0 = Math.max(crop.x, media.x),
    y0 = Math.max(crop.y, media.y);
  const x1 = Math.min(crop.x + crop.width, media.x + media.width),
    y1 = Math.min(crop.y + crop.height, media.y + media.height);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [media.x, media.y, media.x + media.width, media.y + media.height];
}

export function rectOf(d: PDFDict): PdfRect {
  const r = numbers(get(d, "Rect"));
  return r.length === 4 ? normRect(r[0], r[1], r[2], r[3]) : [0, 0, 0, 0];
}

export function colorOf(d: PDFDict, key = "C"): string | null {
  return pdfColorToHex(numbers(get(d, key)));
}

/** Orders quad points as UL, UR, LL, LR relative to the page's upright reading direction. */
function normalizeQuad(q: number[], rotation: number, view: number[]): Quad {
  const { m } = stageTransform(view, rotation);
  const inv = invert(m);
  // Screen "up" (0,-1) and "right" (1,0) expressed in user space (linear part only).
  const up = { x: -inv[2], y: -inv[3] };
  const right = { x: inv[0], y: inv[1] };
  const pts = [0, 2, 4, 6].map((i) => ({ x: q[i], y: q[i + 1] }));
  const byUp = [...pts].sort((a, b) => b.x * up.x + b.y * up.y - (a.x * up.x + a.y * up.y));
  const upper = byUp.slice(0, 2).sort((a, b) => a.x * right.x + a.y * right.y - (b.x * right.x + b.y * right.y));
  const lower = byUp.slice(2).sort((a, b) => a.x * right.x + a.y * right.y - (b.x * right.x + b.y * right.y));
  return [upper[0].x, upper[0].y, upper[1].x, upper[1].y, lower[0].x, lower[0].y, lower[1].x, lower[1].y];
}

export function quadsOf(d: PDFDict, rotation: number, view: number[]): Quad[] {
  const q = numbers(get(d, "QuadPoints"));
  const out: Quad[] = [];
  for (let i = 0; i + 7 < q.length; i += 8) out.push(normalizeQuad(q.slice(i, i + 8), rotation, view));
  if (!out.length) {
    const r = rectOf(d);
    out.push([r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]]);
  }
  return out;
}

export function borderWidth(doc: PDFDocument, d: PDFDict, fallback = 1): number {
  const bs = lookup(doc, get(d, "BS"));
  if (bs instanceof PDFDict) {
    const w = get(bs, "W");
    if (w) return num(w, fallback);
  }
  const border = numbers(get(d, "Border"));
  if (border.length >= 3) return border[2];
  return fallback;
}

function borderDashed(doc: PDFDocument, d: PDFDict): boolean {
  const bs = lookup(doc, get(d, "BS"));
  return bs instanceof PDFDict && nameOf(get(bs, "S")) === "D";
}

function cloudy(doc: PDFDocument, d: PDFDict): boolean {
  const be = lookup(doc, get(d, "BE"));
  return (be instanceof PDFDict && nameOf(get(be, "S")) === "C") || nameOf(get(d, "IT")) === "PolygonCloud";
}

function measureOf(doc: PDFDocument, d: PDFDict, kind: MeasureInfo["kind"]): MeasureInfo | undefined {
  const m = lookup(doc, get(d, "Measure"));
  if (!(m instanceof PDFDict)) return undefined;
  const x = lookup(doc, get(m, "X"));
  const first = x instanceof PDFArray ? lookup(doc, x.get(0)) : undefined;
  if (!(first instanceof PDFDict)) return undefined;
  const factor = num(get(first, "C"), 1);
  const denom = num(get(first, "D"), 100);
  return {
    kind,
    factor,
    unit: decodeText(get(first, "U")) || "pt",
    scaleLabel: decodeText(get(m, "R")) || "",
    precision: Math.max(0, Math.round(Math.log10(denom || 100))),
  };
}

function parseDA(da: string) {
  const size = parseFloat(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? "12") || 12;
  const font = /\/([\w-]+)\s+[\d.]+\s+Tf/.exec(da)?.[1] ?? "Helv";
  let color = "#000000";
  const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const g = /([\d.]+)\s+g(?:\s|$)/.exec(da);
  const k = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+k/.exec(da);
  if (rg) color = pdfColorToHex([+rg[1], +rg[2], +rg[3]]) ?? color;
  else if (k) color = pdfColorToHex([+k[1], +k[2], +k[3], +k[4]]) ?? color;
  else if (g) color = pdfColorToHex([+g[1]]) ?? color;
  const family = /tim|ser|roman/i.test(font) ? "Times" : /cour|mono/i.test(font) ? "Courier" : "Helvetica";
  return { size, color, family: family as "Helvetica" | "Times" | "Courier", bold: /bold|bd/i.test(font), italic: /ital|obl/i.test(font) };
}

function stripRichText(rc: string): string {
  return rc
    .replace(/<\/p>\s*/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();
}

function pointsOf(arr: number[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 1 < arr.length; i += 2) out.push({ x: arr[i], y: arr[i + 1] });
  return out;
}

function convert(doc: PDFDocument, d: PDFDict, subtype: string, pageRotation: number, view: number[]): Annotation | null {
  const stored = readQuillmarkData(doc, d);
  if (stored) return stored;

  const now = nowIso();
  const rect = rectOf(d);
  const flags = num(get(d, "F"));
  const base = {
    id: decodeText(get(d, "NM")) || uid("a"),
    pageId: "",
    rect,
    color: colorOf(d) ?? "#ffd400",
    opacity: get(d, "CA") ? num(get(d, "CA"), 1) : 1,
    author: decodeText(get(d, "T")) || "Unknown",
    subject: decodeText(get(d, "Subj")) || undefined,
    contents: decodeText(get(d, "Contents")),
    createdAt: pdfDateToIso(decodeText(get(d, "CreationDate"))) ?? pdfDateToIso(decodeText(get(d, "M"))) ?? now,
    modifiedAt: pdfDateToIso(decodeText(get(d, "M"))) ?? now,
    replies: [],
    status: "None" as ReviewStatus,
    locked: (flags & 128) !== 0 || undefined,
    rotation: pageRotation,
  };
  switch (subtype) {
    case "Highlight":
    case "Underline":
    case "StrikeOut":
    case "Squiggly": {
      const kind = ({ Highlight: "highlight", Underline: "underline", StrikeOut: "strikeout", Squiggly: "squiggly" } as const)[subtype];
      const a = {
        ...base,
        kind,
        color: colorOf(d) ?? (kind === "highlight" ? "#ffd400" : "#e5383b"),
        opacity: get(d, "CA") ? num(get(d, "CA"), 1) : kind === "highlight" ? 0.45 : 1,
        quads: quadsOf(d, pageRotation, view),
      } as Annotation;
      return { ...a, rect: computeRect(a) };
    }
    case "Text": {
      const icon = nameOf(get(d, "Name")) ?? "Comment";
      return {
        ...base,
        kind: "note",
        color: colorOf(d) ?? "#ffd400",
        icon: (NOTE_ICONS.has(icon) ? icon : "Comment") as NoteIcon,
        rect: [rect[0], rect[3] - 20, rect[0] + 20, rect[3]],
        rotation: 0,
      };
    }
    case "FreeText": {
      const da = parseDA(decodeText(get(d, "DA")));
      const rc = decodeText(get(d, "RC"));
      const text = base.contents || (rc ? stripRichText(rc) : "");
      const q = num(get(d, "Q"));
      const bw = borderWidth(doc, d, 0);
      const fill = colorOf(d, "IC") ?? colorOf(d, "C");
      const it = nameOf(get(d, "IT"));
      const cl = pointsOf(numbers(get(d, "CL")));
      // /RD insets the text box inside /Rect (callouts put the box inside a bigger rect).
      const rd = numbers(get(d, "RD"));
      const boxRect: PdfRect = rd.length === 4 ? [rect[0] + rd[0], rect[1] + rd[3], rect[2] - rd[2], rect[3] - rd[1]] : rect;
      return {
        ...base,
        kind: "freetext",
        rect: boxRect,
        text,
        contents: it === "FreeTextTypeWriter" ? "" : text,
        fontFamily: da.family,
        fontSize: da.size,
        bold: da.bold,
        italic: da.italic,
        textColor: da.color,
        fillColor: fill,
        borderColor: bw > 0 ? da.color : null,
        borderWidth: bw,
        align: q === 1 ? "center" : q === 2 ? "right" : "left",
        callout: it === "FreeTextCallout" && cl.length >= 2 ? cl : undefined,
        plain: it === "FreeTextTypeWriter" || undefined,
        color: colorOf(d) ?? da.color,
        rotation: num(get(d, "Rotate"), pageRotation),
      };
    }
    case "Ink": {
      const list = lookup(doc, get(d, "InkList"));
      const paths: Point[][] = [];
      if (list instanceof PDFArray) for (let i = 0; i < list.size(); i++) paths.push(pointsOf(numbers(lookup(doc, list.get(i)))));
      if (!paths.some((p) => p.length)) return null;
      const a = { ...base, kind: "ink", color: colorOf(d) ?? "#000000", paths: paths.filter((p) => p.length), strokeWidth: borderWidth(doc, d, 1) } as Annotation;
      return { ...a, rect: computeRect(a) };
    }
    case "Square":
    case "Circle": {
      const rd = numbers(get(d, "RD"));
      const w = borderWidth(doc, d, 1);
      let r = rect;
      if (rd.length === 4) r = [rect[0] + rd[0], rect[1] + rd[3], rect[2] - rd[2], rect[3] - rd[1]];
      return {
        ...base,
        kind: subtype === "Square" ? "rect" : "ellipse",
        rect: r,
        color: colorOf(d) ?? "#e5383b",
        strokeWidth: w,
        fillColor: colorOf(d, "IC"),
        borderStyle: cloudy(doc, d) ? "cloudy" : borderDashed(doc, d) ? "dashed" : "solid",
      };
    }
    case "Line": {
      const l = numbers(get(d, "L"));
      if (l.length < 4) return null;
      const le = lookup(doc, get(d, "LE"));
      const ends: LineEnding[] = ["None", "None"];
      if (le instanceof PDFArray) for (let i = 0; i < 2; i++) {
        const n = nameOf(le.get(i));
        if (n && ENDINGS.has(n)) ends[i] = n.replace(/^R/, "") as LineEnding;
      }
      const a = {
        ...base,
        kind: "line",
        color: colorOf(d) ?? "#e5383b",
        points: [
          { x: l[0], y: l[1] },
          { x: l[2], y: l[3] },
        ],
        strokeWidth: borderWidth(doc, d, 1),
        startEnding: ends[0],
        endEnding: ends[1],
        borderStyle: borderDashed(doc, d) ? "dashed" : "solid",
        fillColor: colorOf(d, "IC"),
        measure: measureOf(doc, d, "distance"),
      } as Annotation;
      return { ...a, rect: computeRect(a) };
    }
    case "Polygon":
    case "PolyLine": {
      const v = pointsOf(numbers(get(d, "Vertices")));
      if (v.length < 2) return null;
      const kind = subtype === "Polygon" ? "polygon" : "polyline";
      const a = {
        ...base,
        kind,
        color: colorOf(d) ?? "#e5383b",
        vertices: v,
        strokeWidth: borderWidth(doc, d, 1),
        fillColor: colorOf(d, "IC"),
        borderStyle: cloudy(doc, d) ? "cloudy" : borderDashed(doc, d) ? "dashed" : "solid",
        measure: measureOf(doc, d, kind === "polygon" ? "area" : "perimeter"),
      } as Annotation;
      return { ...a, rect: computeRect(a) };
    }
    case "Redact": {
      const q = get(d, "QuadPoints") ? quadsOf(d, pageRotation, view) : undefined;
      return {
        ...base,
        kind: "redact",
        color: "#e5383b",
        fillColor: colorOf(d, "IC") ?? "#000000",
        quads: q,
        overlayText: decodeText(get(d, "OverlayText")) || undefined,
      };
    }
    default:
      // Foreign stamps keep their own appearance in the page.
      return null;
  }
}

/** Restores an annotation written by Quillmark when it hasn't been changed by another app. */
export function readQuillmarkData(doc: PDFDocument, d: PDFDict): Annotation | null {
  const raw = decodeText(get(d, QUILLMARK_KEY));
  if (!raw) return null;
  let data: Annotation & { v?: number };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.v !== 1 || !data.kind) return null;
  const m = pdfDateToIso(decodeText(get(d, "M")));
  // Another app edited it after us: fall back to the standard keys.
  if (m && data.modifiedAt && Math.abs(new Date(m).getTime() - new Date(data.modifiedAt).getTime()) > 2000) return null;
  delete data.v;
  if (data.kind === "image") {
    const src = extractAppearanceImage(doc, d);
    if (!src) return null;
    (data as { src: string }).src = src;
  }
  return { ...data, pageId: "", replies: data.replies ?? [] };
}

/** Rebuilds a data: URL for the image inside an annotation's appearance stream. */
function extractAppearanceImage(doc: PDFDocument, d: PDFDict): string | null {
  const ap = lookup(doc, get(d, "AP"));
  if (!(ap instanceof PDFDict)) return null;
  const n = lookup(doc, get(ap, "N"));
  if (!(n instanceof PDFStream)) return null;
  const res = lookup(doc, get(n.dict, "Resources"));
  if (!(res instanceof PDFDict)) return null;
  const xo = lookup(doc, get(res, "XObject"));
  if (!(xo instanceof PDFDict)) return null;
  const imgObj = lookup(doc, get(xo, "Im0"));
  if (!(imgObj instanceof PDFRawStream)) return null;
  return imageStreamToDataUrl(doc, imgObj);
}

export function imageStreamToDataUrl(doc: PDFDocument, img: PDFRawStream): string | null {
  const filter = nameOf(get(img.dict, "Filter"));
  if (filter === "DCTDecode") {
    let bin = "";
    const b = img.contents;
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(bin)}`;
  }
  const w = num(get(img.dict, "Width"));
  const h = num(get(img.dict, "Height"));
  const bpc = num(get(img.dict, "BitsPerComponent"), 8);
  const cs = nameOf(get(img.dict, "ColorSpace"));
  if (!w || !h || bpc !== 8) return null;
  const pixels = decodePDFRawStream(img).decode();
  const comps = cs === "DeviceGray" ? 1 : 3;
  if (pixels.length < w * h * comps) return null;
  let alpha: Uint8Array | null = null;
  const smask = lookup(doc, get(img.dict, "SMask"));
  if (smask instanceof PDFRawStream) {
    const a = decodePDFRawStream(smask).decode();
    if (a.length >= w * h) alpha = a;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const data = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (comps === 1) data.data[o] = data.data[o + 1] = data.data[o + 2] = pixels[i];
    else {
      data.data[o] = pixels[i * 3];
      data.data[o + 1] = pixels[i * 3 + 1];
      data.data[o + 2] = pixels[i * 3 + 2];
    }
    data.data[o + 3] = alpha ? alpha[i] : 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}
