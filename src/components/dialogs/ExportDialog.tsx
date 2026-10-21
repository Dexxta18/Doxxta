import { useState, type ReactNode } from "react";
import { Download, FileCode, FileImage, FileSpreadsheet, FileText, FileType, Presentation } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, Radio, Segmented, Select, Slider } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, useApp } from "../../state/store";
import { PageScope, scopePages, type Scope } from "./markControls";
import { validatePageRanges } from "../../lib/pageRanges";
import { downloadBytes, errorMessage } from "../../lib/util";
import { EXPORT_DEFAULTS as DEFAULTS, exportDocument, type ExportFormat, type ExportOptions } from "../../ops/export";

const FORMATS: { id: ExportFormat; label: string; hint: string; icon: ReactNode }[] = [
  { id: "docx", label: "Word", hint: "Editable document with headings, lists, tables and images", icon: <FileText size={18} /> },
  { id: "xlsx", label: "Excel", hint: "Tables as spreadsheet cells", icon: <FileSpreadsheet size={18} /> },
  { id: "pptx", label: "PowerPoint", hint: "One slide per page", icon: <Presentation size={18} /> },
  { id: "image", label: "Image", hint: "PNG, JPEG or WebP", icon: <FileImage size={18} /> },
  { id: "html", label: "Web page", hint: "Clean, readable HTML", icon: <FileCode size={18} /> },
  { id: "md", label: "Markdown", hint: "For notes apps, wikis and LLM prompts", icon: <FileCode size={18} /> },
  { id: "txt", label: "Plain text", hint: "Text only", icon: <FileType size={18} /> },
];

export default function ExportDialog({ props, close }: DialogProps<{ docId?: string; format?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [format, setFormat] = useState<ExportFormat>((FORMATS.find((f) => f.id === props.format)?.id ?? "docx") as ExportFormat);
  const [opts, setOpts] = useState<ExportOptions>(DEFAULTS);
  const [scope, setScope] = useState<Scope>("all");
  const [range, setRange] = useState("");
  if (!doc) return null;
  const err = scope === "range" ? validatePageRanges(range, doc.pages.length) : null;
  const set = (patch: Partial<ExportOptions>) => setOpts({ ...opts, ...patch });

  const run = async () => {
    close();
    const busy = (message: string, progress?: number) => useApp.setState({ busy: { message, progress } });
    busy("Exporting…");
    try {
      const res = await exportDocument(doc.id, format, { ...opts, pages: scopePages(scope, range, doc.pages.length, doc.view.page) }, (done, total, label) => busy(label, total ? done / total : undefined));
      downloadBytes(res.bytes, res.name, res.mime);
      toast(`Exported ${res.name}`, "success");
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, "error");
    } finally {
      useApp.setState({ busy: null });
    }
  };

  return (
    <Dialog
      title="Export PDF"
      icon={<Download size={18} />}
      onClose={close}
      width={720}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" icon={<Download size={15} />} onClick={run} disabled={!!err}>
            Export
          </Button>
        </>
      }
    >
      <div className="export-layout">
        <div className="export-formats" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={format === f.id} className={`export-format${format === f.id ? " is-active" : ""}`} onClick={() => setFormat(f.id)}>
              <span className="export-format-icon">{f.icon}</span>
              <span>
                <span className="export-format-label">{f.label}</span>
                <span className="export-format-hint">{f.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="col" style={{ gap: 14 }}>
          {(format === "docx" || format === "html" || format === "md") && <Checkbox checked={opts.images} onChange={(v) => set({ images: v })} label="Include images" />}
          {format === "docx" && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Text flows as editable paragraphs; each PDF page starts a new page in Word.</p>}
          {format === "xlsx" && (
            <div className="dialog-section">
              <div className="dialog-section-title">Worksheets</div>
              <Radio value="perPage" current={opts.xlsxSheets} onChange={(v) => set({ xlsxSheets: v })} label="One worksheet per page" />
              <Radio value="single" current={opts.xlsxSheets} onChange={(v) => set({ xlsxSheets: v })} label="Everything on one worksheet" />
            </div>
          )}
          {format === "pptx" && (
            <div className="dialog-section">
              <div className="dialog-section-title">Slides</div>
              <Radio value="images" current={opts.pptxMode} onChange={(v) => set({ pptxMode: v })} label="Keep the exact look" hint="Each page becomes a picture; its text goes into the speaker notes." />
              <Radio value="editable" current={opts.pptxMode} onChange={(v) => set({ pptxMode: v })} label="Editable text boxes" hint="Text, tables and images you can change; the layout is approximate." />
            </div>
          )}
          {format === "image" && (
            <>
              <Segmented
                value={opts.imageSource}
                onChange={(v) => set({ imageSource: v })}
                options={[
                  { value: "pages", label: "Pages as images" },
                  { value: "embedded", label: "Extract all images" },
                ]}
              />
              {opts.imageSource === "pages" && (
                <>
                  <div className="grid-2">
                    <Field label="Format">
                      <Select
                        value={opts.imageFormat}
                        onChange={(e) => set({ imageFormat: e.target.value as ExportOptions["imageFormat"] })}
                        options={[
                          { value: "png", label: "PNG" },
                          { value: "jpeg", label: "JPEG" },
                          { value: "webp", label: "WebP" },
                        ]}
                      />
                    </Field>
                    <Field label="Resolution">
                      <Select
                        value={String(opts.dpi)}
                        onChange={(e) => set({ dpi: Number(e.target.value) })}
                        options={[72, 96, 150, 200, 300, 600].map((d) => ({ value: String(d), label: `${d} ppi` }))}
                      />
                    </Field>
                  </div>
                  {opts.imageFormat !== "png" && (
                    <Field label="Quality">
                      <Slider value={Math.round(opts.quality * 100)} min={40} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set({ quality: v / 100 })} />
                    </Field>
                  )}
                </>
              )}
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Several images are downloaded together as a .zip file.</p>
            </>
          )}
          {format === "txt" && <Checkbox checked={opts.textLayout} onChange={(v) => set({ textLayout: v })} label="Keep the page layout (columns and indentation)" />}
          <PageScope count={doc.pages.length} scope={scope} setScope={setScope} range={range} setRange={setRange} error={err} current={doc.view.page} />
        </div>
      </div>
    </Dialog>
  );
}
