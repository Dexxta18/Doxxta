import { useState } from "react";
import { FileArchive } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, Radio, Slider } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, useApp } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import { applyDocumentChange, commitForms } from "../../core/document";
import { errorMessage, formatBytes, plural } from "../../lib/util";
import { COMPRESS_PRESETS as PRESETS, compressBytes, type CompressOptions } from "../../ops/compress";

export default function CompressDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [preset, setPreset] = useState("balanced");
  const [custom, setCustom] = useState<CompressOptions>(PRESETS[1].options);
  if (!doc) return null;
  const opts = preset === "custom" ? custom : PRESETS.find((p) => p.id === preset)!.options;
  const current = getRuntime(doc.id)?.bytes.length ?? doc.fileSize;

  const run = async () => {
    close();
    const set = (message: string, progress?: number) => useApp.setState({ busy: { message, progress } });
    set("Analyzing images…", 0);
    try {
      let report: Awaited<ReturnType<typeof compressBytes>>["report"] | null = null;
      await applyDocumentChange(doc.id, "Compress", async ({ pageIds }) => {
        const bytes = await commitForms(doc.id);
        const r = await compressBytes(bytes, opts, (done, total) => set(`Compressing images… ${done}/${total}`, total ? done / total : undefined));
        report = r.report;
        return { bytes: r.bytes, pageIds };
      });
      const r = report as Awaited<ReturnType<typeof compressBytes>>["report"] | null;
      if (!r) return;
      const saved = r.before - r.after;
      if (saved <= 0) toast("This document is already well optimized — no further savings with these settings.", "info");
      else
        toast(
          `Reduced from ${formatBytes(r.before)} to ${formatBytes(r.after)} (−${((saved / r.before) * 100).toFixed(saved / r.before > 0.995 ? 1 : 0)}%)${r.images ? `, ${plural(r.images, "image")} optimized` : ""}. Save to keep it.`,
          "success",
          { timeout: 8000 },
        );
    } catch (e) {
      toast(`Compression failed: ${errorMessage(e)}`, "error");
    } finally {
      useApp.setState({ busy: null });
    }
  };

  return (
    <Dialog
      title="Reduce file size"
      icon={<FileArchive size={18} />}
      onClose={close}
      width={520}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={run}>
            Compress
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Current size: <strong>{formatBytes(current)}</strong>. Images are downsampled to the resolution they're shown at and recompressed; duplicate data is merged.
        </p>
        {PRESETS.map((p) => (
          <Radio key={p.id} value={p.id} current={preset} onChange={setPreset} label={p.label} hint={p.hint} />
        ))}
        <Radio value="custom" current={preset} onChange={setPreset} label="Custom" />
        {preset === "custom" && (
          <div className="col" style={{ gap: 10, paddingLeft: 26 }}>
            <Field label="Downsample images above">
              <Slider value={custom.targetDpi} min={72} max={300} step={6} format={(v) => `${v} ppi`} onChange={(v) => setCustom({ ...custom, targetDpi: v })} />
            </Field>
            <Field label="Image quality">
              <Slider value={Math.round(custom.quality * 100)} min={30} max={95} step={5} format={(v) => `${v}%`} onChange={(v) => setCustom({ ...custom, quality: v / 100 })} />
            </Field>
            <Checkbox checked={custom.recompress} onChange={(v) => setCustom({ ...custom, recompress: v })} label="Recompress large photos even when not downsampled" />
            <Checkbox checked={custom.removeMetadata} onChange={(v) => setCustom({ ...custom, removeMetadata: v })} label="Remove metadata" />
          </div>
        )}
      </div>
    </Dialog>
  );
}
