import { useEffect, useState } from "react";
import { Eye, EyeOff, Layers } from "lucide-react";
import { useApp } from "../../state/store";
import { getRuntime, getViewer } from "../../state/runtime";
import { EmptyState } from "../ui/Fields";
import { Spinner } from "../ui/Button";

interface LayerRow {
  id: string;
  name: string;
  visible: boolean;
  depth: number;
}

interface OCConfig {
  getOrder(): unknown[] | null;
  getGroup(id: string): { name: string; visible?: boolean } | null;
  getGroups(): Record<string, { name: string }> | null;
  isVisible(group: { type: string; id: string }): boolean;
  setVisibility(id: string, visible: boolean, preserveRB?: boolean): void;
  [Symbol.iterator]?: () => Iterator<[string, { name: string; visible: boolean }]>;
}

/** Optional content groups ("layers"): show/hide them in the viewer. */
export default function LayersPanel({ docId }: { docId: string }) {
  const version = useApp((s) => s.docs[docId].version);
  const [rows, setRows] = useState<LayerRow[] | null>(null);
  const [config, setConfig] = useState<OCConfig | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const v = getViewer(docId);
      const rt = getRuntime(docId);
      if (!rt) return;
      const cfg = ((v ? await v.pdfViewer.optionalContentConfigPromise : null) ?? (await rt.pdf.getOptionalContentConfig())) as unknown as OCConfig | null;
      if (!alive) return;
      if (!cfg) {
        setRows([]);
        return;
      }
      const out: LayerRow[] = [];
      const seen = new Set<string>();
      const walk = (order: unknown[], depth: number) => {
        for (const item of order) {
          if (typeof item === "string") {
            const g = cfg.getGroup(item);
            if (g && !seen.has(item)) {
              seen.add(item);
              out.push({ id: item, name: g.name || "(unnamed layer)", visible: cfg.isVisible({ type: "OCG", id: item }), depth });
            }
          } else if (item && typeof item === "object" && "order" in (item as object)) {
            walk((item as { order: unknown[] }).order, depth + 1);
          }
        }
      };
      walk(cfg.getOrder() ?? [], 0);
      const groups = cfg.getGroups() ?? {};
      for (const [id, g] of Object.entries(groups)) {
        if (!seen.has(id)) out.push({ id, name: g.name || "(unnamed layer)", visible: cfg.isVisible({ type: "OCG", id }), depth: 0 });
      }
      setConfig(cfg);
      setRows(out);
    };
    load().catch(() => setRows([]));
    return () => {
      alive = false;
    };
  }, [docId, version]);

  if (rows === null)
    return (
      <div className="center-fill">
        <Spinner />
      </div>
    );
  if (!rows.length)
    return (
      <EmptyState icon={<Layers size={22} />} title="No layers">
        This document doesn't contain optional content layers.
      </EmptyState>
    );

  const toggle = (row: LayerRow) => {
    if (!config) return;
    config.setVisibility(row.id, !row.visible);
    setRows((rs) => rs!.map((r) => (r.id === row.id ? { ...r, visible: !r.visible } : { ...r, visible: config.isVisible({ type: "OCG", id: r.id }) })));
    const v = getViewer(docId);
    if (v) v.pdfViewer.optionalContentConfigPromise = Promise.resolve(config as never);
  };

  return (
    <div className="layers-list scroll-thin">
      {rows.map((r) => (
        <button key={r.id} className="layer-row" style={{ paddingLeft: 10 + r.depth * 16 }} onClick={() => toggle(r)} aria-pressed={r.visible}>
          {r.visible ? <Eye size={15} /> : <EyeOff size={15} className="faint" />}
          <span className={r.visible ? "" : "faint"}>{r.name}</span>
        </button>
      ))}
    </div>
  );
}
