import { useState } from "react";
import { Ruler } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, NumberInput, Select } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast } from "../../state/store";
import { measureFactor, measureScaleLabel, useSettings, type MeasureScale } from "../../state/settings";
import { updateAnnotations } from "../../state/annotActions";
import type { Annotation, LineAnnot } from "../../annotations/types";

const DOC_UNITS = ["pt", "in", "mm", "cm"] as const;
const REAL_UNITS = ["pt", "in", "ft", "yd", "mi", "mm", "cm", "m", "km"];

const PRESETS: { label: string; scale: Omit<MeasureScale, "precision"> }[] = [
  { label: "1:1 (actual size, inches)", scale: { docValue: 1, docUnit: "in", realValue: 1, realUnit: "in" } },
  { label: "1:1 (actual size, millimeters)", scale: { docValue: 1, docUnit: "mm", realValue: 1, realUnit: "mm" } },
  { label: '1/4" = 1′ (architectural)', scale: { docValue: 0.25, docUnit: "in", realValue: 1, realUnit: "ft" } },
  { label: '1/8" = 1′ (architectural)', scale: { docValue: 0.125, docUnit: "in", realValue: 1, realUnit: "ft" } },
  { label: '1" = 10′ (engineering)', scale: { docValue: 1, docUnit: "in", realValue: 10, realUnit: "ft" } },
  { label: '1" = 50′ (engineering)', scale: { docValue: 1, docUnit: "in", realValue: 50, realUnit: "ft" } },
  { label: "1:50", scale: { docValue: 1, docUnit: "cm", realValue: 0.5, realUnit: "m" } },
  { label: "1:100", scale: { docValue: 1, docUnit: "cm", realValue: 1, realUnit: "m" } },
  { label: "1:1000", scale: { docValue: 1, docUnit: "mm", realValue: 1, realUnit: "m" } },
];

const isMeasure = (a: Annotation) => (a.kind === "line" || a.kind === "polyline" || a.kind === "polygon") && !!a.measure;

export default function MeasureScaleDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [scale, setScale] = useState<MeasureScale>(useSettings.getState().measureScale);
  const [applyExisting, setApplyExisting] = useState(false);
  const selected = doc?.annotations.find((a): a is LineAnnot => a.kind === "line" && !!a.measure && doc.selection.includes(a.id));
  const [known, setKnown] = useState(0);
  const [knownUnit, setKnownUnit] = useState(scale.realUnit);
  const existing = doc?.annotations.filter(isMeasure) ?? [];
  const set = (patch: Partial<MeasureScale>) => setScale({ ...scale, ...patch });
  const valid = scale.docValue > 0 && scale.realValue > 0;

  const calibrate = () => {
    if (!selected || known <= 0) return;
    const lengthPt = Math.hypot(selected.points[1].x - selected.points[0].x, selected.points[1].y - selected.points[0].y);
    if (lengthPt < 1) return;
    // The selected line, in inches on the page, equals `known` real units.
    setScale({ ...scale, docValue: 1, docUnit: "in", realValue: +((known * 72) / lengthPt).toPrecision(6), realUnit: knownUnit });
    toast("Scale calibrated from the selected measurement", "success");
  };

  const apply = () => {
    if (!valid) return;
    useSettings.getState().set({ measureScale: scale });
    if (doc && applyExisting && existing.length) {
      const info = { factor: measureFactor(scale), unit: scale.realUnit, scaleLabel: measureScaleLabel(scale), precision: scale.precision };
      updateAnnotations(doc.id, (a) => (isMeasure(a) ? ({ ...a, measure: { ...(a as LineAnnot).measure!, ...info } } as Annotation) : null), "Change measurement scale");
    }
    close();
    toast(`Scale set to ${measureScaleLabel(scale)}`, "success");
  };

  return (
    <Dialog
      title="Measurement scale"
      icon={<Ruler size={18} />}
      onClose={close}
      width={520}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!valid}>
            Set scale
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <Field label="Preset">
          <Select
            value=""
            onChange={(e) => {
              const p = PRESETS[Number(e.target.value)];
              if (p) setScale({ ...p.scale, precision: scale.precision });
            }}
            options={[{ value: "", label: "Choose a common scale…" }, ...PRESETS.map((p, i) => ({ value: String(i), label: p.label }))]}
          />
        </Field>
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="On the page">
            <NumberInput value={scale.docValue} min={0} step={0.125} onChange={(v) => set({ docValue: v })} />
          </Field>
          <Field label=" ">
            <Select style={{ width: 80 }} value={scale.docUnit} onChange={(e) => set({ docUnit: e.target.value as MeasureScale["docUnit"] })} options={DOC_UNITS.map((u) => ({ value: u, label: u }))} />
          </Field>
          <span style={{ paddingBottom: 9 }}>=</span>
          <Field label="In the real world">
            <NumberInput value={scale.realValue} min={0} step={1} onChange={(v) => set({ realValue: v })} />
          </Field>
          <Field label=" ">
            <Select style={{ width: 80 }} value={scale.realUnit} onChange={(e) => set({ realUnit: e.target.value })} options={REAL_UNITS.map((u) => ({ value: u, label: u }))} />
          </Field>
        </div>
        <Field label="Precision">
          <Select
            value={String(scale.precision)}
            onChange={(e) => set({ precision: Number(e.target.value) })}
            options={[0, 1, 2, 3, 4].map((p) => ({ value: String(p), label: p ? `0.${"0".repeat(p - 1)}1` : "1" }))}
          />
        </Field>
        <div className="dialog-section">
          <div className="dialog-section-title">Calibrate</div>
          {selected ? (
            <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <Field label="The selected line is really">
                <NumberInput value={known} min={0} step={0.1} onChange={setKnown} />
              </Field>
              <Field label=" ">
                <Select style={{ width: 80 }} value={knownUnit} onChange={(e) => setKnownUnit(e.target.value)} options={REAL_UNITS.map((u) => ({ value: u, label: u }))} />
              </Field>
              <Button onClick={calibrate} disabled={known <= 0} style={{ marginBottom: 1 }}>
                Calibrate
              </Button>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              To calibrate from the drawing, measure a distance whose real length you know, select it, and open this dialog again.
            </p>
          )}
        </div>
        {existing.length > 0 && <Checkbox checked={applyExisting} onChange={setApplyExisting} label={`Also update the ${existing.length} existing measurement${existing.length === 1 ? "" : "s"} in this document`} />}
      </div>
    </Dialog>
  );
}
