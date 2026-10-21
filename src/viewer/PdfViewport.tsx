import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFScriptingManager,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import { pdfjs, PDFJS_ASSETS } from "../lib/pdfjs";
import { getRuntime, type ViewerHandle } from "../state/runtime";
import { getDoc, setFind, setView, useApp } from "../state/store";
import { useSettings } from "../state/settings";
import { PageOverlay } from "./PageOverlay";
import { useViewerInteractions } from "./interactions";
import { clamp } from "../lib/util";

/** Scroll positions remembered across viewer re-creation (tab switches, reloads). */
const savedScroll = new Map<string, { top: number; left: number; version: number; scale: number }>();

const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6.4, 8, 10];

export function nextZoom(scale: number, dir: 1 | -1) {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > scale + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001) ?? ZOOM_STEPS[0];
}

export function PdfViewport({ docId }: { docId: string }) {
  const version = useApp((s) => s.docs[docId]?.version ?? 0);
  const pageTheme = useSettings((s) => s.pageTheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [pagesCount, setPagesCount] = useState(0);
  const [visible, setVisible] = useState<number[]>([]);
  const hosts = useRef(new Map<number, HTMLDivElement>());
  const [handle, setHandle] = useState<ViewerHandle | null>(null);
  const contrast = pageTheme === "contrast";

  useLayoutEffect(() => {
    const rt = getRuntime(docId);
    const container = containerRef.current;
    const viewerEl = viewerRef.current;
    if (!rt || !container || !viewerEl) return;
    const pdf = rt.pdf;

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: "noopener noreferrer nofollow" });
    const findController = new PDFFindController({ eventBus, linkService, updateMatchesCountOnProgress: true });
    let scripting: PDFScriptingManager | null = null;
    try {
      scripting = new PDFScriptingManager({ eventBus, sandboxBundleSrc: PDFJS_ASSETS.sandboxBundleSrc, wasmUrl: PDFJS_ASSETS.wasmUrl } as never);
    } catch (e) {
      console.warn("Form scripting unavailable", e);
    }
    const pdfViewer = new PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
      scriptingManager: scripting ?? undefined,
      annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
      imageResourcesPath: PDFJS_ASSETS.imageResourcesPath,
      enableAutoLinking: true,
      removePageBorders: false,
      supportsPinchToZoom: true,
      pageColors: contrast ? { background: "#000000", foreground: "#ffffff" } : undefined,
    });
    linkService.setViewer(pdfViewer);
    scripting?.setViewer(pdfViewer);

    const saved = savedScroll.get(docId);
    let disposed = false;

    eventBus.on("pagesinit", () => {
      if (disposed) return;
      const d = getDoc(docId);
      if (!d) return;
      pdfViewer.pagesRotation = d.view.rotation;
      pdfViewer.scrollMode = d.view.scrollMode;
      pdfViewer.spreadMode = d.view.spreadMode;
      pdfViewer.currentScaleValue = d.view.scaleValue || "auto";
      if (saved && Math.abs(saved.scale - pdfViewer.currentScale) < 0.001) {
        container.scrollTop = saved.top;
        container.scrollLeft = saved.left;
      } else if (d.view.page > 1) {
        pdfViewer.currentPageNumber = clamp(d.view.page, 1, pdfViewer.pagesCount);
      }
      setPagesCount(pdfViewer.pagesCount);
    });
    eventBus.on("pagechanging", (e: { pageNumber: number }) => setView(docId, { page: e.pageNumber }));
    eventBus.on("scalechanging", (e: { scale: number; presetValue?: string }) =>
      setView(docId, { scale: e.scale, scaleValue: e.presetValue ?? String(e.scale) }),
    );
    eventBus.on("rotationchanging", (e: { pagesRotation: number }) => setView(docId, { rotation: e.pagesRotation }));
    eventBus.on("scrollmodechanged", (e: { mode: number }) => setView(docId, { scrollMode: e.mode }));
    eventBus.on("spreadmodechanged", (e: { mode: number }) => setView(docId, { spreadMode: e.mode }));
    eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) =>
      setFind(docId, { current: e.matchesCount.current, total: e.matchesCount.total }),
    );
    eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount: { current: number; total: number } }) => {
      const status = (["found", "notfound", "wrapped", "pending"] as const)[e.state] ?? "idle";
      setFind(docId, { status, current: e.matchesCount?.current ?? 0, total: e.matchesCount?.total ?? 0 });
    });

    pdfViewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
    scripting?.setDocument(pdf).catch((e: unknown) => console.warn("scripting", e));

    const h: ViewerHandle = {
      container,
      pdfViewer,
      eventBus,
      linkService,
      findController,
      goToPage: (n) => {
        if (pdfViewer.pagesCount) pdfViewer.currentPageNumber = clamp(Math.round(n), 1, pdfViewer.pagesCount);
      },
      nextPage: () => pdfViewer.nextPage(),
      prevPage: () => pdfViewer.previousPage(),
      zoomIn: () => (pdfViewer.currentScale = nextZoom(pdfViewer.currentScale, 1)),
      zoomOut: () => (pdfViewer.currentScale = nextZoom(pdfViewer.currentScale, -1)),
      setScale: (v) => {
        if (typeof v === "number") pdfViewer.currentScale = clamp(v, 0.1, 10);
        else pdfViewer.currentScaleValue = v;
      },
      rotateView: (delta) => {
        pdfViewer.pagesRotation = (((pdfViewer.pagesRotation + delta) % 360) + 360) % 360;
      },
      setScrollMode: (m) => (pdfViewer.scrollMode = m),
      setSpreadMode: (m) => (pdfViewer.spreadMode = m),
      scrollToPoint: (pageIndex, x, y, opts) => {
        const pv = pdfViewer.getPageView(pageIndex);
        if (!pv?.div) return;
        const [vx, vy] = pv.viewport.convertToViewportPoint(x, y);
        const c = container.getBoundingClientRect();
        const r = pv.div.getBoundingClientRect();
        const left = r.left - c.left + container.scrollLeft + pv.div.clientLeft + vx;
        const top = r.top - c.top + container.scrollTop + pv.div.clientTop + vy;
        container.scrollTo({
          left: opts?.center ? left - container.clientWidth / 2 : Math.max(0, left - container.clientWidth / 3),
          top: opts?.center ? top - container.clientHeight / 2 : Math.max(0, top - 80),
          behavior: "smooth",
        });
      },
      goToDestination: (pageIndex, { left, top, zoom }) => {
        if (!pdfViewer.pagesCount) return;
        const pageNumber = clamp(pageIndex + 1, 1, pdfViewer.pagesCount);
        if (left === null && top === null && !zoom) {
          pdfViewer.currentPageNumber = pageNumber;
          return;
        }
        pdfViewer.scrollPageIntoView({ pageNumber, destArray: [null, { name: "XYZ" }, left, top, zoom ? zoom : null], allowNegativeOffset: true });
      },
      getPageDiv: (i) => (pdfViewer.getPageView(i)?.div as HTMLDivElement) ?? null,
      getVisiblePageIndexes: () => {
        const vis = (pdfViewer as unknown as { _getVisiblePages(): { views: { id: number }[] } })._getVisiblePages();
        return vis.views.map((v) => v.id - 1);
      },
      refreshOptionalContent: async () => {
        const cfg = await pdfViewer.optionalContentConfigPromise;
        if (cfg) pdfViewer.optionalContentConfigPromise = Promise.resolve(cfg);
      },
      refresh: () => pdfViewer.refresh(),
    };
    rt.viewer = h;
    setHandle(h);

    return () => {
      disposed = true;
      savedScroll.set(docId, { top: container.scrollTop, left: container.scrollLeft, version, scale: pdfViewer.currentScale });
      if (rt.viewer === h) rt.viewer = null;
      setHandle(null);
      setPagesCount(0);
      setVisible([]);
      for (const host of hosts.current.values()) host.remove();
      hosts.current.clear();
      try {
        scripting?.setDocument(null as never);
      } catch {
        /* ignore */
      }
      try {
        pdfViewer.setDocument(null);
        linkService.setDocument(null);
      } catch {
        /* ignore */
      }
    };
    // `version` changes when the document bytes are replaced.
  }, [docId, version, contrast]);

  // Track which pages are near the viewport; only those get annotation overlays.
  useEffect(() => {
    if (!handle || !pagesCount) return;
    const { pdfViewer, container } = handle;
    const visibleSet = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.pageNumber) - 1;
          if (e.isIntersecting && !visibleSet.has(idx)) {
            visibleSet.add(idx);
            changed = true;
          } else if (!e.isIntersecting && visibleSet.has(idx)) {
            visibleSet.delete(idx);
            changed = true;
          }
        }
        if (changed) setVisible([...visibleSet].sort((a, b) => a - b));
      },
      { root: container, rootMargin: "800px 400px" },
    );
    const observers: MutationObserver[] = [];
    for (let i = 0; i < pdfViewer.pagesCount; i++) {
      const div = pdfViewer.getPageView(i)?.div as HTMLDivElement | undefined;
      if (!div) continue;
      io.observe(div);
      // pdf.js clears unknown children of a page when it re-renders; put our layer back.
      const mo = new MutationObserver(() => {
        const host = hosts.current.get(i);
        if (host && host.parentNode !== div) div.appendChild(host);
      });
      mo.observe(div, { childList: true });
      observers.push(mo);
    }
    return () => {
      io.disconnect();
      observers.forEach((o) => o.disconnect());
    };
  }, [handle, pagesCount]);

  useViewerInteractions(docId, handle);

  const portals = handle
    ? visible.map((i) => {
        const div = handle.getPageDiv(i);
        if (!div) return null;
        let host = hosts.current.get(i);
        if (!host) {
          host = document.createElement("div");
          host.className = "quillmark-overlay-host";
          hosts.current.set(i, host);
        }
        if (host.parentNode !== div) div.appendChild(host);
        return createPortal(<PageOverlay docId={docId} pageIndex={i} />, host, `ov-${i}`);
      })
    : null;

  return (
    <div className={`viewer-shell page-theme-${pageTheme}`}>
      <div ref={containerRef} className="viewer-container" tabIndex={-1}>
        <div ref={viewerRef} className="pdfViewer" />
      </div>
      {portals}
    </div>
  );
}
