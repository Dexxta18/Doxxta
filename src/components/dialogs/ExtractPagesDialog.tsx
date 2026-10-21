import { useState } from "react";
import { FileOutput } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc } from "../../state/store";
import { extractToNewDocument } from "../../ops/organize";
import { formatPageRanges, parsePageRanges, validatePageRanges } from "../../lib/pageRanges";

export default function ExtractPagesDialog({ props, close }: DialogProps<{ docId?: string; pages?: number[] }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [range, setRange] = useState(props.pages?.length ? formatPageRanges(props.pages) : String(doc?.view.page ?? 1));
  const [deleteAfter, setDeleteAfter] = useState(false);
  const [separate, setSeparate] = useState(false);
  if (!doc) return null;
  const err = validatePageRanges(range, doc.pages.length);

  return (
    <Dialog
      title="Extract pages"
      icon={<FileOutput size={18} />}
      subtitle="Copy pages (with their comments) into a new document."
      onClose={close}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!!err}
            onClick={() => {
              const pages = parsePageRanges(range, doc.pages.length);
              close();
              extractToNewDocument(doc.id, pages, { deleteAfter, separate });
            }}
          >
            Extract
          </Button>
        </>
      }
    >
      <Field label={`Pages (1–${doc.pages.length})`} error={err} hint="e.g. 1-3, 7, 10-">
        <TextInput autoFocus value={range} onChange={(e) => setRange(e.target.value)} />
      </Field>
      <Checkbox checked={separate} onChange={setSeparate} label="Extract each page as a separate file" />
      <Checkbox checked={deleteAfter} onChange={setDeleteAfter} label="Delete the pages from this document after extracting" />
    </Dialog>
  );
}
