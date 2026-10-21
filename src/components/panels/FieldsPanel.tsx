import { useEffect, useMemo, useState } from "react";
import { FormInput, Trash2, Plus, X } from "lucide-react";
import { useApp, updateDoc } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import type { FieldAnnot } from "../../annotations/types";
import { deleteAnnotations, updateAnnotation } from "../../state/annotActions";
import { Checkbox, EmptyState, Field, NumberInput, Select, TextInput, ColorButton } from "../ui/Fields";
import { scrollToAnnotation } from "./CommentsPanel";

interface ExistingField {
  name: string;
  type: string;
  page: number;
}

export default function FieldsPanel({ docId }: { docId: string }) {
  const annotations = useApp((s) => s.docs[docId].annotations);
  const pages = useApp((s) => s.docs[docId].pages);
  const selection = useApp((s) => s.docs[docId].selection);
  const version = useApp((s) => s.docs[docId].version);
  const fields = useMemo(() => annotations.filter((a): a is FieldAnnot => a.kind === "field"), [annotations]);
  const [existing, setExisting] = useState<ExistingField[]>([]);
  const selected = fields.find((f) => selection.includes(f.id));

  useEffect(() => {
    const rt = getRuntime(docId);
    if (!rt) return;
    rt.pdf
      .getFieldObjects()
      .then((objs) => {
        const out: ExistingField[] = [];
        for (const [name, arr] of objs ?? []) {
          const f = (arr as { type: string; page: number }[])?.[0];
          if (f) out.push({ name, type: f.type || "field", page: f.page ?? -1 });
        }
        setExisting(out);
      })
      .catch(() => setExisting([]));
  }, [docId, version]);

  const pageIndex = (pageId: string) => pages.findIndex((p) => p.id === pageId);

  return (
    <div className="fields-panel scroll-thin">
      {selected ? (
        <FieldProps docId={docId} f={selected} allNames={fields.filter((x) => x.id !== selected.id).map((x) => x.name)} />
      ) : (
        <div className="callout callout-info" style={{ margin: 10 }}>
          <FormInput size={16} />
          <span>Pick a field tool in the toolbar and click or drag on the page. Select a field to edit its properties.</span>
        </div>
      )}
      <div className="comments-page">New fields ({fields.length})</div>
      {fields.length === 0 && <div className="faint" style={{ padding: "4px 12px 10px", fontSize: 12 }}>None yet.</div>}
      {fields.map((f) => (
        <button
          key={f.id}
          className={`field-row${selection.includes(f.id) ? " is-selected" : ""}`}
          onClick={() => {
            updateDoc(docId, { selection: [f.id] });
            scrollToAnnotation(docId, f, pageIndex(f.pageId));
          }}
        >
          <span className="badge">{f.fieldType}</span>
          <span className="ellipsis">{f.name}</span>
          <span className="spacer" />
          <span className="faint">p.{pageIndex(f.pageId) + 1}</span>
        </button>
      ))}
      <div className="comments-page">Existing fields ({existing.length})</div>
      {existing.length === 0 && <div className="faint" style={{ padding: "4px 12px 10px", fontSize: 12 }}>This document has no form fields.</div>}
      {existing.map((f) => (
        <div key={f.name} className="field-row is-static">
          <span className="badge">{f.type}</span>
          <span className="ellipsis" title={f.name}>
            {f.name}
          </span>
          <span className="spacer" />
          {f.page >= 0 && <span className="faint">p.{f.page + 1}</span>}
        </div>
      ))}
      {existing.length > 0 && <EmptyState title="">Existing fields can be filled in directly on the page.</EmptyState>}
    </div>
  );
}

function FieldProps({ docId, f, allNames }: { docId: string; f: FieldAnnot; allNames: string[] }) {
  const set = (patch: Partial<FieldAnnot>, key: string) => updateAnnotation(docId, f.id, patch as never, "Edit field", `field-${f.id}-${key}`);
  const [newOption, setNewOption] = useState("");
  const dup = f.fieldType !== "radio" && allNames.includes(f.name);
  return (
    <div className="field-props">
      <div className="row">
        <strong style={{ textTransform: "capitalize" }}>{f.fieldType} field</strong>
        <span className="spacer" />
        <button className="icon-btn icon-btn-sm" aria-label="Delete field" data-tip="Delete field" onClick={() => deleteAnnotations(docId, [f.id], "Delete field")}>
          <Trash2 size={15} />
        </button>
      </div>
      <Field label={f.fieldType === "radio" ? "Group name" : "Name"} error={dup ? "Another field already uses this name" : null} hint={f.fieldType === "radio" ? "Radio buttons with the same group name are mutually exclusive" : undefined}>
        <TextInput value={f.name} onChange={(e) => set({ name: e.target.value.replace(/[.]/g, "_") }, "name")} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      {f.fieldType === "radio" && (
        <Field label="Button value">
          <TextInput value={f.exportValue} onChange={(e) => set({ exportValue: e.target.value }, "exp")} onKeyDown={(e) => e.stopPropagation()} />
        </Field>
      )}
      <Field label="Tooltip">
        <TextInput value={f.tooltip} onChange={(e) => set({ tooltip: e.target.value }, "tip")} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      {(f.fieldType === "text" || f.fieldType === "date" || f.fieldType === "dropdown") && (
        <Field label="Default value">
          <TextInput value={f.defaultValue} onChange={(e) => set({ defaultValue: e.target.value }, "def")} onKeyDown={(e) => e.stopPropagation()} />
        </Field>
      )}
      {f.fieldType === "date" && (
        <Field label="Date format">
          <Select value={f.dateFormat} onChange={(e) => set({ dateFormat: e.target.value }, "df")} options={["mm/dd/yyyy", "dd/mm/yyyy", "yyyy-mm-dd", "d mmm yyyy", "mmmm d, yyyy"].map((v) => ({ value: v, label: v }))} />
        </Field>
      )}
      {(f.fieldType === "dropdown" || f.fieldType === "listbox") && (
        <Field label="Options">
          <div className="options-list">
            {f.options.map((o, i) => (
              <div key={i} className="option-row">
                <TextInput value={o} onChange={(e) => set({ options: f.options.map((x, j) => (j === i ? e.target.value : x)) }, `opt${i}`)} onKeyDown={(e) => e.stopPropagation()} />
                <button className="icon-btn icon-btn-sm" aria-label="Remove option" onClick={() => set({ options: f.options.filter((_, j) => j !== i) }, "optdel")}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <form
              className="option-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newOption.trim()) return;
                set({ options: [...f.options, newOption.trim()] }, "optadd");
                setNewOption("");
              }}
            >
              <TextInput placeholder="Add option" value={newOption} onChange={(e) => setNewOption(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <button type="submit" className="icon-btn icon-btn-sm" aria-label="Add option">
                <Plus size={14} />
              </button>
            </form>
          </div>
        </Field>
      )}
      {f.fieldType === "button" && (
        <>
          <Field label="Caption">
            <TextInput value={f.caption} onChange={(e) => set({ caption: e.target.value }, "cap")} onKeyDown={(e) => e.stopPropagation()} />
          </Field>
          <Field label="When clicked">
            <Select
              value={f.action}
              onChange={(e) => set({ action: e.target.value as FieldAnnot["action"] }, "act")}
              options={[
                { value: "none", label: "Do nothing" },
                { value: "reset", label: "Reset form" },
                { value: "print", label: "Print document" },
                { value: "url", label: "Open a web link" },
              ]}
            />
          </Field>
          {f.action === "url" && (
            <Field label="Link">
              <TextInput value={f.actionUrl} placeholder="https://" onChange={(e) => set({ actionUrl: e.target.value }, "url")} onKeyDown={(e) => e.stopPropagation()} />
            </Field>
          )}
        </>
      )}
      {(f.fieldType === "text" || f.fieldType === "date" || f.fieldType === "dropdown" || f.fieldType === "listbox") && (
        <div className="grid-2">
          <Field label="Font size" hint="0 = auto">
            <NumberInput value={f.fontSize} min={0} max={72} onChange={(v) => set({ fontSize: v }, "fs")} />
          </Field>
          {f.fieldType === "text" && (
            <Field label="Max characters" hint="0 = unlimited">
              <NumberInput value={f.maxLength} min={0} max={10000} onChange={(v) => set({ maxLength: v }, "max")} />
            </Field>
          )}
        </div>
      )}
      <div className="row" style={{ gap: 14 }}>
        <span className="field-label">Border</span>
        <ColorButton label="Border color" allowNone value={f.borderColor} onChange={(c) => set({ borderColor: c }, "bc")} />
        <span className="field-label">Fill</span>
        <ColorButton label="Fill color" allowNone value={f.fillColor} onChange={(c) => set({ fillColor: c }, "fc")} />
        <span className="field-label">Text</span>
        <ColorButton label="Text color" value={f.textColor} onChange={(c) => c && set({ textColor: c }, "tc")} />
      </div>
      <Checkbox checked={f.required} onChange={(v) => set({ required: v }, "req")} label="Required" />
      <Checkbox checked={f.readOnly} onChange={(v) => set({ readOnly: v }, "ro")} label="Read only" />
      {f.fieldType === "text" && <Checkbox checked={f.multiline} onChange={(v) => set({ multiline: v }, "ml")} label="Multi-line" />}
    </div>
  );
}
