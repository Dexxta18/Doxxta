import { Bold, FileUp, Italic, Underline } from "lucide-react";
import { ColorButton, Field, NumberInput, Radio, Select, TextInput } from "../ui/Fields";
import type { TextStyle, Anchor, GraphicSource } from "../../ops/pageMarks";
import { Button, IconButton, Spinner } from "../ui/Button";
import { isPdfFile, pickFiles, readFileBytes } from "../../lib/util";
import { loadImageFile } from "../../lib/images";
import { loadPdfLib } from "../../lib/pdflib";
import { toast } from "../../state/store";
import { parsePageRanges } from "../../lib/pageRanges";

export function TextStyleFields({ style, onChange, sizes = [8, 9, 10, 11, 12, 14, 16, 18, 24, 36, 48, 60, 72, 96, 120] }: { style: TextStyle; onChange: (s: TextStyle) => void; sizes?: number[] }) {
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
      <Select
        style={{ width: 130 }}
        value={style.family}
        onChange={(e) => onChange({ ...style, family: e.target.value as TextStyle["family"] })}
        options={[
          { value: "Helvetica", label: "Helvetica" },
          { value: "Times", label: "Times" },
          { value: "Courier", label: "Courier" },
        ]}
      />
      <Select style={{ width: 84 }} value={String(style.size)} onChange={(e) => onChange({ ...style, size: Number(e.target.value) })} options={sizes.map((s) => ({ value: String(s), label: `${s} pt` }))} />
      <IconButton size="sm" icon={<Bold size={15} />} label="Bold" active={style.bold} onClick={() => onChange({ ...style, bold: !style.bold })} />
      <IconButton size="sm" icon={<Italic size={15} />} label="Italic" active={style.italic} onClick={() => onChange({ ...style, italic: !style.italic })} />
      {style.underline !== undefined && <IconButton size="sm" icon={<Underline size={15} />} label="Underline" active={!!style.underline} onClick={() => onChange({ ...style, underline: !style.underline })} />}
      <ColorButton label="Text color" value={style.color} onChange={(c) => c && onChange({ ...style, color: c })} />
    </div>
  );
}

const ANCHORS: Anchor[] = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

export function AnchorPicker({ value, onChange }: { value: Anchor; onChange: (a: Anchor) => void }) {
  return (
    <div className="position-grid" role="radiogroup" aria-label="Position">
      {ANCHORS.map((a) => (
        <button key={a} type="button" className={value === a ? "is-active" : ""} aria-label={a} onClick={() => onChange(a)} />
      ))}
    </div>
  );
}

export function PageScope({ count, scope, setScope, range, setRange, error, current }: { count: number; scope: "all" | "range" | "current"; setScope: (s: "all" | "range" | "current") => void; range: string; setRange: (s: string) => void; error: string | null; current?: number }) {
  return (
    <div className="dialog-section">
      <div className="dialog-section-title">Pages</div>
      <Radio value="all" current={scope} onChange={setScope} label={`All pages (${count})`} />
      {current !== undefined && <Radio value="current" current={scope} onChange={setScope} label={`Current page (${current})`} />}
      <Radio value="range" current={scope} onChange={setScope} label="Pages" />
      {scope === "range" && (
        <Field error={error} hint="e.g. 1-3, 8, odd, even">
          <TextInput value={range} onChange={(e) => setRange(e.target.value)} placeholder="1-3, 8" />
        </Field>
      )}
    </div>
  );
}

export function PreviewPane({ url, loading, label }: { url: string | null; loading: boolean; label?: string }) {
  return (
    <div className="preview-box" aria-label={label ?? "Preview"}>
      {url && <img src={url} alt="Preview" style={{ opacity: loading ? 0.6 : 1, transition: "opacity .15s" }} />}
      {loading && (
        <div style={{ position: "absolute", top: 10, right: 10 }}>
          <Spinner size="sm" />
        </div>
      )}
    </div>
  );
}

export function MarginFields({ margins, onChange, keys }: { margins: Record<string, number>; onChange: (m: Record<string, number>) => void; keys: string[] }) {
  return (
    <div className="grid-2">
      {keys.map((k) => (
        <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
          <NumberInput value={Math.round(margins[k] / 0.72) / 100} step={0.05} min={0} onChange={(v) => onChange({ ...margins, [k]: v * 72 })} suffix="in" />
        </Field>
      ))}
    </div>
  );
}

/** Chooses an image or a page of a PDF to place on pages. */
export function GraphicPicker({ value, onChange }: { value: GraphicSource | undefined; onChange: (g: GraphicSource | undefined) => void }) {
  const choose = async () => {
    const [f] = await pickFiles("image/*,application/pdf,.pdf");
    if (!f) return;
    try {
      if (isPdfFile(f)) {
        const bytes = await readFileBytes(f);
        const doc = await loadPdfLib(bytes);
        onChange({ pdf: { bytes, pageIndex: 0, name: f.name, pageCount: doc.getPageCount() } });
      } else {
        const img = await loadImageFile(f, 2400);
        onChange({ image: { dataUrl: img.dataUrl, width: img.width, height: img.height } });
      }
    } catch {
      toast(`Couldn't read ${f.name}`, "error");
    }
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10 }}>
        <Button icon={<FileUp size={15} />} onClick={choose}>
          {value ? "Change file…" : "Choose image or PDF…"}
        </Button>
        {value?.pdf && <span className="muted ellipsis" style={{ fontSize: 12.5 }}>{value.pdf.name}</span>}
        {value?.image && <img src={value.image.dataUrl} alt="" style={{ height: 32, maxWidth: 80, objectFit: "contain", border: "1px solid var(--border)", borderRadius: 4 }} />}
      </div>
      {value?.pdf && value.pdf.pageCount > 1 && (
        <Field label="Page of that PDF">
          <NumberInput
            value={value.pdf.pageIndex + 1}
            min={1}
            max={value.pdf.pageCount}
            suffix={`of ${value.pdf.pageCount}`}
            onChange={(v) => onChange({ pdf: { ...value.pdf!, pageIndex: Math.min(value.pdf!.pageCount, Math.max(1, Math.round(v))) - 1 } })}
          />
        </Field>
      )}
    </div>
  );
}

export type Scope = "all" | "range" | "current";

export function scopePages(scope: Scope, range: string, count: number, current: number): number[] {
  return scope === "all" ? Array.from({ length: count }, (_, i) => i) : scope === "current" ? [current - 1] : parsePageRanges(range, count);
}
