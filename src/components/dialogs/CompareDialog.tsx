import { useState } from "react";
import { FileUp, GitCompare } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, Segmented, Select } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getApp, useApp, toast, withBusy } from "../../state/store";
import { openPdf, PasswordCancelled } from "../../lib/pdfjs";
import { loadPdfLib } from "../../lib/pdflib";
import { errorMessage, pickFiles, readFileBytes } from "../../lib/util";
import { promptPassword } from "../../core/document";

type Choice = { kind: "doc"; docId: string } | { kind: "file"; name: string; bytes: Uint8Array } | null;

/** Reads a file for comparison, decrypting it when it has an open password. */
async function readComparable(file: File): Promise<{ name: string; bytes: Uint8Array }> {
  const bytes = await readFileBytes(file);
  let password: string | undefined;
  const ask = promptPassword(file.name);
  const { pdf } = await openPdf(bytes.slice(), {
    onPassword: async (reason) => {
      const pw = await ask(reason);
      if (pw !== null) password = pw;
      return pw;
    },
  });
  await pdf.loadingTask.destroy();
  if (password === undefined) return { name: file.name, bytes };
  const doc = await loadPdfLib(bytes, password);
  return { name: file.name, bytes: await doc.save() };
}

function SidePicker({ label, value, onChange }: { label: string; value: Choice; onChange: (c: Choice) => void }) {
  const order = useApp((s) => s.order);
  const all = useApp((s) => s.docs);
  const docs = order.map((id) => all[id]).filter((d) => d?.status === "ready");
  const choose = async () => {
    const [f] = await pickFiles("application/pdf,.pdf");
    if (!f) return;
    try {
      onChange({ kind: "file", ...(await readComparable(f)) });
    } catch (e) {
      if (!(e instanceof PasswordCancelled)) toast(`Couldn't open ${f.name}: ${errorMessage(e)}`, "error");
    }
  };
  const selectValue = value?.kind === "doc" ? value.docId : value?.kind === "file" ? "__file" : "";
  return (
    <Field label={label}>
      <div className="row" style={{ gap: 8 }}>
        <Select
          style={{ flex: 1, minWidth: 0 }}
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__pick") void choose();
            else if (v && v !== "__file") onChange({ kind: "doc", docId: v });
          }}
          options={[
            ...(selectValue ? [] : [{ value: "", label: "Choose…" }]),
            ...docs.map((d) => ({ value: d.id, label: `${d.name} (open)` })),
            ...(value?.kind === "file" ? [{ value: "__file", label: value.name }] : []),
            { value: "__pick", label: "Choose a file…" },
          ]}
        />
        <Button icon={<FileUp size={15} />} onClick={choose}>
          Browse
        </Button>
      </div>
    </Field>
  );
}

export default function CompareDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const app = getApp();
  const others = app.order.filter((id) => id !== (props.docId ?? app.activeId));
  const [oldSide, setOld] = useState<Choice>(props.docId || app.activeId ? { kind: "doc", docId: (props.docId ?? app.activeId)! } : null);
  const [newSide, setNew] = useState<Choice>(others[0] ? { kind: "doc", docId: others[others.length - 1] } : null);
  const [kind, setKind] = useState<"text" | "visual">("text");

  const resolve = async (c: Choice) => {
    if (!c) throw new Error("Choose both files");
    if (c.kind === "file") return { name: c.name, bytes: c.bytes };
    const d = getApp().docs[c.docId];
    const { buildPdf } = await import("../../core/save");
    return { name: d?.name ?? "Document", bytes: await buildPdf(c.docId, { security: "none" }) };
  };

  const start = async () => {
    // withBusy reports failures itself and then resolves to undefined.
    const sides = await withBusy("Preparing…", () => Promise.all([resolve(oldSide), resolve(newSide)]));
    if (!sides) return;
    close();
    useApp.setState({ compare: { old: sides[0], new: sides[1], kind } });
  };

  return (
    <Dialog
      title="Compare files"
      icon={<GitCompare size={18} />}
      onClose={close}
      width={520}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={start} disabled={!oldSide || !newSide}>
            Compare
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <SidePicker label="Old file" value={oldSide} onChange={setOld} />
        <SidePicker label="New file" value={newSide} onChange={setNew} />
        <Field label="Compare" hint={kind === "text" ? "Finds words that were added, removed or replaced." : "Finds areas that look different — for scans, drawings and images."}>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "text", label: "Text" },
              { value: "visual", label: "Visual" },
            ]}
          />
        </Field>
      </div>
    </Dialog>
  );
}
