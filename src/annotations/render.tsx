import { memo, type ReactNode } from "react";
import type { Annotation, FreeTextAnnot, LineAnnot, MeasureInfo, PolyAnnot, SymbolAnnot, TextEditAnnot } from "./types";
import {
  apply,
  normalizeRotation,
  polygonArea,
  polylineLength,
  transformRect,
  type Matrix,
  type PdfRect,
  type Point,
} from "../lib/geometry";
import {
  cloudPath,
  cloudRectPath,
  ellipseInRect,
  lineEnding,
  polylinePath,
  quadLine,
  smoothPath,
  squigglyPath,
  toSvg,
  trimForEnding,
} from "./paths";
import { stampLayout, STAMP_FONT } from "./stamps";
import { CSS_FONT, stdFontName, wrapText } from "../lib/fontMetrics";

export interface RenderCtx {
  /** PDF user space → stage space. */
  m: Matrix;
  /** Total display rotation of the page (page /Rotate + view rotation). */
  rotation: number;
  /** CSS pixels per stage unit, for zoom-independent UI sizes. */
  scale: number;
  /** Workspace, used to show/hide edit-only decorations (links, fields). */
  mode?: string;
  /** Hide UI-only affordances (e.g. in thumbnails). */
  thumbnail?: boolean;
}

export interface StageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function stageBox(m: Matrix, r: PdfRect): StageBox {
  const t = transformRect(m, r);
  return { x: t[0], y: t[1], w: t[2] - t[0], h: t[3] - t[1] };
}

/** Rotation (clockwise degrees) at which text/image content of `a` is displayed. */
export function displayAngle(a: Annotation, ctx: RenderCtx): number {
  return normalizeRotation(ctx.rotation - (a.rotation ?? 0));
}

/** Upright content box inside a stage box for the given display angle. */
export function contentFrame(box: StageBox, angle: number) {
  const swap = angle === 90 || angle === 270;
  const w = swap ? box.h : box.w;
  const h = swap ? box.w : box.h;
  return {
    w,
    h,
    left: box.x + box.w / 2 - w / 2,
    top: box.y + box.h / 2 - h / 2,
    transform: angle ? `rotate(${angle}deg)` : undefined,
    svgTransform: `translate(${box.x + box.w / 2} ${box.y + box.h / 2}) rotate(${angle}) translate(${-w / 2} ${-h / 2})`,
  };
}

const UNIT_DIGITS = (m: MeasureInfo) => Math.max(0, Math.min(6, m.precision));

export function measureText(a: LineAnnot | PolyAnnot): string | null {
  const m = a.measure;
  if (!m) return null;
  if (a.kind === "line") {
    const len = Math.hypot(a.points[1].x - a.points[0].x, a.points[1].y - a.points[0].y) * m.factor;
    return `${len.toFixed(UNIT_DIGITS(m))} ${m.unit}`;
  }
  if (m.kind === "area") {
    const area = polygonArea(a.vertices) * m.factor * m.factor;
    return `${area.toFixed(UNIT_DIGITS(m))} sq ${m.unit}`;
  }
  const len = polylineLength(a.vertices, a.kind === "polygon") * m.factor;
  return `${len.toFixed(UNIT_DIGITS(m))} ${m.unit}`;
}

function centroid(pts: Point[]): Point {
  const n = pts.length || 1;
  return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
}

function MeasureLabel({ at, text, color, angleDeg = 0 }: { at: Point; text: string; color: string; angleDeg?: number }) {
  const size = 9;
  const w = text.length * size * 0.56 + 8;
  return (
    <g transform={`translate(${at.x} ${at.y}) rotate(${angleDeg})`} className="folio-measure-label">
      <rect x={-w / 2} y={-size - 6} width={w} height={size + 6} rx={3} fill="#ffffff" fillOpacity={0.92} stroke={color} strokeWidth={0.6} />
      <text x={0} y={-5.5} textAnchor="middle" fontSize={size} fontFamily={CSS_FONT.Helvetica} fill={color} fontWeight={600}>
        {text}
      </text>
    </g>
  );
}

function dash(style: string, w: number) {
  return style === "dashed" ? `${Math.max(2, w * 3)} ${Math.max(2, w * 2)}` : undefined;
}

export function symbolPaths(symbol: SymbolAnnot["symbol"], box: { x: number; y: number; w: number; h: number }): { d: string; fill: boolean }[] {
  const { x, y, w, h } = box;
  const p = (fx: number, fy: number) => `${x + w * fx} ${y + h * fy}`;
  switch (symbol) {
    case "check":
      return [{ d: `M${p(0.12, 0.55)}L${p(0.4, 0.82)}L${p(0.9, 0.18)}`, fill: false }];
    case "cross":
      return [{ d: `M${p(0.15, 0.15)}L${p(0.85, 0.85)}M${p(0.85, 0.15)}L${p(0.15, 0.85)}`, fill: false }];
    case "dot": {
      const r = Math.min(w, h) * 0.32;
      const cx = x + w / 2,
        cy = y + h / 2;
      return [{ d: `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`, fill: true }];
    }
    case "circle": {
      const rx = w / 2 - 1,
        ry = h / 2 - 1;
      const cx = x + w / 2,
        cy = y + h / 2;
      return [{ d: `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`, fill: false }];
    }
    case "line":
      return [{ d: `M${p(0, 0.5)}L${p(1, 0.5)}`, fill: false }];
    case "rectangle":
      return [{ d: `M${p(0.04, 0.04)}L${p(0.96, 0.04)}L${p(0.96, 0.96)}L${p(0.04, 0.96)}Z`, fill: false }];
  }
}

/** Speech-bubble note icon in a 20×20 box (y down). */
export function NoteIcon({ x, y, size, color }: { x: number; y: number; size: number; color: string }) {
  const s = size / 20;
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <path d="M3 2.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4.5 3.5V15.5H3a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" fill={color} stroke="#3c3c3c" strokeWidth={0.9} strokeLinejoin="round" />
      <path d="M5 6.5h10M5 9.2h10M5 11.9h6.5" stroke="#3c3c3c" strokeWidth={1} strokeLinecap="round" />
    </g>
  );
}

function svgKindProps(a: Annotation) {
  return { "data-annot-id": a.id, className: `folio-annot folio-annot-${a.kind}` };
}

/** Vector annotations rendered in the page's SVG layer. */
export const AnnotSvg = memo(function AnnotSvg({ a, ctx }: { a: Annotation; ctx: RenderCtx }): ReactNode {
  const { m } = ctx;
  switch (a.kind) {
    case "highlight":
      return (
        <g {...svgKindProps(a)} style={{ mixBlendMode: "multiply" }} opacity={a.opacity}>
          {a.quads.map((q, i) => (
            <path key={i} d={toSvg(polylinePath([{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[6], y: q[7] }, { x: q[4], y: q[5] }], true), m)} fill={a.color} />
          ))}
        </g>
      );
    case "underline":
    case "strikeout":
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          {a.quads.map((q, i) => {
            const { path, width } = quadLine(q, a.kind === "underline" ? 0.08 : 0.42);
            return <path key={i} d={toSvg(path, m)} stroke={a.color} strokeWidth={width} fill="none" />;
          })}
          {a.quads.map((q, i) => (
            <path key={`h${i}`} className="folio-hit" d={toSvg(polylinePath([{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[6], y: q[7] }, { x: q[4], y: q[5] }], true), m)} />
          ))}
        </g>
      );
    case "squiggly":
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          {a.quads.map((q, i) => (
            <path key={i} d={toSvg(squigglyPath(q), m)} stroke={a.color} strokeWidth={0.9} fill="none" strokeLinejoin="round" />
          ))}
          {a.quads.map((q, i) => (
            <path key={`h${i}`} className="folio-hit" d={toSvg(polylinePath([{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[6], y: q[7] }, { x: q[4], y: q[5] }], true), m)} />
          ))}
        </g>
      );
    case "ink":
      return (
        <g {...svgKindProps(a)} opacity={a.opacity} style={a.highlighter ? { mixBlendMode: "multiply" } : undefined}>
          {a.paths.map((p, i) => {
            const d = toSvg(smoothPath(p), m);
            return (
              <g key={i}>
                <path className="folio-hit" d={d} strokeWidth={Math.max(a.strokeWidth, 8 / ctx.scale)} />
                <path d={d} stroke={a.color} strokeWidth={a.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          })}
        </g>
      );
    case "rect":
    case "ellipse": {
      const inset = a.strokeWidth / 2;
      const r: PdfRect = [a.rect[0] + inset, a.rect[1] + inset, a.rect[2] - inset, a.rect[3] - inset];
      const d =
        a.borderStyle === "cloudy"
          ? toSvg(a.kind === "rect" ? cloudRectPath(a.rect, Math.max(4, a.strokeWidth * 3)) : cloudPath(ellipsePoints(r, 24), Math.max(4, a.strokeWidth * 3)), m)
          : a.kind === "rect"
            ? toSvg(polylinePath([{ x: r[0], y: r[1] }, { x: r[2], y: r[1] }, { x: r[2], y: r[3] }, { x: r[0], y: r[3] }], true), m)
            : toSvg(ellipseInRect(r), m);
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          <path d={d} className={a.fillColor ? undefined : "folio-hit-stroke"} fill={a.fillColor ?? "none"} stroke={a.strokeWidth > 0 ? a.color : "none"} strokeWidth={a.strokeWidth} strokeDasharray={dash(a.borderStyle, a.strokeWidth)} strokeLinejoin="round" />
        </g>
      );
    }
    case "line": {
      const [p0, p1] = a.points;
      const s0 = trimForEnding(a.startEnding, p0, p1, a.strokeWidth);
      const s1 = trimForEnding(a.endEnding, p1, p0, a.strokeWidth);
      const e0 = lineEnding(a.startEnding, p0, p1, a.strokeWidth);
      const e1 = lineEnding(a.endEnding, p1, p0, a.strokeWidth);
      const label = measureText(a);
      const sp0 = apply(m, p0.x, p0.y);
      const sp1 = apply(m, p1.x, p1.y);
      let angle = (Math.atan2(sp1.y - sp0.y, sp1.x - sp0.x) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          <path className="folio-hit" d={toSvg(polylinePath([p0, p1]), m)} strokeWidth={Math.max(a.strokeWidth, 8 / ctx.scale)} />
          <path d={toSvg(polylinePath([s0, s1]), m)} stroke={a.color} strokeWidth={a.strokeWidth} strokeDasharray={dash(a.borderStyle, a.strokeWidth)} strokeLinecap="butt" fill="none" />
          {[e0, e1].map(
            (e, i) =>
              e && (
                <path key={i} d={toSvg(e.path, m)} stroke={a.color} strokeWidth={a.strokeWidth} fill={e.filled ? (a.fillColor ?? a.color) : "none"} strokeLinejoin="miter" />
              ),
          )}
          {a.measure && (
            <>
              {/* Tick marks at both ends of a dimension line. */}
              {[p0, p1].map((p, i) => {
                const o = p === p0 ? p1 : p0;
                const tick = lineEnding("Butt", p, o, a.strokeWidth * 1.5);
                return tick && <path key={`t${i}`} d={toSvg(tick.path, m)} stroke={a.color} strokeWidth={a.strokeWidth} />;
              })}
              {label && <MeasureLabel at={{ x: (sp0.x + sp1.x) / 2, y: (sp0.y + sp1.y) / 2 }} text={label} color={a.color} angleDeg={angle} />}
            </>
          )}
        </g>
      );
    }
    case "polygon":
    case "polyline": {
      const closed = a.kind === "polygon";
      const d =
        closed && a.borderStyle === "cloudy"
          ? toSvg(cloudPath(a.vertices, Math.max(4, a.strokeWidth * 3)), m)
          : toSvg(polylinePath(a.vertices, closed), m);
      const label = measureText(a);
      const stagePts = a.vertices.map((p) => apply(m, p.x, p.y));
      const labelAt = closed ? centroid(stagePts) : stagePts[stagePts.length - 1];
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          <path className="folio-hit" d={toSvg(polylinePath(a.vertices, closed), m)} strokeWidth={Math.max(a.strokeWidth, 8 / ctx.scale)} />
          <path
            d={d}
            fill={closed && a.fillColor ? a.fillColor : "none"}
            fillOpacity={a.measure && a.fillColor ? 0.15 : 1}
            stroke={a.color}
            strokeWidth={a.strokeWidth}
            strokeDasharray={dash(a.borderStyle, a.strokeWidth)}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {label && labelAt && <MeasureLabel at={closed ? labelAt : { x: labelAt.x + 4, y: labelAt.y - 4 }} text={label} color={a.color} />}
        </g>
      );
    }
    case "stamp": {
      const box = stageBox(m, a.rect);
      const angle = displayAngle(a, ctx);
      const f = contentFrame(box, angle);
      const L = stampLayout(a.label, a.sublabel);
      const sx = f.w / L.width;
      const sy = f.h / L.height;
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          <g transform={`${f.svgTransform} scale(${sx} ${sy})`}>
            <rect x={1} y={1} width={L.width - 2} height={L.height - 2} rx={L.size * 0.35} fill="#ffffff" fillOpacity={0.55} stroke={a.color} strokeWidth={2.2} />
            <rect x={4} y={4} width={L.width - 8} height={L.height - 8} rx={L.size * 0.25} fill="none" stroke={a.color} strokeWidth={0.8} />
            <text
              x={L.width / 2}
              y={L.pad + L.size * 0.8}
              textAnchor="middle"
              fontFamily={CSS_FONT.Helvetica}
              fontWeight={700}
              fontSize={L.size}
              fill={a.color}
              textLength={L.labelW}
              lengthAdjust="spacingAndGlyphs"
            >
              {a.label}
            </text>
            {a.sublabel && (
              <text
                x={L.width / 2}
                y={L.pad + L.size * 0.95 + L.subSize * 1.15}
                textAnchor="middle"
                fontFamily={CSS_FONT.Helvetica}
                fontWeight={700}
                fontSize={L.subSize}
                fill={a.color}
                textLength={L.subW}
                lengthAdjust="spacingAndGlyphs"
              >
                {a.sublabel}
              </text>
            )}
          </g>
        </g>
      );
    }
    case "image": {
      const box = stageBox(m, a.rect);
      const angle = displayAngle(a, ctx);
      const f = contentFrame(box, angle);
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          <image href={a.src} transform={f.svgTransform} width={f.w} height={f.h} preserveAspectRatio="none" />
          <rect className="folio-hit" x={box.x} y={box.y} width={box.w} height={box.h} />
        </g>
      );
    }
    case "symbol": {
      const box = stageBox(m, a.rect);
      const angle = displayAngle(a, ctx);
      const f = contentFrame(box, angle);
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          <g transform={f.svgTransform}>
            {symbolPaths(a.symbol, { x: 0, y: 0, w: f.w, h: f.h }).map((p, i) => (
              <path key={i} d={p.d} fill={p.fill ? a.color : "none"} stroke={p.fill ? "none" : a.color} strokeWidth={a.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
            ))}
          </g>
          <rect className="folio-hit" x={box.x} y={box.y} width={box.w} height={box.h} />
        </g>
      );
    }
    case "note": {
      const box = stageBox(m, a.rect);
      const size = Math.min(box.w, box.h);
      return (
        <g {...svgKindProps(a)} opacity={a.opacity}>
          <NoteIcon x={box.x} y={box.y} size={size} color={a.color} />
          <rect className="folio-hit" x={box.x} y={box.y} width={size} height={size} />
        </g>
      );
    }
    case "redact": {
      const shapes = a.quads?.length
        ? a.quads.map((q) => toSvg(polylinePath([{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[6], y: q[7] }, { x: q[4], y: q[5] }], true), m))
        : [toSvg(polylinePath([{ x: a.rect[0], y: a.rect[1] }, { x: a.rect[2], y: a.rect[1] }, { x: a.rect[2], y: a.rect[3] }, { x: a.rect[0], y: a.rect[3] }], true), m)];
      return (
        <g {...svgKindProps(a)}>
          {shapes.map((d, i) => (
            <path key={i} d={d} className="folio-redact-mark" fill={a.fillColor} stroke="#e5383b" strokeWidth={1.2 / ctx.scale} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      );
    }
    case "link": {
      if (ctx.thumbnail) return null;
      const box = stageBox(m, a.rect);
      return (
        <g {...svgKindProps(a)}>
          <rect
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            className={`folio-link-box${ctx.mode === "edit" ? " is-editing" : ""}`}
            fill="rgba(47,91,234,0.06)"
            stroke={a.color}
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      );
    }
    case "field": {
      const box = stageBox(m, a.rect);
      if (ctx.thumbnail && ctx.mode !== "forms") return null;
      return <FieldPlaceholder a={a} box={box} ctx={ctx} />;
    }
    default:
      return null;
  }
});

function ellipsePoints(r: PdfRect, n: number): Point[] {
  const cx = (r[0] + r[2]) / 2,
    cy = (r[1] + r[3]) / 2,
    rx = (r[2] - r[0]) / 2,
    ry = (r[3] - r[1]) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: cx + rx * Math.cos((i / n) * Math.PI * 2), y: cy + ry * Math.sin((i / n) * Math.PI * 2) }));
}

function FieldPlaceholder({ a, box }: { a: Extract<Annotation, { kind: "field" }>; box: StageBox; ctx: RenderCtx }) {
  const label =
    a.fieldType === "checkbox" ? "☐" : a.fieldType === "radio" ? "◯" : a.fieldType === "signature" ? "✍ Sign" : a.fieldType === "button" ? a.caption || "Button" : a.name;
  const fs = Math.min(box.h * 0.6, 11);
  return (
    <g {...svgKindProps(a)}>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} className="folio-field-box" fill={a.fillColor ?? "rgba(47,91,234,0.08)"} stroke={a.borderColor ?? "#2f5bea"} strokeWidth={1} vectorEffect="non-scaling-stroke" rx={a.fieldType === "radio" ? Math.min(box.w, box.h) / 2 : 1.5} />
      <text x={box.x + (a.fieldType === "checkbox" || a.fieldType === "radio" ? box.w / 2 : 3)} y={box.y + box.h / 2 + fs * 0.35} fontSize={fs} fill="#2f5bea" textAnchor={a.fieldType === "checkbox" || a.fieldType === "radio" ? "middle" : "start"} fontFamily={CSS_FONT.Helvetica} style={{ pointerEvents: "none" }}>
        {label}
      </text>
    </g>
  );
}

/** Text-bearing annotations rendered as HTML (crisp text, editable). */
export function FreeTextView({ a, ctx, editing, onCommit, onCancel }: { a: FreeTextAnnot; ctx: RenderCtx; editing: boolean; onCommit?: (text: string, height: number) => void; onCancel?: () => void }) {
  const box = stageBox(ctx.m, a.rect);
  const angle = displayAngle(a, ctx);
  const f = contentFrame(box, angle);
  const fontName = stdFontName(a.fontFamily, a.bold, a.italic);
  const pad = 2 + a.borderWidth;
  const lines = editing ? null : wrapText(a.text, fontName, a.fontSize, f.w - pad * 2);
  const style: React.CSSProperties = {
    position: "absolute",
    left: f.left,
    top: f.top,
    width: f.w,
    height: f.h,
    transform: f.transform,
    fontFamily: CSS_FONT[a.fontFamily],
    fontSize: a.fontSize,
    lineHeight: 1.2,
    fontWeight: a.bold ? 700 : 400,
    fontStyle: a.italic ? "italic" : "normal",
    color: a.textColor,
    textAlign: a.align,
    background: a.fillColor ?? "transparent",
    border: a.borderColor && a.borderWidth > 0 ? `${a.borderWidth}px solid ${a.borderColor}` : undefined,
    padding: 2,
    opacity: a.opacity,
  };
  return (
    <div data-annot-id={a.id} className={`folio-annot folio-freetext${a.plain ? " is-plain" : ""}${editing ? " is-editing" : ""}`} style={style}>
      {editing ? (
        <FreeTextEditor a={a} onCommit={onCommit!} onCancel={onCancel!} />
      ) : (
        lines!.map((l, i) => (
          <div key={i} className="folio-freetext-line">
            {l || " "}
          </div>
        ))
      )}
    </div>
  );
}

function FreeTextEditor({ a, onCommit, onCancel }: { a: FreeTextAnnot; onCommit: (text: string, height: number) => void; onCancel: () => void }) {
  return (
    <div
      className="folio-freetext-editor"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      ref={(el) => {
        if (el && !el.dataset.init) {
          el.dataset.init = "1";
          el.innerText = a.text;
          requestAnimationFrame(() => {
            el.focus();
            const sel = window.getSelection();
            sel?.selectAllChildren(el);
            sel?.collapseToEnd();
          });
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        }
      }}
      onBlur={(e) => {
        const el = e.currentTarget as HTMLElement;
        const text = el.innerText.replace(/\n$/, "");
        if (text === a.text && el.scrollHeight <= el.clientHeight + 1) onCancel();
        else onCommit(text, el.scrollHeight);
      }}
    />
  );
}

/** "Edit text" replacement: covers the original block and shows the new text. */
export function TextEditView({ a, ctx }: { a: TextEditAnnot; ctx: RenderCtx }) {
  const cover = stageBox(ctx.m, a.originalRect);
  const box = stageBox(ctx.m, a.rect);
  const angle = displayAngle(a, ctx);
  const f = contentFrame(box, angle);
  const fontName = stdFontName(a.fontFamily, a.bold, a.italic);
  const lines = wrapText(a.text, fontName, a.fontSize, f.w);
  return (
    <>
      <div className="folio-textedit-cover" style={{ position: "absolute", left: cover.x - 0.5, top: cover.y - 0.5, width: cover.w + 1, height: cover.h + 1, background: a.backgroundColor }} />
      <div
        data-annot-id={a.id}
        className="folio-annot folio-textedit"
        style={{
          position: "absolute",
          left: f.left,
          top: f.top,
          width: f.w,
          minHeight: f.h,
          transform: f.transform,
          fontFamily: CSS_FONT[a.fontFamily],
          fontSize: a.fontSize,
          fontWeight: a.bold ? 700 : 400,
          fontStyle: a.italic ? "italic" : "normal",
          lineHeight: a.lineHeight,
          color: a.textColor,
          textAlign: a.align,
          whiteSpace: "pre",
        }}
      >
        {lines.map((l, i) => (
          <div key={i}>{l || " "}</div>
        ))}
      </div>
    </>
  );
}

export { STAMP_FONT };
