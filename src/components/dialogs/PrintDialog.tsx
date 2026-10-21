import { useState } from "react";
import { Printer } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, Radio, Select, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, withBusy } from "../../state/store";
import { parsePageRanges, validatePageRanges } from "../../lib/pageRanges";
import { printDocument, type PrintOptions } from "../../ops/print";

export default function PrintDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const count = doc?.pages.length ?? 1;
  const [which, setWhich] = useState<"all" | "current" | "range">("all");
  const [range, setRange] = useState(`1-${count}`);
  const [content, setContent] = useState<PrintOptions["content"]>("all");
  const [sizing, setSizing] = useState<PrintOptions["sizing"]>("fit");
  const [orientation, setOrientation] = useState<PrintOptions["orientation"]>("auto");
  const [dpi, setDpi] = useState(150);
  const [grayscale, setGrayscale] = useState(false);
  if (!doc) return null;
  const rangeError = which === "range" ? validatePageRanges(range, count) : null;

  const go = async () => {
    const pages = which === "all" ? Array.from({ length: count }, (_, i) => i) : which === "current" ? [doc.view.page - 1] : parsePageRanges(range, count);
    close();
    await withBusy("Preparing to print…", (p) => printDocument(doc.id, { pages, content, sizing, orientation, dpi, grayscale }, p));
  };

  return (
    <Dialog
      title="Print"
      icon={<Printer size={18} />}
      onClose={close}
      width={500}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go} disabled={!!rangeError}>
            Print
          </Button>
        </>
      }
    >
      <div className="dialog-section">
        <div className="dialog-section-title">Pages to print</div>
        <Radio value="all" current={which} onChange={setWhich} label={`All pages (${count})`} />
        <Radio value="current" current={which} onChange={setWhich} label={`Current page (${doc.view.page})`} />
        <Radio value="range" current={which} onChange={setWhich} label="Pages" />
        {which === "range" && (
          <Field error={rangeError} hint="e.g. 1-3, 5, 8-">
            <TextInput value={range} onChange={(e) => setRange(e.target.value)} autoFocus />
          </Field>
        )}
      </div>
      <div className="grid-2">
        <Field label="Comments & forms">
          <Select
            value={content}
            onChange={(e) => setContent(e.target.value as PrintOptions["content"])}
            options={[
              { value: "all", label: "Document and markups" },
              { value: "forms", label: "Document and form fields" },
              { value: "document", label: "Document only" },
            ]}
          />
        </Field>
        <Field label="Page sizing">
          <Select
            value={sizing}
            onChange={(e) => setSizing(e.target.value as PrintOptions["sizing"])}
            options={[
              { value: "fit", label: "Fit to paper" },
              { value: "actual", label: "Actual size" },
              { value: "shrink", label: "Shrink oversized pages" },
            ]}
          />
        </Field>
        <Field label="Orientation">
          <Select
            value={orientation}
            onChange={(e) => setOrientation(e.target.value as PrintOptions["orientation"])}
            options={[
              { value: "auto", label: "Auto" },
              { value: "portrait", label: "Portrait" },
              { value: "landscape", label: "Landscape" },
            ]}
          />
        </Field>
        <Field label="Quality">
          <Select
            value={String(dpi)}
            onChange={(e) => setDpi(Number(e.target.value))}
            options={[
              { value: "100", label: "Draft (100 dpi)" },
              { value: "150", label: "Standard (150 dpi)" },
              { value: "300", label: "High (300 dpi)" },
            ]}
          />
        </Field>
      </div>
      <Checkbox checked={grayscale} onChange={setGrayscale} label="Print in grayscale" />
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        Printer, copies and two-sided printing are chosen in the print window that opens next.
      </p>
    </Dialog>
  );
}
