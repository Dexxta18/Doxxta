import { useState } from "react";
import { FilePlus2, FileSymlink, Upload } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, NumberInput, Radio, Select, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, withBusy } from "../../state/store";
import { insertBlankPages, insertFromFiles, replacePages } from "../../ops/organize";
import { PAPER, imagesToPdf } from "../../ops/create";
import { isImageFile, isPdfFile, pickFiles, readFileBytes } from "../../lib/util";
import { formatPageRanges, parsePageRanges } from "../../lib/pageRanges";
import { openPdf } from "../../lib/pdfjs";

export default function InsertPagesDialog({ props, close }: DialogProps<{ docId?: string; at?: number; replace?: number[] }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const replaceMode = !!props.replace?.length;
  const [source, setSource] = useState<"blank" | "file">(replaceMode ? "file" : "blank");
  const [count, setCount] = useState(1);
  const [paper, setPaper] = useState("same");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [where, setWhere] = useState<"after" | "before" | "first" | "last">("after");
  const [pageNum, setPageNum] = useState(String(props.at !== undefined ? Math.max(1, props.at) : (doc?.view.page ?? 1)));
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; pages: number } | null>(null);
  const [srcRange, setSrcRange] = useState("");
  if (!doc) return null;
  const n = doc.pages.length;

  const position = () => {
    if (props.at !== undefined && !replaceMode && where === "after" && pageNum === String(Math.max(1, props.at))) return props.at;
    const p = Math.max(1, Math.min(n, parseInt(pageNum, 10) || 1));
    return where === "first" ? 0 : where === "last" ? n : where === "before" ? p - 1 : p;
  };

  const choose = async () => {
    const [f] = await pickFiles("application/pdf,.pdf,image/*");
    if (!f) return;
    let bytes: Uint8Array;
    if (isPdfFile(f)) bytes = await readFileBytes(f);
    else if (isImageFile(f)) bytes = await imagesToPdf([f], { pageSize: "fit", margin: 0 });
    else {
      toast("Choose a PDF or an image", "warning");
      return;
    }
    let pages = 0;
    try {
      const { pdf } = await openPdf(bytes);
      pages = pdf.numPages;
      await pdf.loadingTask.destroy();
    } catch {
      pages = 0;
    }
    setFile({ name: f.name, bytes, pages });
    setSrcRange(replaceMode && pages ? `1-${Math.min(pages, props.replace!.length)}` : "");
  };

  const go = async () => {
    if (replaceMode) {
      if (!file) return;
      let srcPages: number[];
      try {
        srcPages = parsePageRanges(srcRange || "all", file.pages || 1);
      } catch (e) {
        toast((e as Error).message, "error");
        return;
      }
      close();
      await withBusy("Replacing pages…", () => replacePages(doc.id, props.replace!, { name: file.name, bytes: file.bytes, pages: srcPages }));
      return;
    }
    const at = position();
    if (source === "blank") {
      let size: [number, number] | undefined;
      if (paper !== "same") {
        const [w, h] = PAPER[paper];
        size = orientation === "landscape" ? [h, w] : [w, h];
      }
      close();
      await withBusy("Inserting pages…", () => insertBlankPages(doc.id, at, count, size));
      return;
    }
    if (!file) return;
    let pages: number[] | undefined;
    if (srcRange.trim() && file.pages) {
      try {
        pages = parsePageRanges(srcRange, file.pages);
      } catch (e) {
        toast((e as Error).message, "error");
        return;
      }
    }
    close();
    await withBusy("Inserting pages…", () => insertFromFiles(doc.id, at, [{ name: file.name, bytes: file.bytes, pages }]));
  };

  return (
    <Dialog
      title={replaceMode ? "Replace pages" : "Insert pages"}
      icon={replaceMode ? <FileSymlink size={18} /> : <FilePlus2 size={18} />}
      subtitle={replaceMode ? `Replace page${props.replace!.length > 1 ? "s" : ""} ${formatPageRanges(props.replace!)} with pages from another file` : undefined}
      onClose={close}
      width={500}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go} disabled={(source === "file" || replaceMode) && !file}>
            {replaceMode ? "Replace" : "Insert"}
          </Button>
        </>
      }
    >
      {!replaceMode && (
        <div className="dialog-section">
          <div className="dialog-section-title">What to insert</div>
          <Radio value="blank" current={source} onChange={setSource} label="Blank pages" />
          {source === "blank" && (
            <div className="grid-3">
              <Field label="Count">
                <NumberInput value={count} min={1} max={500} onChange={(v) => setCount(Math.max(1, Math.round(v)))} />
              </Field>
              <Field label="Size">
                <Select value={paper} onChange={(e) => setPaper(e.target.value)} options={[{ value: "same", label: "Same as document" }, ...Object.keys(PAPER).map((p) => ({ value: p, label: p }))]} />
              </Field>
              <Field label="Orientation">
                <Select value={orientation} onChange={(e) => setOrientation(e.target.value as "portrait" | "landscape")} disabled={paper === "same"} options={[{ value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }]} />
              </Field>
            </div>
          )}
          <Radio value="file" current={source} onChange={setSource} label="Pages from a PDF or image file" />
        </div>
      )}
      {(source === "file" || replaceMode) && (
        <div className="dialog-section">
          <div className="row">
            <Button icon={<Upload size={15} />} onClick={choose}>
              {file ? "Choose another file" : "Choose file…"}
            </Button>
            {file && (
              <span className="muted ellipsis">
                {file.name} {file.pages ? `· ${file.pages} pages` : ""}
              </span>
            )}
          </div>
          {file && file.pages > 1 && (
            <Field label="Pages from that file" hint={replaceMode ? `Needs ${props.replace!.length} page(s)` : "Leave empty for all pages"}>
              <TextInput value={srcRange} onChange={(e) => setSrcRange(e.target.value)} placeholder={`1-${file.pages}`} />
            </Field>
          )}
        </div>
      )}
      {!replaceMode && (
        <div className="dialog-section">
          <div className="dialog-section-title">Where</div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <Select
              value={where}
              onChange={(e) => setWhere(e.target.value as typeof where)}
              style={{ width: 160 }}
              options={[
                { value: "after", label: "After page" },
                { value: "before", label: "Before page" },
                { value: "first", label: "At the beginning" },
                { value: "last", label: "At the end" },
              ]}
            />
            {(where === "after" || where === "before") && <TextInput style={{ width: 90 }} value={pageNum} onChange={(e) => setPageNum(e.target.value)} aria-label="Page number" />}
            <span className="faint">of {n}</span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
