import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, ColorButton, Field, NumberInput, Select, Slider, TextArea, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getDoc } from "../../state/store";
import { updateAnnotations } from "../../state/annotActions";
import { annotLabel, type Annotation, type LineEnding, type NoteIcon, type ReviewStatus } from "../../annotations/types";
import { computeRect } from "../../annotations/geometry";

const ENDINGS: LineEnding[] = ["None", "OpenArrow", "ClosedArrow", "Circle", "Square", "Diamond", "Butt", "Slash"];
const ICONS: NoteIcon[] = ["Comment", "Note", "Help", "Insert", "Key", "NewParagraph", "Paragraph"];

export default function AnnotPropsDialog({ props, close }: DialogProps<{ docId: string; ids: string[] }>) {
  const doc = getDoc(props.docId);
  const items = (doc?.annotations ?? []).filter((a) => props.ids.includes(a.id));
  const first = items[0];
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  if (!doc || !first) return null;
  const kinds = new Set(items.map((a) => a.kind));
  const all = (pred: (a: Annotation) => boolean) => items.every(pred);
  const val = <T,>(k: string, fallback: T): T => (k in draft ? (draft[k] as T) : ((first as unknown as Record<string, T>)[k] ?? fallback));
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));

  const isText = all((a) => a.kind === "freetext");
  const hasStroke = all((a) => "strokeWidth" in a);
  const hasFill = all((a) => a.kind === "rect" || a.kind === "ellipse" || a.kind === "polygon" || a.kind === "freetext");
  const hasBorderStyle = all((a) => a.kind === "rect" || a.kind === "ellipse" || a.kind === "polygon" || a.kind === "polyline" || a.kind === "line");
  const isLine = all((a) => a.kind === "line");
  const isNote = all((a) => a.kind === "note");
  const isRedact = all((a) => a.kind === "redact");

  const apply = () => {
    const ids = new Set(props.ids);
    updateAnnotations(
      props.docId,
      (a) => {
        if (!ids.has(a.id)) return null;
        const next = { ...a, ...draft } as Annotation;
        return { ...next, rect: computeRect(next) } as Annotation;
      },
      "Edit properties",
    );
    close();
  };

  return (
    <Dialog
      title={items.length > 1 ? `${items.length} annotations` : `${annotLabel(first)} properties`}
      icon={<SlidersHorizontal size={18} />}
      onClose={close}
      width={520}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!Object.keys(draft).length}>
            Apply
          </Button>
        </>
      }
    >
      <div className="dialog-section">
        <div className="dialog-section-title">Appearance</div>
        <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
          {!isRedact && !kinds.has("image") && (
            <span className="row" style={{ gap: 6 }}>
              <span className="field-label">{isText ? "Text color" : "Color"}</span>
              <ColorButton value={val(isText ? "textColor" : "color", "#000000")} onChange={(c) => c && set(isText ? "textColor" : "color", c)} />
            </span>
          )}
          {hasFill && (
            <span className="row" style={{ gap: 6 }}>
              <span className="field-label">Fill</span>
              <ColorButton allowNone value={val<string | null>("fillColor", null)} onChange={(c) => set("fillColor", c)} />
            </span>
          )}
          {isText && (
            <span className="row" style={{ gap: 6 }}>
              <span className="field-label">Border</span>
              <ColorButton allowNone value={val<string | null>("borderColor", null)} onChange={(c) => (set("borderColor", c), set("borderWidth", c ? Math.max(1, val("borderWidth", 1)) : 0))} />
            </span>
          )}
          {isRedact && (
            <span className="row" style={{ gap: 6 }}>
              <span className="field-label">Redaction fill</span>
              <ColorButton value={val("fillColor", "#000000")} onChange={(c) => c && set("fillColor", c)} />
            </span>
          )}
        </div>
        {!isRedact && (
          <Field label="Opacity">
            <Slider value={Math.round(val("opacity", 1) * 100)} min={5} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set("opacity", v / 100)} />
          </Field>
        )}
        {hasStroke && (
          <Field label="Line thickness">
            <Slider value={val("strokeWidth", 1)} min={0.5} max={30} step={0.5} format={(v) => `${v} pt`} onChange={(v) => set("strokeWidth", v)} />
          </Field>
        )}
        {hasBorderStyle && (
          <Field label="Line style">
            <Select
              value={val("borderStyle", "solid")}
              onChange={(e) => set("borderStyle", e.target.value)}
              options={[
                { value: "solid", label: "Solid" },
                { value: "dashed", label: "Dashed" },
                ...(isLine || kinds.has("polyline") ? [] : [{ value: "cloudy", label: "Cloudy" }]),
              ]}
            />
          </Field>
        )}
        {isLine && (
          <div className="grid-2">
            <Field label="Start">
              <Select value={val("startEnding", "None")} onChange={(e) => set("startEnding", e.target.value)} options={ENDINGS.map((v) => ({ value: v, label: v }))} />
            </Field>
            <Field label="End">
              <Select value={val("endEnding", "None")} onChange={(e) => set("endEnding", e.target.value)} options={ENDINGS.map((v) => ({ value: v, label: v }))} />
            </Field>
          </div>
        )}
        {isNote && (
          <Field label="Icon">
            <Select value={val("icon", "Comment")} onChange={(e) => set("icon", e.target.value as NoteIcon)} options={ICONS.map((v) => ({ value: v, label: v }))} />
          </Field>
        )}
        {isText && (
          <div className="grid-3">
            <Field label="Font">
              <Select
                value={val("fontFamily", "Helvetica")}
                onChange={(e) => set("fontFamily", e.target.value)}
                options={[
                  { value: "Helvetica", label: "Sans (Helvetica)" },
                  { value: "Times", label: "Serif (Times)" },
                  { value: "Courier", label: "Mono (Courier)" },
                ]}
              />
            </Field>
            <Field label="Size">
              <NumberInput value={val("fontSize", 12)} min={4} max={200} suffix="pt" onChange={(v) => set("fontSize", v)} />
            </Field>
            <Field label="Align">
              <Select value={val("align", "left")} onChange={(e) => set("align", e.target.value)} options={["left", "center", "right"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
            </Field>
          </div>
        )}
        {isRedact && (
          <Field label="Overlay text" hint="Printed on top of the redaction box, e.g. “REDACTED”.">
            <TextInput value={val("overlayText", "")} onChange={(e) => set("overlayText", e.target.value)} />
          </Field>
        )}
      </div>
      <div className="dialog-section">
        <div className="dialog-section-title">General</div>
        <div className="grid-2">
          <Field label="Author">
            <TextInput value={val("author", "")} onChange={(e) => set("author", e.target.value)} />
          </Field>
          <Field label="Subject">
            <TextInput value={val("subject", "") ?? ""} onChange={(e) => set("subject", e.target.value)} />
          </Field>
        </div>
        {items.length === 1 && !isText && (
          <Field label="Comment">
            <TextArea value={val("contents", "")} onChange={(e) => set("contents", e.target.value)} />
          </Field>
        )}
        <Field label="Review status">
          <Select
            value={val<ReviewStatus>("status", "None")}
            onChange={(e) => set("status", e.target.value)}
            options={["None", "Accepted", "Rejected", "Cancelled", "Completed"].map((v) => ({ value: v, label: v === "None" ? "No status" : v }))}
          />
        </Field>
        <Checkbox checked={!!val("locked", false)} onChange={(v) => set("locked", v)} label="Locked" hint="Prevents moving, resizing and deleting." />
        {!isRedact && <Checkbox checked={!!val("flatten", false)} onChange={(v) => set("flatten", v)} label="Flatten into the page when saving" />}
      </div>
    </Dialog>
  );
}
