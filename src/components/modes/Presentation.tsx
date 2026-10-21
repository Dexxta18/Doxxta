import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { getActiveDoc, useApp } from "../../state/store";
import { getRuntime, getViewer } from "../../state/runtime";
import { openPdf, pdfjs, type PDFDocumentProxy } from "../../lib/pdfjs";
import { stopPresentation } from "./presentationMode";
import { Spinner } from "../ui/Button";

/** Full-screen slideshow of the active document. */
export default function Presentation() {
  const docId = useRef(getActiveDoc()?.id ?? null).current;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(() => (getActiveDoc()?.view.page ?? 1) - 1);
  const [blank, setBlank] = useState<null | "black" | "white">(null);
  const [cursor, setCursor] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const typed = useRef("");
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const count = pdf?.numPages ?? 0;

  // Comments, signatures and other additions are shown as in the viewer.
  useEffect(() => {
    if (!docId) return;
    let owned: PDFDocumentProxy | null = null;
    let alive = true;
    (async () => {
      const doc = useApp.getState().docs[docId];
      const rt = getRuntime(docId);
      if (!doc || !rt) return;
      const extra = doc.annotations.some((a) => a.kind !== "link");
      if (!extra) return setPdf(rt.pdf);
      const { buildPdf } = await import("../../core/save");
      const { pdf: built } = await openPdf(await buildPdf(docId, { security: "none" }));
      owned = built;
      if (alive) setPdf(built);
    })().catch(() => alive && setPdf(getRuntime(docId)?.pdf ?? null));
    return () => {
      alive = false;
      if (owned) void owned.loadingTask.destroy();
    };
  }, [docId]);

  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    let cancelled = false;
    (async () => {
      const p = await pdf.getPage(page + 1);
      if (cancelled) return;
      const vp1 = p.getViewport({ scale: 1 });
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const scale = Math.min(window.innerWidth / vp1.width, window.innerHeight / vp1.height);
      const vp = p.getViewport({ scale: scale * dpr });
      const c = canvas.current!;
      // Render offscreen, then swap, so slides don't flash.
      const off = document.createElement("canvas");
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      task = p.render({ canvas: off, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE, background: "#ffffff" });
      await task.promise;
      if (cancelled) return;
      c.width = off.width;
      c.height = off.height;
      c.style.width = `${off.width / dpr}px`;
      c.style.height = `${off.height / dpr}px`;
      c.getContext("2d")!.drawImage(off, 0, 0);
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page]);

  const go = useCallback((n: number) => setPage((p) => Math.max(0, Math.min(count - 1, typeof n === "number" ? n : p))), [count]);
  const next = useCallback(() => setPage((p) => Math.min(count - 1, p + 1)), [count]);
  const prev = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
  const exit = useCallback(() => {
    if (docId) getViewer(docId)?.goToPage(page + 1);
    stopPresentation();
  }, [docId, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (blank && e.key !== "Escape") {
        setBlank(null);
        e.preventDefault();
        return;
      }
      if (/^\d$/.test(e.key)) {
        typed.current += e.key;
        return;
      }
      const k = e.key;
      if (k === "Enter" && typed.current) {
        go(Number(typed.current) - 1);
        typed.current = "";
      } else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(k)) next();
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(k)) prev();
      else if (k === "Home") go(0);
      else if (k === "End") go(count - 1);
      else if (k === "b" || k === "B" || k === ".") setBlank("black");
      else if (k === "w" || k === "W" || k === ",") setBlank("white");
      else if (k === "Escape") exit();
      else return;
      typed.current = "";
      e.preventDefault();
    };
    // Capture phase, so the app's own shortcuts don't also react.
    window.addEventListener("keydown", onKey, true);
    const onFs = () => {
      if (!document.fullscreenElement) exit();
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, [blank, count, exit, go, next, prev]);

  const wake = () => {
    setCursor(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setCursor(false), 2000);
  };
  useEffect(() => {
    wake();
    return () => clearTimeout(hideTimer.current);
  }, []);

  const touchX = useRef<number | null>(null);

  return (
    <div
      className={`presentation${cursor ? " show-cursor" : ""}`}
      style={blank ? { background: blank === "black" ? "#000" : "#fff" } : undefined}
      onMouseMove={wake}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(".presentation-hud")) return;
        if (blank) setBlank(null);
        else next();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        prev();
      }}
      onWheel={(e) => (e.deltaY > 0 ? next() : e.deltaY < 0 ? prev() : undefined)}
      onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const x0 = touchX.current;
        const x1 = e.changedTouches[0]?.clientX;
        if (x0 === null || x1 === undefined || Math.abs(x1 - x0) < 40) return;
        if (x1 < x0) next();
        else prev();
      }}
      role="dialog"
      aria-label="Presentation"
    >
      {pdf ? <canvas ref={canvas} style={{ visibility: blank ? "hidden" : "visible" }} /> : <Spinner />}
      <div className="presentation-hud">
        <button aria-label="Previous page" onClick={prev}>
          <ChevronLeft size={18} />
        </button>
        <span>
          {page + 1} / {count || "…"}
        </span>
        <button aria-label="Next page" onClick={next}>
          <ChevronRight size={18} />
        </button>
        <button aria-label="Exit presentation" onClick={exit}>
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
