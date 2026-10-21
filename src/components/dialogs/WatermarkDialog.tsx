import { useEffect, useState } from "react";
import { Droplet, Trash2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, NumberInput, Segmented, Slider, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, withBusy } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import { addWatermark, applyWatermarkToDoc, hasMarks, removePageMarks, type Anchor, type GraphicSource, type TextStyle, type WatermarkSpec } from "../../ops/pageMarks";
import { usePagePreview } from "./usePagePreview";
import { AnchorPicker, GraphicPicker, PageScope, PreviewPane, TextStyleFields, scopePages, type Scope } from "./markControls";
import { validatePageRanges } from "../../lib/pageRanges";

export default function WatermarkDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [kind, setKind] = useState<"text" | "file">("text");
  const [text, setText] = useState("CONFIDENTIAL");
  const [style, setStyle] = useState<TextStyle>({ family: "Helvetica", bold: true, italic: false, size: 72, color: "#c62828", opacity: 1 });
  const [file, setFile] = useState<GraphicSource>();
  const [scale, setScale] = useState(50);
  const [rotation, setRotation] = useState(45);
  const [opacity, setOpacity] = useState(25);
  const [anchor, setAnchor] = useState<Anchor>("mc");
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [behind, setBehind] = useState(false);
  const [tile, setTile] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [range, setRange] = useState("");
  const [existing, setExisting] = useState(0);
  const [replace, setReplace] = useState(true);

  useEffect(() => {
    const rt = doc && getRuntime(doc.id);
    if (rt) hasMarks(rt.bytes, ["watermark"]).then(setExisting).catch(() => {});
  }, [doc]);

  const spec = (pages: number[]): WatermarkSpec => ({ kind, text, style, file, scale: scale / 100, rotation, opacity: opacity / 100, anchor, offsetX, offsetY, behind, pages, tile, replace: existing > 0 && replace });
  const preview = usePagePreview(doc?.id ?? "", doc ? doc.view.page - 1 : 0, (d) => applyWatermarkToDoc(d, spec([0])), [kind, text, style, file, scale, rotation, opacity, anchor, offsetX, offsetY, behind, tile, replace, existing]);
  if (!doc) return null;
  const err = scope === "range" ? validatePageRanges(range, doc.pages.length) : null;

  const apply = async () => {
    if (kind === "text" && !text.trim()) return toast("Enter watermark text", "warning");
    if (kind === "file" && !file) return toast("Choose an image or PDF", "warning");
    close();
    await withBusy("Adding watermark…", () => addWatermark(doc.id, spec(scopePages(scope, range, doc.pages.length, doc.view.page))));
  };

  return (
    <Dialog
      title="Watermark"
      icon={<Droplet size={18} />}
      onClose={close}
      width={820}
      footer={
        <>
          {existing > 0 && (
            <Button
              variant="ghost"
              icon={<Trash2 size={15} />}
              style={{ marginRight: "auto" }}
              onClick={async () => {
                close();
                const n = await withBusy("Removing watermarks…", () => removePageMarks(doc.id, ["watermark"], "Remove watermarks"));
                toast(`Removed ${n ?? 0} watermark${n === 1 ? "" : "s"}`, "success");
              }}
            >
              Remove existing watermarks
            </Button>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!!err}>
            Add watermark
          </Button>
        </>
      }
    >
      <div className="split-layout">
        <div className="col" style={{ gap: 14 }}>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "text", label: "Text" },
              { value: "file", label: "Image or PDF" },
            ]}
          />
          {kind === "text" ? (
            <>
              <Field label="Text">
                <TextInput value={text} onChange={(e) => setText(e.target.value)} autoFocus />
              </Field>
              <TextStyleFields style={style} onChange={setStyle} />
            </>
          ) : (
            <>
              <GraphicPicker value={file} onChange={setFile} />
              <Field label="Size (relative to page width)">
                <Slider value={scale} min={5} max={100} format={(v) => `${v}%`} onChange={setScale} />
              </Field>
            </>
          )}
          <Field label="Rotation">
            <Slider value={rotation} min={-90} max={90} format={(v) => `${v}°`} onChange={setRotation} />
          </Field>
          <Field label="Opacity">
            <Slider value={opacity} min={5} max={100} step={5} format={(v) => `${v}%`} onChange={setOpacity} />
          </Field>
          <div className="row" style={{ alignItems: "flex-start", gap: 18 }}>
            <Field label="Position">
              <AnchorPicker value={anchor} onChange={setAnchor} />
            </Field>
            <div className="grid-2" style={{ flex: 1 }}>
              <Field label="Offset X">
                <NumberInput value={offsetX} onChange={setOffsetX} suffix="pt" />
              </Field>
              <Field label="Offset Y">
                <NumberInput value={offsetY} onChange={setOffsetY} suffix="pt" />
              </Field>
            </div>
          </div>
          <Checkbox checked={behind} onChange={setBehind} label="Place behind page content" />
          <Checkbox checked={tile} onChange={setTile} label="Repeat across the page" />
          {existing > 0 && <Checkbox checked={replace} onChange={setReplace} label="Replace existing watermarks on these pages" />}
          <PageScope count={doc.pages.length} scope={scope} setScope={setScope} range={range} setRange={setRange} error={err} current={doc.view.page} />
        </div>
        <PreviewPane url={preview.url} loading={preview.loading} />
      </div>
    </Dialog>
  );
}
