import { useState } from "react";
import { Eraser, Layers } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Radio } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, withBusy } from "../../state/store";
import type { SanitizeOptions } from "../../ops/sanitize";

const ITEMS: { key: keyof SanitizeOptions; label: string; hint: string; default: boolean }[] = [
  { key: "metadata", label: "Metadata", hint: "Title, author, keywords, producer, XMP packets in the document and its images.", default: true },
  { key: "attachments", label: "File attachments", hint: "Embedded files and file attachment comments.", default: true },
  { key: "comments", label: "Comments and markups", hint: "Notes, highlights, drawings, stamps and their replies.", default: true },
  { key: "formFields", label: "Form fields", hint: "Fields are flattened into the page; their values stay visible.", default: true },
  { key: "scripts", label: "Scripts and actions", hint: "JavaScript, launch, submit and import actions, field calculations.", default: true },
  { key: "hiddenLayers", label: "Hidden layers", hint: "Content in layers that are turned off, and the layer structure.", default: true },
  { key: "bookmarks", label: "Bookmarks", hint: "The document outline.", default: false },
  { key: "hiddenText", label: "Hidden text", hint: "Invisible text — note this removes searchable text added by OCR.", default: false },
  { key: "thumbnails", label: "Embedded page thumbnails", hint: "Thumbnail images stored with pages.", default: true },
  { key: "privateData", label: "Private application data", hint: "Data other programs store in the file for themselves.", default: true },
];

export default function SanitizeDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [opts, setOpts] = useState<SanitizeOptions>(() => Object.fromEntries(ITEMS.map((i) => [i.key, i.default])) as unknown as SanitizeOptions);
  if (!doc) return null;
  const any = ITEMS.some((i) => opts[i.key]);
  const run = async () => {
    close();
    const { sanitize } = await import("../../ops/sanitize");
    const r = await withBusy("Removing hidden information…", () => sanitize(doc.id, opts));
    if (r) toast(r.removed.length ? `Removed ${r.removed.join(", ")}. Save to keep the changes.` : "Nothing to remove was found", "success", { timeout: 7000 });
  };
  return (
    <Dialog
      title="Remove hidden information"
      icon={<Eraser size={18} />}
      onClose={close}
      width={560}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={run} disabled={!any}>
            Remove
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Removes information that isn't visible on the pages but travels with the file.
        </p>
        {ITEMS.map((i) => (
          <Checkbox key={i.key} checked={opts[i.key]} onChange={(v) => setOpts({ ...opts, [i.key]: v })} label={i.label} hint={i.hint} />
        ))}
      </div>
    </Dialog>
  );
}

export function FlattenDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [comments, setComments] = useState(true);
  const [forms, setForms] = useState(true);
  const [scope, setScope] = useState<"all" | "current">("all");
  if (!doc) return null;
  const run = async () => {
    close();
    const { flattenDocument } = await import("../../ops/sanitize");
    await withBusy("Flattening…", () => flattenDocument(doc.id, { comments, forms: forms && scope === "all", pageIds: scope === "current" ? [doc.pages[doc.view.page - 1].id] : undefined }));
    toast("Flattened. The items are now part of the page content.", "success");
  };
  return (
    <Dialog
      title="Flatten"
      icon={<Layers size={18} />}
      onClose={close}
      width={480}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={run} disabled={!comments && !forms}>
            Flatten
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Flattening draws comments and form fields into the page so they look the same everywhere and can no longer be edited.
        </p>
        <Checkbox checked={comments} onChange={setComments} label="Comments, stamps and drawings" />
        <Checkbox checked={forms} onChange={setForms} label="Form fields" hint={scope === "current" ? "Form fields are flattened for the whole document only." : undefined} />
        <div className="dialog-section">
          <div className="dialog-section-title">Pages</div>
          <Radio value="all" current={scope} onChange={setScope} label={`All pages (${doc.pages.length})`} />
          <Radio value="current" current={scope} onChange={setScope} label={`Current page (${doc.view.page})`} />
        </div>
      </div>
    </Dialog>
  );
}
