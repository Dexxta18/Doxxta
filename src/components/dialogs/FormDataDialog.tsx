import { useState } from "react";
import { FileOutput, FileInput } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Radio } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { exportFormData, importFormData, parseFormData } from "../../ops/forms";
import { getActiveDoc, getDoc, toast } from "../../state/store";
import { pickFiles } from "../../lib/util";

type Format = "json" | "csv" | "xfdf" | "fdf";

export default function FormDataDialog({ props, close }: DialogProps<{ docId?: string; mode?: "export" | "import" }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [mode, setMode] = useState<"export" | "import">(props.mode ?? "export");
  const [format, setFormat] = useState<Format>("xfdf");
  if (!doc) return null;

  const run = async () => {
    if (mode === "export") {
      await exportFormData(doc.id, format);
      close();
      return;
    }
    const [file] = await pickFiles(".json,.csv,.xfdf,.xml,.fdf");
    if (!file) return;
    try {
      const values = parseFormData(await file.text(), file.name);
      close();
      await importFormData(doc.id, values);
    } catch (e) {
      toast(`Could not read form data: ${e instanceof Error ? e.message : e}`, "error");
    }
  };

  return (
    <Dialog
      title="Form data"
      icon={mode === "export" ? <FileOutput size={18} /> : <FileInput size={18} />}
      subtitle="Move field values between documents or into spreadsheets."
      onClose={close}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={run}>
            {mode === "export" ? "Export" : "Choose file…"}
          </Button>
        </>
      }
    >
      {!doc.hasForms && <div className="callout callout-warning">This document has no fillable form fields.</div>}
      <div className="dialog-section">
        <Radio value="export" current={mode} onChange={setMode} label="Export the values of this form" />
        <Radio value="import" current={mode} onChange={setMode} label="Fill this form from a data file" hint="JSON, CSV, XFDF or FDF — field names must match." />
      </div>
      {mode === "export" && (
        <div className="dialog-section">
          <div className="dialog-section-title">Format</div>
          <Radio value="xfdf" current={format} onChange={setFormat} label="XFDF (.xfdf)" hint="Acrobat-compatible XML" />
          <Radio value="fdf" current={format} onChange={setFormat} label="FDF (.fdf)" hint="Classic Acrobat form data" />
          <Radio value="json" current={format} onChange={setFormat} label="JSON (.json)" />
          <Radio value="csv" current={format} onChange={setFormat} label="CSV (.csv)" hint="Opens in Excel and Google Sheets" />
        </div>
      )}
    </Dialog>
  );
}
