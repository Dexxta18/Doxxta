import type { Annotation } from "./types";
import {
  distToPolyline,
  distToSegment,
  inflateRect,
  normRect,
  pointInPolygon,
  pointsBounds,
  quadBounds,
  rectContainsPoint,
  unionRects,
  type PdfRect,
  type Point,
  type Quad,
} from "../lib/geometry";

/** Recomputes the bounding rect of an annotation from its geometry. */
export function computeRect(a: Annotation): PdfRect {
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return unionRects(a.quads.map(quadBounds)) ?? a.rect;
    case "redact":
      return a.quads?.length ? (unionRects(a.quads.map(quadBounds)) ?? a.rect) : a.rect;
    case "ink": {
      const pts = a.paths.flat();
      return pts.length ? inflateRect(pointsBounds(pts), a.strokeWidth / 2 + 1) : a.rect;
    }
    case "line": {
      const pad = a.strokeWidth * (a.startEnding !== "None" || a.endEnding !== "None" ? 5 : 1) + 2;
      return inflateRect(pointsBounds(a.points), pad);
    }
    case "polygon":
    case "polyline": {
      const pad = a.strokeWidth / 2 + (a.borderStyle === "cloudy" ? 8 : 1);
      return inflateRect(pointsBounds(a.vertices), pad);
    }
    case "freetext": {
      if (a.callout?.length) return unionRects([a.rect, inflateRect(pointsBounds(a.callout), 4)])!;
      return a.rect;
    }
    default:
      return a.rect;
  }
}

/** The box used for selection handles (for freetext with callouts, only the text box). */
export function selectionRect(a: Annotation): PdfRect {
  if (a.kind === "freetext") return a.rect;
  if (a.kind === "line") return pointsBounds(a.points);
  if (a.kind === "polygon" || a.kind === "polyline") return pointsBounds(a.vertices);
  if (a.kind === "ink") return pointsBounds(a.paths.flat());
  return computeRect(a);
}

const movePt = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });
const moveQuad = (q: Quad, dx: number, dy: number): Quad => q.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) as Quad;

export function translateAnnot<T extends Annotation>(a: T, dx: number, dy: number): T {
  const r = a.rect;
  const rect: PdfRect = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return { ...a, rect, quads: a.quads.map((q) => moveQuad(q, dx, dy)) };
    case "redact":
    case "link":
      return { ...a, rect, quads: a.quads?.map((q) => moveQuad(q, dx, dy)) };
    case "ink":
      return { ...a, rect, paths: a.paths.map((p) => p.map((pt) => movePt(pt, dx, dy))) };
    case "line":
      return { ...a, rect, points: a.points.map((p) => movePt(p, dx, dy)) as [Point, Point] };
    case "polygon":
    case "polyline":
      return { ...a, rect, vertices: a.vertices.map((p) => movePt(p, dx, dy)) };
    case "freetext":
      return { ...a, rect, callout: a.callout?.map((p) => movePt(p, dx, dy)) };
    case "textedit":
      return { ...a, rect, originalRect: a.originalRect };
    default:
      return { ...a, rect };
  }
}

/** Maps the annotation's geometry from one box to another (resizing). */
export function transformAnnot<T extends Annotation>(a: T, from: PdfRect, to: PdfRect): T {
  const sx = from[2] - from[0] > 1e-6 ? (to[2] - to[0]) / (from[2] - from[0]) : 1;
  const sy = from[3] - from[1] > 1e-6 ? (to[3] - to[1]) / (from[3] - from[1]) : 1;
  const f = (p: Point): Point => ({ x: to[0] + (p.x - from[0]) * sx, y: to[1] + (p.y - from[1]) * sy });
  const fr = (r: PdfRect): PdfRect => {
    const p1 = f({ x: r[0], y: r[1] });
    const p2 = f({ x: r[2], y: r[3] });
    return normRect(p1.x, p1.y, p2.x, p2.y);
  };
  switch (a.kind) {
    case "ink": {
      const next = { ...a, paths: a.paths.map((p) => p.map(f)) };
      return { ...next, rect: computeRect(next) };
    }
    case "line": {
      const next = { ...a, points: a.points.map(f) as [Point, Point] };
      return { ...next, rect: computeRect(next) };
    }
    case "polygon":
    case "polyline": {
      const next = { ...a, vertices: a.vertices.map(f) };
      return { ...next, rect: computeRect(next) };
    }
    case "freetext":
      // Text boxes resize without scaling the text; the callout target stays put.
      return { ...a, rect: fr(a.rect) };
    case "link":
      // A resized link no longer follows the text lines it was made from.
      return { ...a, rect: fr(a.rect), quads: undefined };
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly": {
      const quads = a.quads.map((q) => {
        const out: number[] = [];
        for (let i = 0; i < 8; i += 2) {
          const p = f({ x: q[i], y: q[i + 1] });
          out.push(p.x, p.y);
        }
        return out as Quad;
      });
      return { ...a, quads, rect: fr(a.rect) };
    }
    default:
      return { ...a, rect: fr(a.rect) };
  }
}

/** Whether an annotation can be resized with handles (and whether to keep aspect). */
export function resizeMode(a: Annotation): "none" | "free" | "aspect" | "vertices" {
  switch (a.kind) {
    case "note":
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return "none";
    case "redact":
      return a.quads?.length ? "none" : "free";
    case "line":
    case "polygon":
    case "polyline":
      return "vertices";
    case "image":
    case "stamp":
      return "aspect";
    default:
      return "free";
  }
}

/** Precise hit test in PDF space; `tol` is in points. */
export function hitTest(a: Annotation, p: Point, tol: number): boolean {
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return a.quads.some((q) => rectContainsPoint(quadBounds(q), p, tol));
    case "redact":
      return a.quads?.length ? a.quads.some((q) => rectContainsPoint(quadBounds(q), p, tol)) : rectContainsPoint(a.rect, p, tol);
    case "ink":
      return a.paths.some((path) => distToPolyline(p, path) <= tol + a.strokeWidth / 2);
    case "line":
      return distToSegment(p, a.points[0], a.points[1]) <= tol + a.strokeWidth / 2;
    case "polyline":
      return distToPolyline(p, a.vertices) <= tol + a.strokeWidth / 2;
    case "polygon":
      return (
        distToPolyline(p, a.vertices, true) <= tol + a.strokeWidth / 2 || (a.fillColor !== null && pointInPolygon(p, a.vertices))
      );
    case "rect":
    case "ellipse": {
      if (a.fillColor) return rectContainsPoint(a.rect, p, tol);
      const [x1, y1, x2, y2] = a.rect;
      if (a.kind === "rect") {
        const inOuter = rectContainsPoint(a.rect, p, tol + a.strokeWidth);
        const inInner = p.x > x1 + tol + a.strokeWidth && p.x < x2 - tol - a.strokeWidth && p.y > y1 + tol + a.strokeWidth && p.y < y2 - tol - a.strokeWidth;
        return inOuter && !inInner;
      }
      const cx = (x1 + x2) / 2,
        cy = (y1 + y2) / 2,
        rx = (x2 - x1) / 2,
        ry = (y2 - y1) / 2;
      if (rx <= 0 || ry <= 0) return false;
      const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      const t = (tol + a.strokeWidth) / Math.min(rx, ry);
      return Math.abs(d - 1) <= t;
    }
    default:
      return rectContainsPoint(computeRect(a), p, tol);
  }
}
