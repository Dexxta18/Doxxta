import { useState } from "react";
import { ScanText } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, Radio, Select, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, withBusy } from "../../state/store";
import { OCR_LANGUAGES, runOcr } from "../../ops/ocr";
import { parsePageRanges, validatePageRanges } from "../../lib/pageRanges";

export default function OcrDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [scope, setScope] = useState<"all" | "current" | "range">("all");
  const [range, setRange] = useState("");
  const [lang, setLang] = useState("eng");
  const [lang2, setLang2] = useState("");
  const [dpi, setDpi] = useState(300);
  const [skip, setSkip] = useState(true);
  if (!doc) return null;
  const err = scope === "range" ? validatePageRanges(range, doc.pages.length) : null;

  const go = async () => {
    const pages = scope === "all" ? null : scope === "current" ? [doc.view.page - 1] : parsePageRanges(range, doc.pages.length);
    close();
    const languages = [lang, lang2].filter(Boolean);
    const n = await withBusy("Recognizing text…", (p) => runOcr(doc.id, { languages, pages, dpi, skipTextPages: skip }, p));
    if (n) toast(`Recognized ${n.toLocaleString()} words — the text is now searchable and selectable.`, "success");
  };

  const langOptions = OCR_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));
  return (
    <Dialog
      title="Recognize text (OCR)"
      icon={<ScanText size={18} />}
      subtitle="Turns scanned pages into searchable, selectable text. Runs on your device."
      onClose={close}
      width={500}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go} disabled={!!err}>
            Recognize text
          </Button>
        </>
      }
    >
      <div className="dialog-section">
        <div className="dialog-section-title">Pages</div>
        <Radio value="all" current={scope} onChange={setScope} label={`All pages (${doc.pages.length})`} />
        <Radio value="current" current={scope} onChange={setScope} label={`Current page (${doc.view.page})`} />
        <Radio value="range" current={scope} onChange={setScope} label="Pages" />
        {scope === "range" && (
          <Field error={err}>
            <TextInput value={range} onChange={(e) => setRange(e.target.value)} placeholder="e.g. 1-4, 9" autoFocus />
          </Field>
        )}
      </div>
      <div className="grid-2">
        <Field label="Document language">
          <Select value={lang} onChange={(e) => setLang(e.target.value)} options={langOptions} />
        </Field>
        <Field label="Second language (optional)">
          <Select value={lang2} onChange={(e) => setLang2(e.target.value)} options={[{ value: "", label: "None" }, ...langOptions.filter((l) => l.value !== lang)]} />
        </Field>
        <Field label="Resolution" hint="Higher is more accurate but slower">
          <Select value={String(dpi)} onChange={(e) => setDpi(Number(e.target.value))} options={[{ value: "200", label: "200 dpi (fast)" }, { value: "300", label: "300 dpi (recommended)" }, { value: "400", label: "400 dpi (small print)" }]} />
        </Field>
      </div>
      <Checkbox checked={skip} onChange={setSkip} label="Skip pages that already have text" />
      {(lang !== "eng" || lang2) && (
        <div className="callout callout-info">
          <ScanText size={16} />
          <span>Language data for {[lang, lang2].filter((l) => l && l !== "eng").map((l) => OCR_LANGUAGES.find((x) => x.code === l)?.label).join(" and ")} is downloaded the first time (a few MB).</span>
        </div>
      )}
    </Dialog>
  );
}
