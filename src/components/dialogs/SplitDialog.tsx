import { useEffect, useState } from "react";
import { Scissors } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, NumberInput, Radio, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, withBusy } from "../../state/store";
import { loadOutline } from "../../core/outline";
import { splitBySize, splitGroups, zipFiles, type SplitMode } from "../../ops/combine";
import { buildPdf } from "../../core/save";
import { openGenerated } from "../../core/document";
import { baseName, downloadBlob, downloadBytes } from "../../lib/util";
import { parsePageRanges } from "../../lib/pageRanges";

type Kind = "every" | "ranges" | "bookmarks" | "size";

export default function SplitDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [kind, setKind] = useState<Kind>("every");
  const [every, setEvery] = useState(1);
  const [ranges, setRanges] = useState("");
  const [mb, setMb] = useState(5);
  const [output, setOutput] = useState<"tabs" | "zip" | "files">("zip");
  const [bookmarks, setBookmarks] = useState<{ index: number; title: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!doc) return;
    (doc.outline ? Promise.resolve(doc.outline) : loadOutline(doc.id)).then((outline) => {
      const starts = outline
        .map((n) => ({ index: doc.pages.findIndex((p) => p.id === n.pageId), title: n.title }))
        .filter((s) => s.index >= 0);
      setBookmarks(starts);
    });
  }, [doc]);

  if (!doc) return null;
  const count = doc.pages.length;

  const groupsPreview = (): { pages: number[]; title?: string }[] | null => {
    try {
      if (kind === "every") return splitGroups({ kind: "every", pages: every }, count);
      if (kind === "bookmarks") return bookmarks ? splitGroups({ kind: "bookmarks", starts: bookmarks }, count) : null;
      if (kind === "ranges") {
        const parts = ranges.split(/;|\n/).map((s) => s.trim()).filter(Boolean);
        return parts.map((p) => ({ pages: parsePageRanges(p, count) }));
      }
      return null;
    } catch (e) {
      return null;
    }
  };
  const groups = groupsPreview();

  const go = async () => {
    setError(null);
    let mode: SplitMode;
    if (kind === "ranges") {
      try {
        const parts = ranges.split(/;|\n/).map((s) => s.trim()).filter(Boolean);
        if (!parts.length) throw new Error("Enter at least one range");
        mode = { kind: "ranges", ranges: parts.map((p) => parsePageRanges(p, count)) };
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    } else if (kind === "bookmarks") {
      if (!bookmarks?.length) {
        setError("This document has no top-level bookmarks");
        return;
      }
      mode = { kind: "bookmarks", starts: bookmarks };
    } else if (kind === "size") mode = { kind: "size", maxBytes: mb * 1024 * 1024 };
    else mode = { kind: "every", pages: every };
    close();
    await withBusy("Splitting…", async (progress) => {
      const parts = mode.kind === "size" ? (await splitBySize(doc.id, count, mode.maxBytes, (p) => progress(p * 0.5, "Measuring"))).map((pages) => ({ pages, title: undefined as string | undefined })) : splitGroups(mode, count);
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (let i = 0; i < parts.length; i++) {
        progress(0.5 + (i / parts.length) * 0.5, `Part ${i + 1} of ${parts.length}`);
        const bytes = await buildPdf(doc.id, { pageIndices: parts[i].pages, security: "none" });
        const label = parts[i].title ? parts[i].title!.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) : `part ${i + 1}`;
        files.push({ name: `${baseName(doc.name)} - ${label}.pdf`, bytes });
      }
      if (output === "tabs") for (const f of files) await openGenerated(f.bytes, f.name);
      else if (output === "files") for (const f of files) downloadBytes(f.bytes, f.name);
      else downloadBlob(new Blob([zipFiles(files) as BlobPart], { type: "application/zip" }), `${baseName(doc.name)} - split.zip`);
    });
  };

  return (
    <Dialog
      title="Split document"
      icon={<Scissors size={18} />}
      subtitle={`${doc.name} · ${count} pages`}
      onClose={close}
      width={520}
      footer={
        <>
          {groups && <span className="faint" style={{ marginRight: "auto", fontSize: 12 }}>{groups.length} files</span>}
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go}>
            Split
          </Button>
        </>
      }
    >
      <div className="dialog-section">
        <div className="dialog-section-title">Split by</div>
        <Radio value="every" current={kind} onChange={setKind} label="Number of pages" />
        {kind === "every" && (
          <Field hint={`Creates ${Math.ceil(count / Math.max(1, every))} files`}>
            <NumberInput value={every} min={1} max={count} onChange={(v) => setEvery(Math.max(1, Math.round(v)))} suffix="pages each" />
          </Field>
        )}
        <Radio value="bookmarks" current={kind} onChange={setKind} label="Top-level bookmarks" hint={bookmarks === null ? "Loading…" : `${bookmarks.length} bookmarks found`} disabled={!bookmarks?.length} />
        <Radio value="ranges" current={kind} onChange={setKind} label="Page ranges" />
        {kind === "ranges" && (
          <Field hint="One file per range, separated by semicolons — e.g. 1-3; 4-10; 11-" error={error}>
            <TextInput value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3; 4-10; 11-" autoFocus />
          </Field>
        )}
        <Radio value="size" current={kind} onChange={setKind} label="Maximum file size" />
        {kind === "size" && (
          <Field>
            <NumberInput value={mb} min={0.1} step={0.5} onChange={setMb} suffix="MB" />
          </Field>
        )}
      </div>
      <div className="dialog-section">
        <div className="dialog-section-title">Output</div>
        <Radio value="zip" current={output} onChange={setOutput} label="Download as a ZIP archive" />
        <Radio value="files" current={output} onChange={setOutput} label="Download separate files" />
        <Radio value="tabs" current={output} onChange={setOutput} label="Open each part in a new tab" />
      </div>
      {error && kind !== "ranges" && <div className="callout callout-danger">{error}</div>}
    </Dialog>
  );
}
