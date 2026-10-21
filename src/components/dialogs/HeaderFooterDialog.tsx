import { useEffect, useRef, useState } from "react";
import { Hash, Heading, ListOrdered, Trash2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, NumberInput, Select, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, withBusy } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import { addHeaderFooter, applyHeaderFooterToDoc, batesNumber, hasMarks, removePageMarks, type HeaderFooterSpec, type MarkKind, type TextStyle } from "../../ops/pageMarks";
import { usePagePreview } from "./usePagePreview";
import { MarginFields, PageScope, PreviewPane, TextStyleFields } from "./markControls";
import { parsePageRanges, validatePageRanges } from "../../lib/pageRanges";
import { formatDatePattern } from "../../lib/dates";

const TOKENS = [
  { token: "<<page>>", label: "Page number" },
  { token: "<<pages>>", label: "Total pages" },
  { token: "<<date>>", label: "Date" },
  { token: "<<file>>", label: "File name" },
  { token: "<<title>>", label: "Title" },
];
const DATE_FORMATS = ["mm/dd/yyyy", "dd/mm/yyyy", "yyyy-mm-dd", "mmmm d, yyyy", "d mmmm yyyy", "mmm d, yyyy"];
const SLOTS = ["Header left", "Header center", "Header right", "Footer left", "Footer center", "Footer right"];

const defaultStyle: TextStyle = { family: "Helvetica", bold: false, italic: false, size: 10, color: "#333333", opacity: 1, underline: false };

function useMarkDialog(docId: string | undefined, kinds: MarkKind[]) {
  const doc = getDoc(docId) ?? getActiveDoc();
  const [existing, setExisting] = useState(0);
  useEffect(() => {
    const rt = doc && getRuntime(doc.id);
    if (rt) hasMarks(rt.bytes, kinds).then(setExisting).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);
  return { doc, existing };
}

function MarkDialogFrame({
  title,
  icon,
  existing,
  removeKinds,
  removeLabel,
  onApply,
  applyLabel,
  disabled,
  close,
  children,
  preview,
  docId,
}: {
  title: string;
  icon: React.ReactNode;
  existing: number;
  removeKinds: MarkKind[];
  removeLabel: string;
  onApply: () => void;
  applyLabel: string;
  disabled?: boolean;
  close: () => void;
  children: React.ReactNode;
  preview: { url: string | null; loading: boolean };
  docId: string;
}) {
  return (
    <Dialog
      title={title}
      icon={icon}
      onClose={close}
      width={820}
      footer={
        <>
          {existing > 0 && (
            <Button
              variant="ghost"
              icon={<Trash2 size={15} />}
              style={{ marginRight: "auto" }}
              onClick={async () => {
                close();
                const n = await withBusy("Removing…", () => removePageMarks(docId, removeKinds, removeLabel));
                toast(`Removed from ${n ?? 0} page${n === 1 ? "" : "s"}`, "success");
              }}
            >
              {removeLabel}
            </Button>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={onApply} disabled={disabled}>
            {applyLabel}
          </Button>
        </>
      }
    >
      <div className="split-layout">
        <div className="col" style={{ gap: 14 }}>{children}</div>
        <PreviewPane url={preview.url} loading={preview.loading} />
      </div>
    </Dialog>
  );
}

export default function HeaderFooterDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const { doc, existing } = useMarkDialog(props.docId, ["header", "footer"]);
  const [slots, setSlots] = useState<string[]>(["", "", "", "", "Page <<page>> of <<pages>>", ""]);
  const [focus, setFocus] = useState(4);
  const [style, setStyle] = useState<TextStyle>(defaultStyle);
  const [margins, setMargins] = useState({ top: 36, bottom: 30, left: 54, right: 54 });
  const [start, setStart] = useState(1);
  const [dateFormat, setDateFormat] = useState(DATE_FORMATS[0]);
  const [scope, setScope] = useState<"all" | "range" | "current">("all");
  const [range, setRange] = useState("");
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  const spec = (pages: number[]): HeaderFooterSpec => ({
    header: [slots[0], slots[1], slots[2]],
    footer: [slots[3], slots[4], slots[5]],
    style,
    margins,
    pages,
    startNumber: start,
    dateFormat,
    kind: "header",
  });
  const preview = usePagePreview(doc?.id ?? "", doc ? doc.view.page - 1 : 0, (d) => applyHeaderFooterToDoc(d, spec([0]), { file: doc?.name ?? "", title: doc?.metadata?.title || doc?.name || "" }), [slots, style, margins, start, dateFormat]);
  if (!doc) return null;
  const err = scope === "range" ? validatePageRanges(range, doc.pages.length) : null;

  const insertToken = (t: string) => {
    const el = inputs.current[focus];
    const v = slots[focus];
    const pos = el?.selectionStart ?? v.length;
    const next = [...slots];
    next[focus] = v.slice(0, pos) + t + v.slice(el?.selectionEnd ?? pos);
    setSlots(next);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(pos + t.length, pos + t.length);
    }, 0);
  };

  const apply = async () => {
    if (!slots.some((s) => s.trim())) return toast("Enter text for at least one position", "warning");
    const pages = scope === "all" ? doc.pages.map((_, i) => i) : scope === "current" ? [doc.view.page - 1] : parsePageRanges(range, doc.pages.length);
    close();
    await withBusy("Adding header & footer…", () => addHeaderFooter(doc.id, spec(pages)));
  };

  return (
    <MarkDialogFrame
      title="Header & footer"
      icon={<Heading size={18} />}
      existing={existing}
      removeKinds={["header", "footer"]}
      removeLabel="Remove existing headers & footers"
      onApply={apply}
      applyLabel="Add"
      disabled={!!err}
      close={close}
      preview={preview}
      docId={doc.id}
    >
      <div className="grid-3">
        {SLOTS.map((label, i) => (
          <Field key={label} label={label}>
            <TextInput
              ref={(el) => {
                inputs.current[i] = el;
              }}
              value={slots[i]}
              onFocus={() => setFocus(i)}
              onChange={(e) => setSlots(slots.map((s, k) => (k === i ? e.target.value : s)))}
            />
          </Field>
        ))}
      </div>
      <div className="token-chips">
        <span className="faint" style={{ fontSize: 12, marginRight: 4 }}>
          Insert into {SLOTS[focus].toLowerCase()}:
        </span>
        {TOKENS.map((t) => (
          <button key={t.token} type="button" className="token-chip" onClick={() => insertToken(t.token)}>
            {t.label}
          </button>
        ))}
      </div>
      <TextStyleFields style={style} onChange={setStyle} sizes={[6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 24]} />
      <MarginFields margins={margins} onChange={(m) => setMargins(m as typeof margins)} keys={["top", "bottom", "left", "right"]} />
      <div className="grid-2">
        <Field label="Start page numbers at">
          <NumberInput value={start} min={0} onChange={(v) => setStart(Math.round(v))} />
        </Field>
        <Field label="Date format" hint={formatDatePattern(new Date(), dateFormat)}>
          <Select value={dateFormat} onChange={(e) => setDateFormat(e.target.value)} options={DATE_FORMATS.map((f) => ({ value: f, label: f }))} />
        </Field>
      </div>
      <PageScope count={doc.pages.length} scope={scope} setScope={setScope} range={range} setRange={setRange} error={err} />
    </MarkDialogFrame>
  );
}

const POSITIONS = [
  { value: "4", label: "Bottom center" },
  { value: "5", label: "Bottom right" },
  { value: "3", label: "Bottom left" },
  { value: "1", label: "Top center" },
  { value: "2", label: "Top right" },
  { value: "0", label: "Top left" },
];

function slotsFor(pos: number, text: string): [[string, string, string], [string, string, string]] {
  const header: [string, string, string] = ["", "", ""];
  const footer: [string, string, string] = ["", "", ""];
  if (pos < 3) header[pos] = text;
  else footer[pos - 3] = text;
  return [header, footer];
}

export function PageNumbersDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const { doc, existing } = useMarkDialog(props.docId, ["pagenumber"]);
  const [pos, setPos] = useState(4);
  const [format, setFormat] = useState("Page <<page>> of <<pages>>");
  const [start, setStart] = useState(1);
  const [style, setStyle] = useState<TextStyle>({ ...defaultStyle, size: 10 });
  const [scope, setScope] = useState<"all" | "range" | "current">("all");
  const [range, setRange] = useState("");
  const [header, footer] = slotsFor(pos, format);
  const spec = (pages: number[]): HeaderFooterSpec => ({ header, footer, style, margins: { top: 30, bottom: 28, left: 54, right: 54 }, pages, startNumber: start, dateFormat: "mm/dd/yyyy", kind: "pagenumber" });
  const preview = usePagePreview(doc?.id ?? "", doc ? doc.view.page - 1 : 0, (d) => applyHeaderFooterToDoc(d, spec([0]), { file: doc?.name ?? "", title: "" }), [pos, format, start, style]);
  if (!doc) return null;
  const err = scope === "range" ? validatePageRanges(range, doc.pages.length) : null;

  return (
    <MarkDialogFrame
      title="Add page numbers"
      icon={<ListOrdered size={18} />}
      existing={existing}
      removeKinds={["pagenumber"]}
      removeLabel="Remove page numbers"
      onApply={async () => {
        const pages = scope === "all" ? doc.pages.map((_, i) => i) : scope === "current" ? [doc.view.page - 1] : parsePageRanges(range, doc.pages.length);
        close();
        await withBusy("Adding page numbers…", () => addHeaderFooter(doc.id, spec(pages), "Add page numbers"));
      }}
      applyLabel="Add page numbers"
      disabled={!!err}
      close={close}
      preview={preview}
      docId={doc.id}
    >
      <div className="grid-2">
        <Field label="Position">
          <Select value={String(pos)} onChange={(e) => setPos(Number(e.target.value))} options={POSITIONS} />
        </Field>
        <Field label="Format">
          <Select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            options={[
              { value: "Page <<page>> of <<pages>>", label: "Page 1 of 10" },
              { value: "<<page>>", label: "1" },
              { value: "- <<page>> -", label: "- 1 -" },
              { value: "<<page>> / <<pages>>", label: "1 / 10" },
              { value: "Page <<page>>", label: "Page 1" },
            ]}
          />
        </Field>
        <Field label="Start at">
          <NumberInput value={start} min={0} onChange={(v) => setStart(Math.round(v))} />
        </Field>
      </div>
      <TextStyleFields style={style} onChange={setStyle} sizes={[6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 24]} />
      <PageScope count={doc.pages.length} scope={scope} setScope={setScope} range={range} setRange={setRange} error={err} />
    </MarkDialogFrame>
  );
}

export function BatesDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const { doc, existing } = useMarkDialog(props.docId, ["bates"]);
  const [prefix, setPrefix] = useState("ABC");
  const [suffix, setSuffix] = useState("");
  const [digits, setDigits] = useState(6);
  const [start, setStart] = useState(1);
  const [pos, setPos] = useState(5);
  const [style, setStyle] = useState<TextStyle>({ ...defaultStyle, size: 9, bold: true, color: "#000000" });
  const bates = { prefix, suffix, digits, start };
  const [header, footer] = slotsFor(pos, "<<bates>>");
  const spec = (pages: number[]): HeaderFooterSpec => ({ header, footer, style, margins: { top: 24, bottom: 22, left: 36, right: 36 }, pages, startNumber: 1, dateFormat: "mm/dd/yyyy", bates, kind: "bates" });
  const preview = usePagePreview(doc?.id ?? "", doc ? doc.view.page - 1 : 0, (d) => applyHeaderFooterToDoc(d, spec([0]), { file: doc?.name ?? "", title: "" }), [prefix, suffix, digits, start, pos, style]);
  if (!doc) return null;
  return (
    <MarkDialogFrame
      title="Bates numbering"
      icon={<Hash size={18} />}
      existing={existing}
      removeKinds={["bates"]}
      removeLabel="Remove Bates numbers"
      onApply={async () => {
        close();
        await withBusy("Adding Bates numbers…", () => addHeaderFooter(doc.id, spec(doc.pages.map((_, i) => i)), "Add Bates numbering"));
      }}
      applyLabel="Add Bates numbers"
      close={close}
      preview={preview}
      docId={doc.id}
    >
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Stamps every page with a unique sequential identifier, as used for legal discovery.
      </p>
      <div className="grid-2">
        <Field label="Prefix">
          <TextInput value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
        <Field label="Suffix">
          <TextInput value={suffix} onChange={(e) => setSuffix(e.target.value)} />
        </Field>
        <Field label="Digits">
          <NumberInput value={digits} min={3} max={15} onChange={(v) => setDigits(Math.round(v))} />
        </Field>
        <Field label="Start number">
          <NumberInput value={start} min={0} onChange={(v) => setStart(Math.round(v))} />
        </Field>
        <Field label="Position">
          <Select value={String(pos)} onChange={(e) => setPos(Number(e.target.value))} options={POSITIONS} />
        </Field>
      </div>
      <div className="callout">
        First page: <strong>{batesNumber(bates, 0)}</strong> · Last page: <strong>{batesNumber(bates, doc.pages.length - 1)}</strong>
      </div>
      <TextStyleFields style={style} onChange={setStyle} sizes={[6, 7, 8, 9, 10, 11, 12, 14]} />
    </MarkDialogFrame>
  );
}
