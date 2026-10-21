import { useEffect } from "react";
import { Download, ExternalLink, Paperclip, Plus, Trash2, FileText, RotateCcw } from "lucide-react";
import { toast, updateDoc, useApp } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import { EmptyState } from "../ui/Fields";
import { Button, Spinner } from "../ui/Button";
import { downloadBytes, formatBytes, isPdfBytes, pickFiles, readFileBytes, uid } from "../../lib/util";
import { openBytes } from "../../core/document";
import { desktop } from "../../lib/desktop";
import type { AttachmentInfo } from "../../state/types";

export async function loadAttachments(docId: string) {
  const rt = getRuntime(docId);
  if (!rt) return;
  const map = await rt.pdf.getAttachments().catch(() => null);
  const list: AttachmentInfo[] = [];
  for (const [key, att] of map ?? []) {
    // pdf.js 6 loads attachment bytes lazily.
    const content = att.content ?? (await rt.pdf.getAttachmentContent(key).catch(() => null)) ?? undefined;
    list.push({ id: `f:${key}`, filename: att.filename || key, description: att.description || undefined, size: content?.length ?? 0, content });
  }
  updateDoc(docId, { attachments: list });
}

function mimeFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  return (
    { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", xml: "application/xml", json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", html: "text/html" }[ext ?? ""] ??
    "application/octet-stream"
  );
}

export default function AttachmentsPanel({ docId }: { docId: string }) {
  const attachments = useApp((s) => s.docs[docId].attachments);
  const version = useApp((s) => s.docs[docId].version);

  useEffect(() => {
    if (attachments === null) loadAttachments(docId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, version]);

  if (attachments === null)
    return (
      <div className="center-fill">
        <Spinner />
      </div>
    );

  const add = async () => {
    const files = await pickFiles("*/*", true);
    if (!files.length) return;
    const added: AttachmentInfo[] = [];
    for (const f of files) added.push({ id: uid("att"), filename: f.name, size: f.size, content: await readFileBytes(f), pending: true });
    updateDoc(docId, (d) => ({ attachments: [...(d.attachments ?? []), ...added], attachmentsDirty: true, dirty: true }));
    toast(`${added.length} file${added.length > 1 ? "s" : ""} attached — saved with the document.`, "success");
  };

  const setRemoved = (id: string, removed: boolean) => {
    updateDoc(docId, (d) => ({
      attachments: (d.attachments ?? []).flatMap((a) => (a.id !== id ? [a] : a.pending ? (removed ? [] : [a]) : [{ ...a, removed }])),
      attachmentsDirty: true,
      dirty: true,
    }));
  };

  const open = async (a: AttachmentInfo) => {
    if (!a.content) return;
    if (isPdfBytes(a.content)) await openBytes(a.content, a.filename, { transient: true });
    // The desktop app doesn't open attachments in other programs (they may be unsafe); it saves them instead.
    else if (desktop) downloadBytes(a.content, a.filename, mimeFor(a.filename));
    else {
      const url = URL.createObjectURL(new Blob([a.content as BlobPart], { type: mimeFor(a.filename) }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  };

  return (
    <div className="attachments-panel">
      <div className="panel-toolbar">
        <Button size="sm" variant="subtle" icon={<Plus size={15} />} onClick={add}>
          Attach file
        </Button>
      </div>
      {attachments.length === 0 ? (
        <EmptyState icon={<Paperclip size={22} />} title="No attachments">
          Embed spreadsheets, source files or other documents inside this PDF.
        </EmptyState>
      ) : (
        <div className="att-list scroll-thin">
          {attachments.map((a) => (
            <div key={a.id} className={`att-item${a.removed ? " is-removed" : ""}`}>
              <span className="att-icon">
                <FileText size={18} />
              </span>
              <div className="col" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                <strong className="ellipsis" title={a.filename}>
                  {a.filename}
                </strong>
                <span className="faint" style={{ fontSize: 11.5 }}>
                  {formatBytes(a.size)}
                  {a.pending && " · new"}
                  {a.removed && " · will be removed"}
                  {a.description && ` · ${a.description}`}
                </span>
              </div>
              {a.removed ? (
                <button className="icon-btn icon-btn-sm" aria-label="Restore" data-tip="Restore" onClick={() => setRemoved(a.id, false)}>
                  <RotateCcw size={15} />
                </button>
              ) : (
                <>
                  <button className="icon-btn icon-btn-sm" aria-label="Open" data-tip="Open" onClick={() => open(a)}>
                    <ExternalLink size={15} />
                  </button>
                  <button className="icon-btn icon-btn-sm" aria-label="Save to disk" data-tip="Save to disk" onClick={() => a.content && downloadBytes(a.content, a.filename, mimeFor(a.filename))}>
                    <Download size={15} />
                  </button>
                  <button className="icon-btn icon-btn-sm" aria-label="Remove" data-tip="Remove" onClick={() => setRemoved(a.id, true)}>
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
