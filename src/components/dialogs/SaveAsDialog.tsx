import { useState } from "react";
import { Download, Lock } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc } from "../../state/store";
import { saveDocumentAs } from "../../core/save";
import { baseName } from "../../lib/util";

export default function SaveAsDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [name, setName] = useState(baseName(doc?.name ?? "document"));
  const [flattenAnnots, setFlattenAnnots] = useState(false);
  const [flattenForms, setFlattenForms] = useState(false);
  const [keepPassword, setKeepPassword] = useState(true);
  if (!doc) return null;
  const encrypted = doc.security.encrypted || doc.security.pending?.kind === "encrypt";
  // Restrictions set by the author can only be lifted with the permissions password (Protect → Remove security).
  const restricted = doc.security.encrypted && !!doc.security.permissions && doc.security.pending?.kind !== "encrypt";

  const save = async () => {
    close();
    await saveDocumentAs(doc.id, `${name.trim() || "document"}.pdf`, {
      flattenAnnotations: flattenAnnots,
      flattenForms,
      security: encrypted && !restricted && !keepPassword ? "none" : "keep",
    });
  };

  return (
    <Dialog
      title="Save a copy"
      icon={<Download size={18} />}
      subtitle="Choose a name and how comments and form fields are saved."
      onClose={close}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="File name">
          <span className="row" style={{ gap: 6 }}>
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
            <span className="muted">.pdf</span>
          </span>
        </Field>
      </form>
      <div className="dialog-section">
        <Checkbox checked={flattenAnnots} onChange={setFlattenAnnots} label="Flatten comments and markups" hint="Comments become part of the page and can no longer be edited." />
        <Checkbox checked={flattenForms} onChange={setFlattenForms} label="Flatten form fields" hint="Filled values are kept, fields are no longer editable." />
        {encrypted && !restricted && (
          <Checkbox checked={keepPassword} onChange={setKeepPassword} label={<span className="row" style={{ gap: 6 }}><Lock size={13} /> Keep password protection</span>} hint="Uncheck to save an unprotected copy." />
        )}
      </div>
    </Dialog>
  );
}
