/**
 * Geometry helpers.
 *
 * Three coordinate systems are used throughout the app:
 *  - PDF user space: origin bottom-left (as defined by the page boxes), y up,
 *    units are points. All annotation geometry is stored in this space.
 *  - Stage space: the page as displayed with its rotation applied, origin
 *    top-left, y down, 1 unit = 1 point (zoom is applied with a CSS scale).
 *  - Client space: CSS pixels in the browser window.
 */

export type Point = { x: number; y: number };
export type Matrix = [number, number, number, number, number, number];
/** PDF-style rectangle [x1, y1, x2, y2] with x1 <= x2 and y1 <= y2. */
export type PdfRect = [number, number, number, number];
export type Box = { x: number; y: number; w: number; h: number };
/** Quad in PDF QuadPoints order: upper-left, upper-right, lower-left, lower-right (relative to reading direction). */
export type Quad = [number, number, number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  // Equivalent to applying m2 first, then m1 (same convention as pdf.js Util.transform(m1, m2)).
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const d = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(d) < 1e-12) return [...IDENTITY];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[4] * m[3]) / d, (m[4] * m[1] - m[5] * m[0]) / d];
}

export function apply(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function applyPt(m: Matrix, p: Point): Point {
  return apply(m, p.x, p.y);
}

export function normRect(x1: number, y1: number, x2: number, y2: number): PdfRect {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/** Bounding box of a rect after transformation. */
export function transformRect(m: Matrix, r: PdfRect): PdfRect {
  const pts = [apply(m, r[0], r[1]), apply(m, r[2], r[1]), apply(m, r[0], r[3]), apply(m, r[2], r[3])];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const rectWidth = (r: PdfRect) => r[2] - r[0];
export const rectHeight = (r: PdfRect) => r[3] - r[1];

export function rectToBox(r: PdfRect): Box {
  return { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] };
}

export function boxToRect(b: Box): PdfRect {
  return normRect(b.x, b.y, b.x + b.w, b.y + b.h);
}

export function unionRects(rects: PdfRect[]): PdfRect | null {
  if (!rects.length) return null;
  let [x1, y1, x2, y2] = rects[0];
  for (const r of rects) {
    x1 = Math.min(x1, r[0]);
    y1 = Math.min(y1, r[1]);
    x2 = Math.max(x2, r[2]);
    y2 = Math.max(y2, r[3]);
  }
  return [x1, y1, x2, y2];
}

export function rectsIntersect(a: PdfRect, b: PdfRect, pad = 0): boolean {
  return a[0] - pad < b[2] && a[2] + pad > b[0] && a[1] - pad < b[3] && a[3] + pad > b[1];
}

export function intersectRects(a: PdfRect, b: PdfRect): PdfRect | null {
  const r: PdfRect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
}

export function rectContainsPoint(r: PdfRect, p: Point, pad = 0): boolean {
  return p.x >= r[0] - pad && p.x <= r[2] + pad && p.y >= r[1] - pad && p.y <= r[3] + pad;
}

export function rectContainsRect(outer: PdfRect, inner: PdfRect, tol = 0): boolean {
  return inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;
}

export function inflateRect(r: PdfRect, d: number): PdfRect {
  return [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
}

export function pointsBounds(points: Point[]): PdfRect {
  if (!points.length) return [0, 0, 0, 0];
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const p of points) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  return [x1, y1, x2, y2];
}

export function quadBounds(q: Quad): PdfRect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function quadPoints(q: Quad): { ul: Point; ur: Point; ll: Point; lr: Point } {
  return { ul: { x: q[0], y: q[1] }, ur: { x: q[2], y: q[3] }, ll: { x: q[4], y: q[5] }, lr: { x: q[6], y: q[7] } };
}

export function transformQuad(m: Matrix, q: Quad): Quad {
  const out: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    const p = apply(m, q[i], q[i + 1]);
    out.push(p.x, p.y);
  }
  return out as Quad;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Point, pts: Point[], closed = false): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]));
  if (closed && pts.length > 2) best = Math.min(best, distToSegment(p, pts[pts.length - 1], pts[0]));
  if (pts.length === 1) best = dist(p, pts[0]);
  return best;
}

export function pointInPolygon(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x,
      yi = pts[i].y,
      xj = pts[j].x,
      yj = pts[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a / 2);
}

export function polylineLength(pts: Point[], closed = false): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) l += dist(pts[pts.length - 1], pts[0]);
  return l;
}

/** Ramer–Douglas–Peucker simplification for freehand strokes. */
export function simplifyPath(pts: Point[], epsilon: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0,
      idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Transform from PDF user space to stage space for a page, mirroring pdf.js'
 * PageViewport with scale = 1 and userUnit = 1.
 */
export function stageTransform(view: number[], rotation: number): { m: Matrix; width: number; height: number } {
  const [x0, y0, x1, y1] = view;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let a: number, b: number, c: number, d: number;
  const rot = ((rotation % 360) + 360) % 360;
  switch (rot) {
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  let ox: number, oy: number, width: number, height: number;
  if (a === 0) {
    ox = Math.abs(cy - y0);
    oy = Math.abs(cx - x0);
    width = y1 - y0;
    height = x1 - x0;
  } else {
    ox = Math.abs(cx - x0);
    oy = Math.abs(cy - y0);
    width = x1 - x0;
    height = y1 - y0;
  }
  const m: Matrix = [a, b, c, d, ox - a * cx - c * cy, oy - b * cx - d * cy];
  return { m, width, height };
}

export const normalizeRotation = (r: number) => ((Math.round(r / 90) * 90) % 360 + 360) % 360;

/** Rotation matrix about origin for multiples of 90 degrees (counter-clockwise in y-up space). */
export function rotationMatrix(deg: number): Matrix {
  switch (normalizeRotation(deg)) {
    case 90:
      return [0, 1, -1, 0, 0, 0];
    case 180:
      return [-1, 0, 0, -1, 0, 0];
    case 270:
      return [0, -1, 1, 0, 0, 0];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
