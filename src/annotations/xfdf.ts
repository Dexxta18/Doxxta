import type { Annotation, LineEnding, NoteIcon, ReviewStatus } from "./types";
import { getDoc, toast } from "../state/store";
import { addAnnotations } from "../state/annotActions";
import { downloadBlob, escapeXml, nowIso, pickFiles, uid, withExt } from "../lib/util";
import { isoToPdfDate, pdfDateToIso } from "../lib/pdfjs";
import { computeRect } from "./geometry";
import { hexToRgb } from "../lib/colors";
import type { Point, Quad } from "../lib/geometry";

/**
 * XFDF (XML Forms Data Format) is how Acrobat exchanges comments between
 * reviewers. We write the standard elements plus a `doxxta-data` attribute
 * carrying the full model for lossless round trips between Doxxta users.
 */

const TAG: Partial<Record<Annotation["kind"], string>> = {
  highlight: "highlight",
  underline: "underline",
  strikeout: "strikeout",
  squiggly: "squiggly",
  note: "text",
  freetext: "freetext",
  ink: "ink",
  rect: "square",
  ellipse: "circle",
  line: "line",
  polygon: "polygon",
  polyline: "polyline",
  stamp: "stamp",
  image: "stamp",
  symbol: "stamp",
  redact: "redact",
};

const n = (v: number) => String(Math.round(v * 1000) / 1000);
const pts = (p: Point[]) => p.map((q) => `${n(q.x)},${n(q.y)}`).join(";");

export function annotationsToXfdf(annots: Annotation[], pageIndex: Map<string, number>, fileName: string): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">', "<annots>"];
  for (const a of annots) {
    const tag = TAG[a.kind];
    const page = pageIndex.get(a.pageId);
    if (!tag || page === undefined) continue;
    const rect = computeRect(a);
    const attrs: Record<string, string> = {
      page: String(page),
      rect: rect.map(n).join(","),
      name: a.id,
      title: a.author,
      date: isoToPdfDate(a.modifiedAt),
      creationdate: isoToPdfDate(a.createdAt),
      flags: a.locked ? "print,locked" : "print",
    };
    if (a.kind !== "redact") attrs.color = (a.kind === "freetext" ? (a.fillColor ?? a.textColor) : a.color).toUpperCase();
    if (a.opacity < 1) attrs.opacity = n(a.opacity);
    if (a.subject) attrs.subject = a.subject;
    let inner = "";
    switch (a.kind) {
      case "highlight":
      case "underline":
      case "strikeout":
      case "squiggly":
        attrs.coords = a.quads.flat().map(n).join(",");
        break;
      case "note":
        attrs.icon = a.icon;
        break;
      case "freetext": {
        const [r, g, b] = hexToRgb(a.textColor).map((v) => v / 255);
        const font = a.fontFamily === "Times" ? "TiRo" : a.fontFamily === "Courier" ? "Cour" : "Helv";
        attrs.justification = a.align;
        inner += `<defaultappearance>${escapeXml(`/${font} ${n(a.fontSize)} Tf ${n(r)} ${n(g)} ${n(b)} rg`)}</defaultappearance>`;
        if (a.callout?.length) {
          attrs.callout = a.callout.flatMap((p) => [n(p.x), n(p.y)]).join(",");
          attrs.intent = "FreeTextCallout";
        }
        if (a.borderWidth) attrs.width = n(a.borderWidth);
        break;
      }
      case "ink":
        attrs.width = n(a.strokeWidth);
        inner += `<inklist>${a.paths.map((p) => `<gesture>${pts(p)}</gesture>`).join("")}</inklist>`;
        break;
      case "rect":
      case "ellipse":
        attrs.width = n(a.strokeWidth);
        if (a.fillColor) attrs["interior-color"] = a.fillColor.toUpperCase();
        if (a.borderStyle === "dashed") attrs.style = "dash";
        if (a.borderStyle === "cloudy") {
          attrs.style = "cloudy";
          attrs.intensity = "1";
        }
        break;
      case "line":
        attrs.start = `${n(a.points[0].x)},${n(a.points[0].y)}`;
        attrs.end = `${n(a.points[1].x)},${n(a.points[1].y)}`;
        attrs.head = a.startEnding;
        attrs.tail = a.endEnding;
        attrs.width = n(a.strokeWidth);
        if (a.measure) attrs.intent = "LineDimension";
        break;
      case "polygon":
      case "polyline":
        attrs.width = n(a.strokeWidth);
        if (a.fillColor) attrs["interior-color"] = a.fillColor.toUpperCase();
        if (a.borderStyle === "cloudy") {
          attrs.style = "cloudy";
          attrs.intensity = "1";
        }
        inner += `<vertices>${pts(a.vertices)}</vertices>`;
        break;
      case "stamp":
        attrs.icon = a.stampName;
        break;
      case "image":
        attrs.icon = a.role === "signature" ? "Signature" : "Image";
        break;
      case "symbol":
        attrs.icon = a.symbol;
        break;
      case "redact":
        attrs["interior-color"] = a.fillColor.toUpperCase();
        if (a.quads?.length) attrs.coords = a.quads.flat().map(n).join(",");
        if (a.overlayText) attrs["overlay-text"] = a.overlayText;
        break;
    }
    const data = { v: 1, ...a } as Record<string, unknown>;
    attrs["doxxta-data"] = JSON.stringify(data);
    const contents = a.kind === "freetext" ? a.text : a.contents;
    const attrStr = Object.entries(attrs)
      .map(([k, v]) => `${k}="${escapeXml(v)}"`)
      .join(" ");
    out.push(`<${tag} ${attrStr}>${contents ? `<contents>${escapeXml(contents)}</contents>` : ""}${inner}</${tag}>`);
    for (const r of a.replies) {
      out.push(
        `<text page="${page}" rect="${rect.map(n).join(",")}" name="${escapeXml(r.id)}" title="${escapeXml(r.author)}" date="${isoToPdfDate(r.modifiedAt)}" creationdate="${isoToPdfDate(r.createdAt)}" inreplyto="${escapeXml(a.id)}" replyType="reply" flags="print,nozoom,norotate"><contents>${escapeXml(r.contents)}</contents></text>`,
      );
    }
    if (a.status !== "None") {
      out.push(
        `<text page="${page}" rect="${rect.map(n).join(",")}" name="${escapeXml(a.id)}-state" title="${escapeXml(a.author)}" inreplyto="${escapeXml(a.id)}" state="${a.status}" statemodel="Review" flags="hidden,print,nozoom,norotate"/>`,
      );
    }
  }
  out.push("</annots>", `<f href="${escapeXml(fileName)}"/>`, "</xfdf>");
  return out.join("\n");
}

export async function exportCommentsToFile(docId: string) {
  const doc = getDoc(docId);
  if (!doc) return;
  const list = doc.annotations.filter((a) => TAG[a.kind] && !a.flatten);
  if (!list.length) {
    toast("There are no comments to export", "info");
    return;
  }
  const xml = annotationsToXfdf(list, new Map(doc.pages.map((p, i) => [p.id, i])), doc.name);
  downloadBlob(new Blob([xml], { type: "application/vnd.adobe.xfdf" }), withExt(doc.name, "xfdf"));
  toast(`Exported ${list.length} comments`, "success");
}

const nums = (s: string | null) => (s ? s.split(/[\s,;]+/).filter(Boolean).map(Number) : []);
const pointsOf = (s: string | null): Point[] => {
  const v = nums(s);
  const out: Point[] = [];
  for (let i = 0; i + 1 < v.length; i += 2) out.push({ x: v[i], y: v[i + 1] });
  return out;
};

export function xfdfToAnnotations(xml: string, pageIds: string[]): Annotation[] {
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  if (dom.querySelector("parsererror")) throw new Error("This file is not valid XFDF");
  const annotsEl = dom.getElementsByTagName("annots")[0];
  if (!annotsEl) return [];
  const byName = new Map<string, Annotation>();
  const result: Annotation[] = [];
  const replies: Element[] = [];
  for (const el of Array.from(annotsEl.children)) {
    if (el.getAttribute("inreplyto")) {
      replies.push(el);
      continue;
    }
    const a = elementToAnnotation(el, pageIds);
    if (a) {
      result.push(a);
      byName.set(el.getAttribute("name") ?? a.id, a);
    }
  }
  for (const el of replies) {
    const parent = byName.get(el.getAttribute("inreplyto")!);
    if (!parent) continue;
    const state = el.getAttribute("state");
    if (state && (el.getAttribute("statemodel") ?? "Review") === "Review") {
      parent.status = state as ReviewStatus;
      continue;
    }
    const id = el.getAttribute("name") || uid("r");
    if (parent.replies.some((r) => r.id === id)) continue;
    parent.replies.push({
      id,
      author: el.getAttribute("title") ?? "Unknown",
      contents: el.getElementsByTagName("contents")[0]?.textContent ?? "",
      createdAt: pdfDateToIso(el.getAttribute("creationdate")) ?? nowIso(),
      modifiedAt: pdfDateToIso(el.getAttribute("date")) ?? nowIso(),
    });
  }
  return result;
}

function elementToAnnotation(el: Element, pageIds: string[]): Annotation | null {
  const page = Number(el.getAttribute("page") ?? 0);
  const pageId = pageIds[page];
  if (!pageId) return null;
  // Quillmark (the app's former name) wrote "quillmark-data".
  const data = el.getAttribute("doxxta-data") ?? el.getAttribute("quillmark-data");
  if (data) {
    try {
      const parsed = JSON.parse(data);
      if (parsed?.v === 1) {
        delete parsed.v;
        return { ...parsed, pageId };
      }
    } catch {
      /* fall through to standard attributes */
    }
  }
  const tag = el.tagName.toLowerCase();
  const r = nums(el.getAttribute("rect"));
  const rect: [number, number, number, number] = r.length === 4 ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : [0, 0, 0, 0];
  const base = {
    id: el.getAttribute("name") || uid("a"),
    pageId,
    rect,
    color: el.getAttribute("color") ?? "#ffd400",
    opacity: el.getAttribute("opacity") ? Number(el.getAttribute("opacity")) : 1,
    author: el.getAttribute("title") ?? "Unknown",
    subject: el.getAttribute("subject") ?? undefined,
    contents: el.getElementsByTagName("contents")[0]?.textContent ?? "",
    createdAt: pdfDateToIso(el.getAttribute("creationdate")) ?? nowIso(),
    modifiedAt: pdfDateToIso(el.getAttribute("date")) ?? nowIso(),
    replies: [],
    status: "None" as ReviewStatus,
    rotation: 0,
    locked: (el.getAttribute("flags") ?? "").includes("locked") || undefined,
  };
  const width = Number(el.getAttribute("width") ?? 1);
  const style = el.getAttribute("style");
  let a: Annotation | null = null;
  switch (tag) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly": {
      const c = nums(el.getAttribute("coords"));
      const quads: Quad[] = [];
      for (let i = 0; i + 7 < c.length; i += 8) quads.push(c.slice(i, i + 8) as Quad);
      a = { ...base, kind: tag, quads: quads.length ? quads : [[rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]]] } as Annotation;
      break;
    }
    case "text":
      a = { ...base, kind: "note", icon: (el.getAttribute("icon") ?? "Comment") as NoteIcon, rect: [rect[0], rect[3] - 20, rect[0] + 20, rect[3]] };
      break;
    case "freetext": {
      const da = el.getElementsByTagName("defaultappearance")[0]?.textContent ?? "/Helv 12 Tf 0 g";
      const size = parseFloat(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? "12");
      const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
      const textColor = rg ? `#${[rg[1], rg[2], rg[3]].map((v) => Math.round(+v * 255).toString(16).padStart(2, "0")).join("")}` : "#000000";
      const callout = pointsOf(el.getAttribute("callout"));
      a = {
        ...base,
        kind: "freetext",
        text: base.contents,
        fontFamily: /TiRo|Times/.test(da) ? "Times" : /Cour/.test(da) ? "Courier" : "Helvetica",
        fontSize: size,
        bold: false,
        italic: false,
        textColor,
        fillColor: el.getAttribute("color"),
        borderColor: width > 0 && el.hasAttribute("width") ? textColor : null,
        borderWidth: el.hasAttribute("width") ? width : 0,
        align: (el.getAttribute("justification") as "left" | "center" | "right") ?? "left",
        callout: callout.length >= 2 ? callout : undefined,
      };
      break;
    }
    case "ink": {
      const paths = Array.from(el.getElementsByTagName("gesture")).map((g) => pointsOf(g.textContent));
      a = { ...base, kind: "ink", paths, strokeWidth: width };
      break;
    }
    case "square":
    case "circle":
      a = {
        ...base,
        kind: tag === "square" ? "rect" : "ellipse",
        strokeWidth: width,
        fillColor: el.getAttribute("interior-color"),
        borderStyle: style === "cloudy" ? "cloudy" : style === "dash" ? "dashed" : "solid",
      };
      break;
    case "line": {
      const s = nums(el.getAttribute("start"));
      const e = nums(el.getAttribute("end"));
      a = {
        ...base,
        kind: "line",
        points: [
          { x: s[0], y: s[1] },
          { x: e[0], y: e[1] },
        ],
        strokeWidth: width,
        startEnding: (el.getAttribute("head") ?? "None") as LineEnding,
        endEnding: (el.getAttribute("tail") ?? "None") as LineEnding,
        borderStyle: style === "dash" ? "dashed" : "solid",
        fillColor: el.getAttribute("interior-color"),
      };
      break;
    }
    case "polygon":
    case "polyline":
      a = {
        ...base,
        kind: tag,
        vertices: pointsOf(el.getElementsByTagName("vertices")[0]?.textContent ?? ""),
        strokeWidth: width,
        fillColor: el.getAttribute("interior-color"),
        borderStyle: style === "cloudy" ? "cloudy" : style === "dash" ? "dashed" : "solid",
      };
      break;
    case "redact": {
      const c = nums(el.getAttribute("coords"));
      const quads: Quad[] = [];
      for (let i = 0; i + 7 < c.length; i += 8) quads.push(c.slice(i, i + 8) as Quad);
      a = { ...base, kind: "redact", color: "#e5383b", fillColor: el.getAttribute("interior-color") ?? "#000000", quads: quads.length ? quads : undefined, overlayText: el.getAttribute("overlay-text") ?? undefined };
      break;
    }
    default:
      return null;
  }
  return { ...a, rect: computeRect(a) } as Annotation;
}

export async function importCommentsFromFile(docId: string) {
  const [file] = await pickFiles(".xfdf,.xml,application/vnd.adobe.xfdf,text/xml");
  if (!file) return;
  const doc = getDoc(docId);
  if (!doc) return;
  try {
    const list = xfdfToAnnotations(await file.text(), doc.pages.map((p) => p.id));
    const existing = new Set(doc.annotations.map((a) => a.id));
    const fresh = list.filter((a) => !existing.has(a.id));
    if (!fresh.length) {
      toast(list.length ? "All comments in that file are already here" : "No comments found in that file", "info");
      return;
    }
    addAnnotations(docId, fresh, `Import ${fresh.length} comments`, false);
    toast(`Imported ${fresh.length} comments`, "success");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
  }
}
