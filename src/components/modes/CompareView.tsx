import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Download, GitCompare, Link2, Link2Off, X } from "lucide-react";
import { useApp, toast } from "../../state/store";
import { openPdf, renderPageToCanvas, pdfjs, type PDFDocumentProxy } from "../../lib/pdfjs";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import { compareText, compareVisual, type CompareChange, type CompareResult } from "../../ops/compare";
import { Button, IconButton, Spinner } from "../ui/Button";
import { downloadBlob, escapeHtml, plural } from "../../lib/util";

type Side = "old" | "new";
type Filter = "all" | CompareChange["kind"];

const KIND_LABEL: Record<CompareChange["kind"], string> = { replace: "Replaced", insert: "Inserted", delete: "Deleted", visual: "Changed area" };

/** Lazily rendered page with change boxes. */
function ComparePage({ pdf, index, viewport, boxes, focus }: { pdf: PDFDocumentProxy; index: number; viewport: PageViewport; boxes: { id: string; kind: string; quads: number[][]; marker?: boolean }[]; focus: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      async (entries) => {
        if (!entries.some((e) => e.isIntersecting) || img) return;
        io.disconnect();
        const page = await pdf.getPage(index + 1);
        const scale = (Math.max(320, el.clientWidth) * Math.min(2, window.devicePixelRatio || 1)) / viewport.width;
        const canvas = await renderPageToCanvas(page, { scale, annotationMode: pdfjs.AnnotationMode.ENABLE });
        if (!cancelled) setImg(canvas.toDataURL("image/jpeg", 0.9));
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [pdf, index, viewport, img]);
  return (
    <div ref={host} className="compare-page" data-page={index} style={{ aspectRatio: `${viewport.width} / ${viewport.height}`, width: "100%", maxWidth: 900 }}>
      {img ? <img src={img} alt={`Page ${index + 1}`} /> : <div className="center-fill"><Spinner size="sm" /></div>}
      {boxes.map((b) =>
        b.quads.map((q, k) => {
          const pts = [0, 2, 4, 6].map((i) => viewport.convertToViewportPoint(q[i], q[i + 1]) as number[]);
          const xs = pts.map((p) => p[0]),
            ys = pts.map((p) => p[1]);
          const x0 = Math.min(...xs),
            y0 = Math.min(...ys);
          return (
            <div
              key={`${b.id}-${k}`}
              data-change={k === 0 ? b.id : undefined}
              className={`diff-box ${b.kind === "insert" ? "ins" : b.kind === "delete" ? "del" : b.kind === "visual" ? "vis" : "rep"}${b.marker ? " marker" : ""}${focus === b.id ? " is-focus" : ""}`}
              style={{ left: `${(x0 / viewport.width) * 100}%`, top: `${(y0 / viewport.height) * 100}%`, width: `${((Math.max(...xs) - x0) / viewport.width) * 100}%`, height: `${((Math.max(...ys) - y0) / viewport.height) * 100}%` }}
            />
          );
        }),
      )}
    </div>
  );
}

function ComparePane({ side, title, pdf, viewports, changes, focus, paneRef, onScroll }: { side: Side; title: string; pdf: PDFDocumentProxy; viewports: PageViewport[]; changes: CompareChange[]; focus: string | null; paneRef: React.RefObject<HTMLDivElement | null>; onScroll: () => void }) {
  const byPage = useMemo(() => {
    const m = new Map<number, { id: string; kind: string; quads: number[][]; marker?: boolean }[]>();
    for (const c of changes) for (const s of c[side]) m.set(s.page, [...(m.get(s.page) ?? []), { id: c.id, kind: c.kind, quads: s.quads, marker: s.marker }]);
    return m;
  }, [changes, side]);
  return (
    <div className="compare-pane" ref={paneRef} onScroll={onScroll}>
      <div className="compare-pane-title">
        <span className={`compare-tag compare-tag-${side}`}>{side === "old" ? "Old" : "New"}</span>
        <span className="ellipsis">{title}</span>
      </div>
      {viewports.map((vp, i) => (
        <ComparePage key={i} pdf={pdf} index={i} viewport={vp} boxes={byPage.get(i) ?? []} focus={focus} />
      ))}
    </div>
  );
}

export default function CompareView() {
  const session = useApp((s) => s.compare)!;
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 1, label: "Opening documents…" });
  const [docs, setDocs] = useState<{ old: PDFDocumentProxy; new: PDFDocumentProxy; oldVp: PageViewport[]; newVp: PageViewport[] } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [sync, setSync] = useState(true);
  const oldPane = useRef<HTMLDivElement>(null);
  const newPane = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  useEffect(() => {
    let alive = true;
    const opened: PDFDocumentProxy[] = [];
    (async () => {
      try {
        const viewports = async (pdf: PDFDocumentProxy) => Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => (await pdf.getPage(i + 1)).getViewport({ scale: 1 })));
        const [{ pdf: a }, { pdf: b }] = await Promise.all([openPdf(session.old.bytes.slice()), openPdf(session.new.bytes.slice())]);
        opened.push(a, b);
        const [oldVp, newVp] = await Promise.all([viewports(a), viewports(b)]);
        if (!alive) return;
        setDocs({ old: a, new: b, oldVp, newVp });
        const run = session.kind === "visual" ? compareVisual : compareText;
        const r = await run(session.old.bytes.slice(), session.new.bytes.slice(), (done, total, label) => alive && setProgress({ done, total, label }));
        if (alive) setResult(r);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      for (const p of opened) void p.loadingTask.destroy();
    };
  }, [session]);

  const close = () => useApp.setState({ compare: null });
  const changes = result?.changes ?? [];
  const shown = filter === "all" ? changes : changes.filter((c) => c.kind === filter);
  const counts = changes.reduce<Record<string, number>>((acc, c) => ((acc[c.kind] = (acc[c.kind] ?? 0) + 1), acc), {});

  const go = (c: CompareChange) => {
    setFocus(c.id);
    syncing.current = true;
    for (const pane of [oldPane.current, newPane.current]) pane?.querySelector(`[data-change="${c.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => (syncing.current = false), 700);
  };
  const step = (d: 1 | -1) => {
    if (!shown.length) return;
    const i = shown.findIndex((c) => c.id === focus);
    go(shown[(i + d + shown.length) % shown.length]);
  };
  const scrolled = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!sync || syncing.current || !from || !to) return;
    syncing.current = true;
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => (syncing.current = false));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useApp.getState().dialogs.length) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown" || e.key === "j") (e.preventDefault(), step(1));
      else if (e.key === "ArrowUp" || e.key === "k") (e.preventDefault(), step(-1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const report = () => {
    const rows = changes
      .map(
        (c, i) =>
          `<tr><td>${i + 1}</td><td>${KIND_LABEL[c.kind]}</td><td>${c.old.filter((s) => !s.marker).map((s) => s.page + 1).join(", ") || "–"}</td><td>${c.new.filter((s) => !s.marker).map((s) => s.page + 1).join(", ") || "–"}</td><td><del>${escapeHtml(c.oldText)}</del></td><td><ins>${escapeHtml(c.newText)}</ins></td></tr>`,
      )
      .join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Comparison report</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:32px auto;max-width:1000px;padding:0 20px;color:#1b2230}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d5dae2;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f5f8}del{background:#fde2e3}ins{background:#dcf3e6;text-decoration:none}</style></head><body><h1>Comparison report</h1><p><strong>Old:</strong> ${escapeHtml(session.old.name)}<br><strong>New:</strong> ${escapeHtml(session.new.name)}<br><strong>Date:</strong> ${new Date().toLocaleString()}</p><p>${plural(changes.length, "change")}: ${Object.entries(counts)
      .map(([k, n]) => `${n} ${KIND_LABEL[k as CompareChange["kind"]].toLowerCase()}`)
      .join(", ")}</p><table><thead><tr><th>#</th><th>Type</th><th>Old page</th><th>New page</th><th>Old text</th><th>New text</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    downloadBlob(new Blob([html], { type: "text/html" }), "comparison-report.html");
    toast("Report downloaded", "success");
  };

  return (
    <div className="compare" role="region" aria-label="Compare files">
      <div className="compare-header">
        <GitCompare size={18} />
        <strong className="ellipsis">{session.old.name}</strong>
        <span className="faint">→</span>
        <strong className="ellipsis">{session.new.name}</strong>
        <span className="compare-header-spacer" />
        {result && (
          <span className="muted compare-summary">
            {changes.length ? plural(changes.length, "difference") : "No differences found"}
          </span>
        )}
        <IconButton icon={<ArrowUp size={16} />} label="Previous change" shortcut="↑" onClick={() => step(-1)} disabled={!shown.length} />
        <IconButton icon={<ArrowDown size={16} />} label="Next change" shortcut="↓" onClick={() => step(1)} disabled={!shown.length} />
        <IconButton icon={sync ? <Link2 size={16} /> : <Link2Off size={16} />} label={sync ? "Synchronized scrolling on" : "Synchronized scrolling off"} active={sync} onClick={() => setSync(!sync)} />
        <Button size="sm" icon={<Download size={15} />} onClick={report} disabled={!result}>
          Report
        </Button>
        <IconButton icon={<X size={18} />} label="Close comparison" onClick={close} />
      </div>
      <div className="compare-body">
        {docs ? (
          <>
            <ComparePane side="old" title={session.old.name} pdf={docs.old} viewports={docs.oldVp} changes={shown} focus={focus} paneRef={oldPane} onScroll={() => scrolled(oldPane.current, newPane.current)} />
            <ComparePane side="new" title={session.new.name} pdf={docs.new} viewports={docs.newVp} changes={shown} focus={focus} paneRef={newPane} onScroll={() => scrolled(newPane.current, oldPane.current)} />
          </>
        ) : (
          <div className="center-fill" style={{ gridColumn: "1 / 3" }}>
            {error ? <span className="muted">{error}</span> : <Spinner />}
          </div>
        )}
        <aside className="compare-changes" aria-label="Changes">
          {!result && !error && (
            <div className="col" style={{ gap: 8, padding: 8 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {progress.label}
              </span>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
              </div>
            </div>
          )}
          {error && <p className="muted" style={{ padding: 8 }}>{error}</p>}
          {result && (
            <>
              {result.noText && <div className="callout" style={{ marginBottom: 8 }}>No text was found in one of the files (scanned pages?). Try the visual comparison, or run OCR first.</div>}
              <div className="compare-filters">
                {(["all", "replace", "insert", "delete", "visual"] as Filter[])
                  .filter((f) => f === "all" || counts[f])
                  .map((f) => (
                    <button key={f} type="button" className={`chip${filter === f ? " is-active" : ""}`} onClick={() => setFilter(f)}>
                      {f === "all" ? "All" : KIND_LABEL[f]} <span className="faint">{f === "all" ? changes.length : counts[f]}</span>
                    </button>
                  ))}
              </div>
              {shown.map((c, i) => (
                <button key={c.id} type="button" className={`change-item${focus === c.id ? " is-active" : ""}`} onClick={() => go(c)}>
                  <span className={`change-kind change-kind-${c.kind}`}>
                    {i + 1}. {KIND_LABEL[c.kind]}
                    <span className="faint"> · p. {(c.new.find((s) => !s.marker) ?? c.old[0])?.page + 1 || "–"}</span>
                  </span>
                  {c.kind === "visual" ? (
                    <span className="muted">Pixels differ in this area</span>
                  ) : (
                    <span>
                      {c.oldText && <del>{c.oldText.length > 160 ? c.oldText.slice(0, 160) + "…" : c.oldText}</del>}
                      {c.oldText && c.newText && " "}
                      {c.newText && <ins>{c.newText.length > 160 ? c.newText.slice(0, 160) + "…" : c.newText}</ins>}
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
