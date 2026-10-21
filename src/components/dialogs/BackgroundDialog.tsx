import { useEffect, useState } from "react";
import { PaintBucket, Trash2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, ColorSwatches, Field, Segmented, Slider } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, withBusy } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import { addBackground, applyBackgroundToDoc, hasMarks, removePageMarks, type BackgroundSpec, type GraphicSource } from "../../ops/pageMarks";
import { usePagePreview } from "./usePagePreview";
import { GraphicPicker, PageScope, PreviewPane, scopePages, type Scope } from "./markControls";
import { validatePageRanges } from "../../lib/pageRanges";

const BACKGROUND_COLORS = ["#fff8e1", "#fdf6e3", "#f1f8e9", "#e3f2fd", "#fce4ec", "#ede7f6", "#eceff1", "#f5f5f5", "#fffde7", "#e0f7fa"];

export default function BackgroundDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [kind, setKind] = useState<"color" | "file">("color");
  const [color, setColor] = useState(BACKGROUND_COLORS[0]);
  const [file, setFile] = useState<GraphicSource>();
  const [scale, setScale] = useState(100);
  const [opacity, setOpacity] = useState(100);
  const [scope, setScope] = useState<Scope>("all");
  const [range, setRange] = useState("");
  const [existing, setExisting] = useState(0);
  const [replace, setReplace] = useState(true);

  useEffect(() => {
    const rt = doc && getRuntime(doc.id);
    if (rt) hasMarks(rt.bytes, ["background"]).then(setExisting).catch(() => {});
  }, [doc]);

  const spec = (pages: number[]): BackgroundSpec => ({ kind, color, file, opacity: opacity / 100, scale: scale / 100, pages, replace: existing > 0 && replace });
  const preview = usePagePreview(doc?.id ?? "", doc ? doc.view.page - 1 : 0, (d) => applyBackgroundToDoc(d, spec([0])), [kind, color, file, scale, opacity, replace, existing]);
  if (!doc) return null;
  const err = scope === "range" ? validatePageRanges(range, doc.pages.length) : null;

  const apply = async () => {
    if (kind === "file" && !file) return toast("Choose an image or PDF", "warning");
    close();
    await withBusy("Adding background…", () => addBackground(doc.id, spec(scopePages(scope, range, doc.pages.length, doc.view.page))));
  };

  return (
    <Dialog
      title="Background"
      icon={<PaintBucket size={18} />}
      onClose={close}
      width={780}
      footer={
        <>
          {existing > 0 && (
            <Button
              variant="ghost"
              icon={<Trash2 size={15} />}
              style={{ marginRight: "auto" }}
              onClick={async () => {
                close();
                const n = await withBusy("Removing backgrounds…", () => removePageMarks(doc.id, ["background"], "Remove background"));
                toast(`Removed background from ${n ?? 0} page${n === 1 ? "" : "s"}`, "success");
              }}
            >
              Remove existing background
            </Button>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!!err}>
            Add background
          </Button>
        </>
      }
    >
      <div className="split-layout">
        <div className="col" style={{ gap: 14 }}>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            Backgrounds are placed behind the existing page content.
          </p>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "color", label: "Color" },
              { value: "file", label: "Image or PDF" },
            ]}
          />
          {kind === "color" ? (
            <Field label="Color">
              <ColorSwatches value={color} onChange={(c) => c && setColor(c)} colors={BACKGROUND_COLORS} size={26} />
            </Field>
          ) : (
            <>
              <GraphicPicker value={file} onChange={setFile} />
              <Field label="Size (relative to page width)">
                <Slider value={scale} min={10} max={100} format={(v) => `${v}%`} onChange={setScale} />
              </Field>
            </>
          )}
          <Field label="Opacity">
            <Slider value={opacity} min={5} max={100} step={5} format={(v) => `${v}%`} onChange={setOpacity} />
          </Field>
          {existing > 0 && <Checkbox checked={replace} onChange={setReplace} label="Replace the existing background on these pages" />}
          <PageScope count={doc.pages.length} scope={scope} setScope={setScope} range={range} setRange={setRange} error={err} current={doc.view.page} />
        </div>
        <PreviewPane url={preview.url} loading={preview.loading} />
      </div>
    </Dialog>
  );
}
