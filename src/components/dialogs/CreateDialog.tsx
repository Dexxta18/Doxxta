import { useState } from "react";
import { FilePlus2, Image as ImageIcon, FileText, File as FileIcon, Clipboard, Camera, Trash2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, NumberInput, Select, Tabs, EmptyState } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { openDialog, withBusy } from "../../state/store";
import { PAPER, blankPdf, createFromClipboard, imagesToPdf, textToPdf } from "../../ops/create";
import { openGenerated } from "../../core/document";
import { pickFiles, baseName } from "../../lib/util";

type Tab = "blank" | "images" | "text";
const paperOptions = Object.keys(PAPER).map((p) => ({ value: p, label: p }));

export default function CreateDialog({ props, close }: DialogProps<{ tab?: Tab }>) {
  const [tab, setTab] = useState<Tab>(props.tab ?? "blank");
  const [paper, setPaper] = useState("Letter");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [count, setCount] = useState(1);
  const [images, setImages] = useState<File[]>([]);
  const [imgPaper, setImgPaper] = useState("fit");
  const [margin, setMargin] = useState(0);
  const [textFile, setTextFile] = useState<File | null>(null);
  const [font, setFont] = useState<"Helvetica" | "Times" | "Courier">("Courier");
  const [size, setSize] = useState(10);

  const create = async () => {
    close();
    await withBusy("Creating PDF…", async () => {
      if (tab === "blank") {
        await openGenerated(await blankPdf(paper, count, orientation), "Untitled.pdf");
      } else if (tab === "images") {
        const bytes = await imagesToPdf(images, { pageSize: imgPaper, margin, orientation: "auto" });
        await openGenerated(bytes, images.length === 1 ? `${baseName(images[0].name)}.pdf` : "Images.pdf");
      } else if (textFile) {
        const bytes = await textToPdf(await textFile.text(), { font, size, paper, margin: 54 });
        await openGenerated(bytes, `${baseName(textFile.name)}.pdf`);
      }
    });
  };

  const disabled = (tab === "images" && !images.length) || (tab === "text" && !textFile);

  return (
    <Dialog
      title="Create PDF"
      icon={<FilePlus2 size={18} />}
      onClose={close}
      width={560}
      footer={
        <>
          <Button variant="ghost" icon={<Clipboard size={15} />} onClick={() => (close(), createFromClipboard())} style={{ marginRight: "auto" }}>
            From clipboard
          </Button>
          <Button variant="ghost" icon={<Camera size={15} />} onClick={() => (close(), openDialog("camera"))}>
            Camera
          </Button>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={disabled}>
            Create
          </Button>
        </>
      }
    >
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "blank", label: "Blank" },
          { value: "images", label: "From images" },
          { value: "text", label: "From text file" },
        ]}
      />
      {tab === "blank" && (
        <div className="grid-3">
          <Field label="Page size">
            <Select value={paper} onChange={(e) => setPaper(e.target.value)} options={paperOptions} />
          </Field>
          <Field label="Orientation">
            <Select value={orientation} onChange={(e) => setOrientation(e.target.value as "portrait" | "landscape")} options={[{ value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }]} />
          </Field>
          <Field label="Pages">
            <NumberInput value={count} min={1} max={500} onChange={(v) => setCount(Math.max(1, Math.round(v)))} />
          </Field>
        </div>
      )}
      {tab === "images" && (
        <>
          {images.length === 0 ? (
            <EmptyState icon={<ImageIcon size={22} />} title="Choose images">
              JPG, PNG, WebP, GIF, BMP… each image becomes a page.
            </EmptyState>
          ) : (
            <div className="file-list">
              {images.map((f, i) => (
                <div key={i} className="file-row">
                  <div className="file-row-thumb">
                    <img src={URL.createObjectURL(f)} alt="" />
                  </div>
                  <span className="ellipsis" style={{ flex: 1 }}>
                    {f.name}
                  </span>
                  <button className="icon-btn icon-btn-sm" aria-label="Remove" onClick={() => setImages(images.filter((_, k) => k !== i))}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <Button icon={<ImageIcon size={15} />} onClick={async () => setImages([...images, ...(await pickFiles("image/*", true))])}>
              Add images…
            </Button>
          </div>
          <div className="grid-2">
            <Field label="Page size">
              <Select value={imgPaper} onChange={(e) => setImgPaper(e.target.value)} options={[{ value: "fit", label: "Same as image" }, ...paperOptions]} />
            </Field>
            <Field label="Margin">
              <NumberInput value={margin} min={0} max={144} onChange={setMargin} suffix="pt" />
            </Field>
          </div>
        </>
      )}
      {tab === "text" && (
        <>
          <div className="row">
            <Button icon={<FileText size={15} />} onClick={async () => setTextFile((await pickFiles(".txt,.md,.csv,.log,.json,.xml,.html,text/*"))[0] ?? null)}>
              {textFile ? "Choose another file" : "Choose text file…"}
            </Button>
            {textFile && (
              <span className="muted ellipsis">
                <FileIcon size={13} /> {textFile.name}
              </span>
            )}
          </div>
          <div className="grid-3">
            <Field label="Font">
              <Select value={font} onChange={(e) => setFont(e.target.value as typeof font)} options={[{ value: "Courier", label: "Monospace" }, { value: "Helvetica", label: "Sans" }, { value: "Times", label: "Serif" }]} />
            </Field>
            <Field label="Size">
              <NumberInput value={size} min={6} max={36} onChange={setSize} suffix="pt" />
            </Field>
            <Field label="Paper">
              <Select value={paper} onChange={(e) => setPaper(e.target.value)} options={paperOptions} />
            </Field>
          </div>
        </>
      )}
    </Dialog>
  );
}
