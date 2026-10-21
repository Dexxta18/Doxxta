import { apply, type Matrix, type Point, type PdfRect, type Quad } from "../lib/geometry";
import { fmt } from "../lib/colors";
import type { LineEnding } from "./types";

/**
 * Device-independent path description. Geometry is built once in PDF user
 * space, then serialized either to an SVG path (through the page→stage
 * matrix) or to PDF content-stream operators for appearance streams.
 */
export type Seg = { op: "M" | "L"; p: Point } | { op: "C"; c1: Point; c2: Point; p: Point } | { op: "Z" };
export type Path = Seg[];

const K = 0.5522847498; // bezier circle constant

export function polylinePath(pts: Point[], closed = false): Path {
  if (!pts.length) return [];
  const out: Path = [{ op: "M", p: pts[0] }];
  for (let i = 1; i < pts.length; i++) out.push({ op: "L", p: pts[i] });
  if (closed) out.push({ op: "Z" });
  return out;
}

export function rectPath(r: PdfRect): Path {
  return polylinePath(
    [
      { x: r[0], y: r[1] },
      { x: r[2], y: r[1] },
      { x: r[2], y: r[3] },
      { x: r[0], y: r[3] },
    ],
    true,
  );
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): Path {
  const ox = rx * K,
    oy = ry * K;
  return [
    { op: "M", p: { x: cx + rx, y: cy } },
    { op: "C", c1: { x: cx + rx, y: cy + oy }, c2: { x: cx + ox, y: cy + ry }, p: { x: cx, y: cy + ry } },
    { op: "C", c1: { x: cx - ox, y: cy + ry }, c2: { x: cx - rx, y: cy + oy }, p: { x: cx - rx, y: cy } },
    { op: "C", c1: { x: cx - rx, y: cy - oy }, c2: { x: cx - ox, y: cy - ry }, p: { x: cx, y: cy - ry } },
    { op: "C", c1: { x: cx + ox, y: cy - ry }, c2: { x: cx + rx, y: cy - oy }, p: { x: cx + rx, y: cy } },
    { op: "Z" },
  ];
}

export function ellipseInRect(r: PdfRect, inset = 0): Path {
  return ellipsePath((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, Math.max(0, (r[2] - r[0]) / 2 - inset), Math.max(0, (r[3] - r[1]) / 2 - inset));
}

/** Catmull-Rom spline through the points, as cubic beziers (smooth ink). */
export function smoothPath(pts: Point[]): Path {
  if (pts.length < 3) return polylinePath(pts.length === 1 ? [pts[0], { x: pts[0].x + 0.01, y: pts[0].y }] : pts);
  const out: Path = [{ op: "M", p: pts[0] }];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    out.push({
      op: "C",
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      p: p2,
    });
  }
  return out;
}

/** Zigzag along the bottom edge of a quad (squiggly underline). */
export function squigglyPath(q: Quad): Path {
  const ll = { x: q[4], y: q[5] };
  const lr = { x: q[6], y: q[7] };
  const ul = { x: q[0], y: q[1] };
  const h = Math.hypot(ul.x - ll.x, ul.y - ll.y);
  const len = Math.hypot(lr.x - ll.x, lr.y - ll.y);
  if (len < 0.5) return [];
  const ux = (lr.x - ll.x) / len,
    uy = (lr.y - ll.y) / len;
  // Normal pointing "up" towards the text.
  const nx = (ul.x - ll.x) / (h || 1),
    ny = (ul.y - ll.y) / (h || 1);
  const amp = Math.max(0.8, h * 0.07);
  const step = Math.max(1.5, h * 0.18);
  const base = { x: ll.x + nx * amp, y: ll.y + ny * amp };
  const out: Path = [{ op: "M", p: base }];
  let up = true;
  for (let d = step; d <= len + 0.01; d += step) {
    const o = up ? amp : -amp;
    out.push({ op: "L", p: { x: base.x + ux * d + nx * o, y: base.y + uy * d + ny * o } });
    up = !up;
  }
  return out;
}

/** A line along a quad at fraction `t` from the bottom (0 = underline, 0.5 = strike-through). */
export function quadLine(q: Quad, t: number, widthFrac = 0): { path: Path; width: number } {
  const ll = { x: q[4], y: q[5] },
    lr = { x: q[6], y: q[7] },
    ul = { x: q[0], y: q[1] },
    ur = { x: q[2], y: q[3] };
  const a = { x: ll.x + (ul.x - ll.x) * t, y: ll.y + (ul.y - ll.y) * t };
  const b = { x: lr.x + (ur.x - lr.x) * t, y: lr.y + (ur.y - lr.y) * t };
  const h = Math.hypot(ul.x - ll.x, ul.y - ll.y);
  return { path: polylinePath([a, b]), width: Math.max(0.6, h * (widthFrac || 0.07)) };
}

export function quadPath(q: Quad): Path {
  // QuadPoints order is UL, UR, LL, LR — draw the outline as UL → UR → LR → LL.
  return polylinePath(
    [
      { x: q[0], y: q[1] },
      { x: q[2], y: q[3] },
      { x: q[6], y: q[7] },
      { x: q[4], y: q[5] },
    ],
    true,
  );
}

/**
 * Cloudy border (Acrobat "cloud" style): semicircular bumps along each edge.
 * `radius` controls bump size; the polygon is assumed closed.
 */
export function cloudPath(vertices: Point[], radius: number): Path {
  const pts = vertices.slice();
  if (pts.length < 2) return [];
  // Ensure counter-clockwise order so bumps face outward.
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
  if (area > 0) pts.reverse();
  const out: Path = [];
  let first = true;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.01) continue;
    const n = Math.max(1, Math.round(len / (radius * 1.6)));
    const seg = len / n;
    const ux = (b.x - a.x) / len,
      uy = (b.y - a.y) / len;
    // Outward normal for a CCW polygon in y-up space is (uy, -ux).
    const nx = uy,
      ny = -ux;
    for (let k = 0; k < n; k++) {
      const s = { x: a.x + ux * seg * k, y: a.y + uy * seg * k };
      const e = { x: a.x + ux * seg * (k + 1), y: a.y + uy * seg * (k + 1) };
      if (first) {
        out.push({ op: "M", p: s });
        first = false;
      }
      const bulge = seg * 0.62;
      out.push({
        op: "C",
        c1: { x: s.x + nx * bulge - ux * seg * 0.08, y: s.y + ny * bulge - uy * seg * 0.08 },
        c2: { x: e.x + nx * bulge + ux * seg * 0.08, y: e.y + ny * bulge + uy * seg * 0.08 },
        p: e,
      });
    }
  }
  out.push({ op: "Z" });
  return out;
}

export function cloudRectPath(r: PdfRect, radius: number): Path {
  const inset = radius * 0.5;
  return cloudPath(
    [
      { x: r[0] + inset, y: r[1] + inset },
      { x: r[2] - inset, y: r[1] + inset },
      { x: r[2] - inset, y: r[3] - inset },
      { x: r[0] + inset, y: r[3] - inset },
    ],
    radius,
  );
}

export interface EndingShape {
  path: Path;
  filled: boolean;
}

/** Line ending at point `tip`, pointing away from `from`. */
export function lineEnding(kind: LineEnding, tip: Point, from: Point, width: number): EndingShape | null {
  if (kind === "None") return null;
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / len,
    uy = (tip.y - from.y) / len;
  const nx = -uy,
    ny = ux;
  const size = Math.max(6, width * 4);
  const back = (d: number, side: number): Point => ({ x: tip.x - ux * d + nx * side, y: tip.y - uy * d + ny * side });
  switch (kind) {
    case "OpenArrow":
      return { path: polylinePath([back(size, size * 0.5), tip, back(size, -size * 0.5)]), filled: false };
    case "ClosedArrow":
      return { path: polylinePath([back(size, size * 0.5), tip, back(size, -size * 0.5)], true), filled: true };
    case "Circle":
      return { path: ellipsePath(tip.x, tip.y, size * 0.35, size * 0.35), filled: true };
    case "Square": {
      const s = size * 0.35;
      return { path: rectPath([tip.x - s, tip.y - s, tip.x + s, tip.y + s]), filled: true };
    }
    case "Diamond": {
      const s = size * 0.45;
      return {
        path: polylinePath([{ x: tip.x + ux * s, y: tip.y + uy * s }, { x: tip.x + nx * s, y: tip.y + ny * s }, { x: tip.x - ux * s, y: tip.y - uy * s }, { x: tip.x - nx * s, y: tip.y - ny * s }], true),
        filled: true,
      };
    }
    case "Butt":
      return { path: polylinePath([back(0, size * 0.5), back(0, -size * 0.5)]), filled: false };
    case "Slash":
      return { path: polylinePath([back(size * 0.3, size * 0.5), back(-size * 0.3, -size * 0.5)]), filled: false };
  }
  return null;
}

/** Shortens a segment end so the stroke doesn't poke through a closed arrowhead. */
export function trimForEnding(kind: LineEnding, tip: Point, from: Point, width: number): Point {
  if (kind !== "ClosedArrow") return tip;
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const d = Math.min(len, Math.max(6, width * 4) * 0.8);
  return { x: tip.x - ((tip.x - from.x) / len) * d, y: tip.y - ((tip.y - from.y) / len) * d };
}

export function toSvg(path: Path, m?: Matrix): string {
  const t = (p: Point) => (m ? apply(m, p.x, p.y) : p);
  let d = "";
  for (const s of path) {
    if (s.op === "Z") d += "Z";
    else if (s.op === "C") {
      const c1 = t(s.c1),
        c2 = t(s.c2),
        p = t(s.p);
      d += `C${r2(c1.x)} ${r2(c1.y)} ${r2(c2.x)} ${r2(c2.y)} ${r2(p.x)} ${r2(p.y)}`;
    } else {
      const p = t(s.p);
      d += `${s.op}${r2(p.x)} ${r2(p.y)}`;
    }
  }
  return d;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function toPdfOps(path: Path, m?: Matrix): string {
  const t = (p: Point) => (m ? apply(m, p.x, p.y) : p);
  const out: string[] = [];
  for (const s of path) {
    if (s.op === "Z") out.push("h");
    else if (s.op === "C") {
      const c1 = t(s.c1),
        c2 = t(s.c2),
        p = t(s.p);
      out.push(`${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(p.x)} ${fmt(p.y)} c`);
    } else {
      const p = t(s.p);
      out.push(`${fmt(p.x)} ${fmt(p.y)} ${s.op === "M" ? "m" : "l"}`);
    }
  }
  return out.join("\n");
}

/** Lines of a note icon glyph, defined in a 20x20 box (y-down), shared by SVG and PDF renderers. */
export const NOTE_ICON_SIZE = 20;
