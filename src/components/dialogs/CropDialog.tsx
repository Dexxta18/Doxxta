import { useEffect, useMemo, useRef, useState } from "react";
import { Crop, Wand2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, NumberInput, Radio, Select, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, setTool, toast, withBusy } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import { cropPages, type CropSpec } from "../../ops/organize";
import { parsePageRanges, validatePageRanges, formatPageRanges } from "../../lib/pageRanges";
import { renderPageToCanvas } from "../../lib/pdfjs";
import { stageTransform, transformRect, type PdfRect } from "../../lib/geometry";

const UNITS = { pt: 1, in: 72, mm: 72 / 25.4 } as const;
type Unit = keyof typeof UNITS;

/** Finds the non-white content box of a rendered page (for "remove white margins"). */
function contentMargins(canvas: HTMLCanvasElement, scale: number): CropSpec {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x1 = w,
    y1 = h,
    x2 = -1,
    y2 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  if (x2 < 0) return { left: 0, right: 0, top: 0, bottom: 0 };
  const pad = 6;
  return {
    left: Math.max(0, x1 / scale - pad),
    top: Math.max(0, y1 / scale - pad),
    right: Math.max(0, (w - x2) / scale - pad),
    bottom: Math.max(0, (h - y2) / scale - pad),
  };
}

export default function CropDialog({ props, close }: DialogProps<{ docId?: string; pageIndex?: number; rect?: PdfRect; pages?: number[] }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const pageIndex = props.pageIndex ?? props.pages?.[0] ?? (doc ? doc.view.page - 1 : 0);
  const page = doc?.pages[pageIndex];
  const rotation = page ? page.rotate % 360 : 0;
  const geo = useMemo(() => (page ? stageTransform(page.view, rotation) : null), [page, rotation]);
  // Margins as displayed (top/left/… of the page as you see it).
  const initial: CropSpec = useMemo(() => {
    if (!props.rect || !geo) return { left: 0, right: 0, top: 0, bottom: 0 };
    const r = transformRect(geo.m, props.rect);
    return { left: r[0], top: r[1], right: geo.width - r[2], bottom: geo.height - r[3] };
  }, [props.rect, geo]);
  const [m, setM] = useState<CropSpec>(initial);
  const [unit, setUnit] = useState<Unit>("in");
  const [scope, setScope] = useState<"current" | "all" | "range">(props.pages && props.pages.length > 1 ? "range" : "current");
  const [range, setRange] = useState(props.pages?.length ? formatPageRanges(props.pages) : "");
  const [preview, setPreview] = useState<{ url: string; w: number; h: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const rt = doc && getRuntime(doc.id);
    if (!rt) return;
    rt.pdf.getPage(pageIndex + 1).then(async (p) => {
      const vp = p.getViewport({ scale: 1 });
      const scale = 300 / Math.max(vp.width, vp.height);
      const c = await renderPageToCanvas(p, { scale });
      canvasRef.current = c;
      setPreview({ url: c.toDataURL("image/png"), w: c.width, h: c.height });
    });
  }, [doc, pageIndex]);

  if (!doc || !page || !geo) return null;
  const u = UNITS[unit];
  const err = scope === "range" ? validatePageRanges(range, doc.pages.length) : null;
  const sx = preview ? preview.w / geo.width : 1;

  const auto = () => {
    if (!canvasRef.current || !preview) return;
    setM(contentMargins(canvasRef.current, sx));
  };

  const apply = async () => {
    const pages = scope === "current" ? [pageIndex] : scope === "all" ? doc.pages.map((_, i) => i) : parsePageRanges(range, doc.pages.length);
    if (m.left + m.right >= geo.width - 10 || m.top + m.bottom >= geo.height - 10) {
      toast("The margins are larger than the page", "error");
      return;
    }
    close();
    setTool("select");
    await withBusy("Cropping…", () => cropPages(doc.id, pages, m));
  };

  const num = (k: keyof CropSpec, label: string) => (
    <Field label={label}>
      <NumberInput value={Math.round((m[k] / u) * 100) / 100} min={0} step={unit === "pt" ? 1 : 0.05} onChange={(v) => setM({ ...m, [k]: Math.max(0, v * u) })} suffix={unit} />
    </Field>
  );

  return (
    <Dialog
      title="Crop pages"
      icon={<Crop size={18} />}
      subtitle="Trim the visible area of pages. Content outside is hidden, not deleted."
      onClose={close}
      width={680}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!!err}>
            Crop
          </Button>
        </>
      }
    >
      <div className="split-layout">
        <div className="preview-box">
          {preview && (
            <div style={{ position: "relative", width: preview.w, maxWidth: "100%" }}>
              <img src={preview.url} alt="Page preview" style={{ width: "100%", maxHeight: "none" }} />
              <div
                style={{
                  position: "absolute",
                  left: `${(m.left / geo.width) * 100}%`,
                  top: `${(m.top / geo.height) * 100}%`,
                  right: `${(m.right / geo.width) * 100}%`,
                  bottom: `${(m.bottom / geo.height) * 100}%`,
                  outline: "2px solid var(--accent)",
                  boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.35)",
                }}
              />
            </div>
          )}
        </div>
        <div className="col" style={{ gap: 12 }}>
          <div className="grid-2">
            {num("top", "Top")}
            {num("bottom", "Bottom")}
            {num("left", "Left")}
            {num("right", "Right")}
          </div>
          <div className="row">
            <Field label="Units">
              <Select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} options={[{ value: "in", label: "Inches" }, { value: "mm", label: "Millimeters" }, { value: "pt", label: "Points" }]} />
            </Field>
          </div>
          <Button icon={<Wand2 size={15} />} onClick={auto}>
            Remove white margins
          </Button>
          <div className="dialog-section">
            <div className="dialog-section-title">Apply to</div>
            <Radio value="current" current={scope} onChange={setScope} label={`Page ${pageIndex + 1}`} />
            <Radio value="all" current={scope} onChange={setScope} label="All pages" />
            <Radio value="range" current={scope} onChange={setScope} label="Pages" />
            {scope === "range" && (
              <Field error={err}>
                <TextInput value={range} onChange={(e) => setRange(e.target.value)} placeholder="e.g. 1-5" />
              </Field>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
