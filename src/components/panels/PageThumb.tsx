import { memo, useEffect, useMemo, useRef, useState } from "react";
import { getRuntime } from "../../state/runtime";
import { useApp } from "../../state/store";
import { renderThumbnail } from "../../viewer/thumbnails";
import { stageTransform } from "../../lib/geometry";
import { AnnotSvg, contentFrame, displayAngle, stageBox, type RenderCtx } from "../../annotations/render";
import type { Annotation } from "../../annotations/types";
import { CSS_FONT, stdFontName, wrapText } from "../../lib/fontMetrics";

/** Annotations drawn as SVG on top of a page image (thumbnails, previews). */
export function AnnotationsSvg({ annots, view, rotation, width }: { annots: Annotation[]; view: number[]; rotation: number; width: number }) {
  const geo = useMemo(() => stageTransform(view, rotation), [view, rotation]);
  const ctx: RenderCtx = { m: geo.m, rotation, scale: width / geo.width, thumbnail: true };
  return (
    <svg className="thumb-annots" viewBox={`0 0 ${geo.width} ${geo.height}`} preserveAspectRatio="none">
      {annots.map((a) => {
        if (a.kind === "freetext") {
          const box = stageBox(geo.m, a.rect);
          const f = contentFrame(box, displayAngle(a, ctx));
          const lines = wrapText(a.text, stdFontName(a.fontFamily, a.bold, a.italic), a.fontSize, f.w - 4);
          return (
            <g key={a.id} transform={f.svgTransform} opacity={a.opacity}>
              <rect width={f.w} height={f.h} fill={a.fillColor ?? "none"} stroke={a.borderColor ?? "none"} strokeWidth={a.borderWidth} />
              {lines.map((l, i) => (
                <text key={i} x={2} y={2 + a.fontSize * (i + 0.9) * 1.2} fontSize={a.fontSize} fontFamily={CSS_FONT[a.fontFamily]} fill={a.textColor}>
                  {l}
                </text>
              ))}
            </g>
          );
        }
        if (a.kind === "textedit") {
          const cover = stageBox(geo.m, a.originalRect);
          return <rect key={a.id} x={cover.x} y={cover.y} width={cover.w} height={cover.h} fill={a.backgroundColor} />;
        }
        return <AnnotSvg key={a.id} a={a} ctx={ctx} />;
      })}
    </svg>
  );
}

export const PageThumb = memo(function PageThumb({ docId, pageIndex, width, extraRotation = 0, showAnnots = true }: { docId: string; pageIndex: number; width: number; extraRotation?: number; showAnnots?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const version = useApp((s) => s.docs[docId]?.version);
  const page = useApp((s) => s.docs[docId]?.pages[pageIndex]);
  const all = useApp((s) => s.docs[docId]?.annotations);
  const annots = useMemo(() => (showAnnots && page ? (all ?? []).filter((a) => a.pageId === page.id) : []), [all, page, showAnnots]);
  const rotation = ((page?.rotate ?? 0) + extraRotation) % 360;
  const geo = useMemo(() => (page ? stageTransform(page.view, rotation) : null), [page, rotation]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const rt = getRuntime(docId);
    if (!rt) return;
    let alive = true;
    renderThumbnail(rt.pdf, pageIndex, width, extraRotation)
      .then((u) => alive && setSrc(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, docId, pageIndex, width, version, extraRotation]);

  const h = geo ? (width * geo.height) / geo.width : width * 1.3;
  return (
    <div ref={ref} className="page-thumb" style={{ width, height: h }}>
      {src ? <img src={src} alt={`Page ${pageIndex + 1}`} draggable={false} /> : <div className="page-thumb-ph" />}
      {page && annots.length > 0 && <AnnotationsSvg annots={annots} view={page.view} rotation={rotation} width={width} />}
    </div>
  );
});
