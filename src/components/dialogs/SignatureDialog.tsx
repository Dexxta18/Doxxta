import { useEffect, useRef, useState } from "react";
import "@fontsource/dancing-script/400.css";
import "@fontsource/great-vibes/400.css";
import "@fontsource/sacramento/400.css";
import "@fontsource/allura/400.css";
import "@fontsource/caveat/400.css";
import "@fontsource/homemade-apple/400.css";
import { Signature, Trash2, Upload, Eraser, Stamp, ImagePlus } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, ColorSwatches, Field, Slider, Tabs, TextInput, EmptyState } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { useSettings, authorName, type SavedSignature } from "../../state/settings";
import { setTool, toast, getDoc } from "../../state/store";
import { addAnnotations } from "../../state/annotActions";
import { createImage } from "../../annotations/factory";
import { removeWhiteBackground, trimCanvas, loadImageFile } from "../../lib/images";
import { loadImage, pickFiles, uid } from "../../lib/util";
import type { Point } from "../../lib/geometry";

const FONTS = ["Dancing Script", "Great Vibes", "Sacramento", "Allura", "Caveat", "Homemade Apple"];
const INK = ["#111111", "#1d3fbf", "#0a7d3b", "#b3261e"];

type Mode = "type" | "draw" | "image";

interface PlaceTarget {
  docId: string;
  pageId: string;
  at: Point;
  rotation: number;
}

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .slice(0, 3);
}

async function renderTyped(text: string, font: string, color: string): Promise<HTMLCanvasElement> {
  await document.fonts.load(`96px "${font}"`, text);
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = `96px "${font}"`;
  const w = Math.ceil(ctx.measureText(text).width) + 60;
  c.width = Math.max(10, w);
  c.height = 190;
  const g = c.getContext("2d")!;
  g.font = `96px "${font}"`;
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.fillText(text, 30, 100);
  return trimCanvas(c, 8);
}

export default function SignatureDialog({ props, close }: DialogProps<{ kind?: "signature" | "initials"; place?: PlaceTarget }>) {
  const kind = props.kind ?? "signature";
  const settings = useSettings();
  const saved = settings.signatures.filter((s) => s.kind === kind);
  const [mode, setMode] = useState<Mode>("type");
  const [name, setName] = useState(() => (kind === "initials" ? initialsOf(authorName() === "Guest" ? "" : authorName()) : authorName() === "Guest" ? "" : authorName()));
  const [font, setFont] = useState(FONTS[0]);
  const [color, setColor] = useState(INK[0]);
  const [width, setWidth] = useState(3);
  const [image, setImage] = useState<string | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [hasDrawing, setHasDrawing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<{ pts: { x: number; y: number; t: number }[] }[]>([]);
  const [, force] = useState(0);
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    Promise.all(FONTS.map((f) => document.fonts.load(`32px "${f}"`))).then(() => setFontsReady(true));
  }, []);

  // ----- drawing pad -----
  const redraw = () => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes.current) {
      const p = s.pts;
      if (!p.length) continue;
      // Velocity-based width gives a pen-like stroke.
      for (let i = 1; i < p.length; i++) {
        const dt = Math.max(1, p[i].t - p[i - 1].t);
        const v = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y) / dt;
        ctx.lineWidth = Math.max(width * 0.45, width * 1.3 - v * width * 0.9);
        ctx.beginPath();
        const mx = (p[i - 1].x + p[i].x) / 2,
          my = (p[i - 1].y + p[i].y) / 2;
        const prev = i > 1 ? { x: (p[i - 2].x + p[i - 1].x) / 2, y: (p[i - 2].y + p[i - 1].y) / 2 } : p[0];
        ctx.moveTo(prev.x, prev.y);
        ctx.quadraticCurveTo(p[i - 1].x, p[i - 1].y, mx, my);
        ctx.stroke();
      }
      if (p.length === 1) {
        ctx.beginPath();
        ctx.arc(p[0].x, p[0].y, width / 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || mode !== "draw") return;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    c.width = r.width * dpr;
    c.height = r.height * dpr;
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, color, width]);

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  };

  // ----- produce the signature image -----
  const produce = async (): Promise<SavedSignature | null> => {
    let canvas: HTMLCanvasElement | null = null;
    if (mode === "type") {
      if (!name.trim()) return null;
      canvas = await renderTyped(name.trim(), font, color);
    } else if (mode === "draw") {
      const c = canvasRef.current;
      if (!c || !strokes.current.some((s) => s.pts.length)) return null;
      canvas = trimCanvas(c, 10);
    } else if (image) {
      const img = await loadImage(image);
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      canvas = trimCanvas(removeBg ? removeWhiteBackground(c) : c, 6, !removeBg);
    }
    if (!canvas) return null;
    // Cap resolution to keep files small.
    const max = 900;
    if (canvas.width > max) {
      const s = max / canvas.width;
      const out = document.createElement("canvas");
      out.width = max;
      out.height = Math.max(1, Math.round(canvas.height * s));
      out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
      canvas = out;
    }
    return { id: uid("sig"), kind, dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height, createdAt: new Date().toISOString() };
  };

  const saveAndUse = async () => {
    const sig = await produce();
    if (!sig) {
      toast(mode === "type" ? "Type your name first" : mode === "draw" ? "Draw your signature first" : "Choose an image first", "warning");
      return;
    }
    useSettings.getState().set({
      signatures: [...useSettings.getState().signatures, sig],
      ...(kind === "signature" ? { selectedSignatureId: sig.id } : { selectedInitialsId: sig.id }),
    });
    use(sig);
  };

  const use = (sig: SavedSignature) => {
    useSettings.getState().set(kind === "signature" ? { selectedSignatureId: sig.id } : { selectedInitialsId: sig.id });
    close();
    const p = props.place;
    if (p && getDoc(p.docId)) {
      // Display size: signatures ~ 180pt wide (scaled by height to look natural).
      addAnnotations(p.docId, [createImage(p.pageId, p.at, p.rotation, sig.dataUrl, sig.width, sig.height, kind, kind === "initials" ? 70 : 180)], kind === "initials" ? "Add initials" : "Add signature");
      setTool("select");
    } else {
      setTool(kind);
      toast(`Click on the page to place your ${kind === "initials" ? "initials" : "signature"}`, "info");
    }
  };

  const remove = (id: string) => {
    const s = useSettings.getState();
    s.set({
      signatures: s.signatures.filter((x) => x.id !== id),
      selectedSignatureId: s.selectedSignatureId === id ? null : s.selectedSignatureId,
      selectedInitialsId: s.selectedInitialsId === id ? null : s.selectedInitialsId,
    });
  };

  const title = kind === "initials" ? "Initials" : "Signature";
  return (
    <Dialog
      title={`Create ${title.toLowerCase()}`}
      icon={<Signature size={18} />}
      subtitle="Saved on this device only and reusable in any document."
      onClose={close}
      width={620}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={saveAndUse}>
            Save & place
          </Button>
        </>
      }
    >
      {saved.length > 0 && (
        <div className="dialog-section">
          <div className="dialog-section-title">Saved {kind === "initials" ? "initials" : "signatures"}</div>
          <div className="sig-saved-grid">
            {saved.map((s) => (
              <div key={s.id} className="sig-saved" role="button" tabIndex={0} onClick={() => use(s)} onKeyDown={(e) => e.key === "Enter" && use(s)} title="Use this">
                <img src={s.dataUrl} alt={title} />
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(s.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <Tabs<Mode>
        value={mode}
        onChange={setMode}
        tabs={[
          { value: "type", label: "Type" },
          { value: "draw", label: "Draw" },
          { value: "image", label: "Image" },
        ]}
      />
      {mode === "type" && (
        <>
          <Field label={kind === "initials" ? "Initials" : "Full name"}>
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "initials" ? "e.g. JD" : "e.g. Jane Doe"} />
          </Field>
          <div className="sig-typed-list">
            {FONTS.map((f) => (
              <button key={f} type="button" className={`sig-typed${font === f ? " is-active" : ""}`} style={{ fontFamily: `"${f}", cursive`, color, opacity: fontsReady ? 1 : 0.4 }} onClick={() => setFont(f)}>
                {name || (kind === "initials" ? "JD" : "Your name")}
              </button>
            ))}
          </div>
        </>
      )}
      {mode === "draw" && (
        <>
          <div className="sig-pad-wrap">
            <canvas
              ref={canvasRef}
              className="sig-pad"
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                strokes.current.push({ pts: [pos(e)] });
                setHasDrawing(true);
                redraw();
              }}
              onPointerMove={(e) => {
                if (!(e.buttons & 1)) return;
                const s = strokes.current[strokes.current.length - 1];
                if (!s) return;
                s.pts.push(pos(e));
                redraw();
              }}
            />
            <div className="sig-pad-line" />
            {!hasDrawing && <div className="sig-pad-hint">Draw here with your mouse, pen or finger</div>}
          </div>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <ColorSwatches value={color} onChange={(c) => c && setColor(c)} colors={INK} />
            <div style={{ width: 180 }}>
              <Slider value={width} min={1} max={8} step={0.5} format={(v) => `${v}px`} onChange={setWidth} />
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={<Eraser size={14} />}
              onClick={() => {
                strokes.current = [];
                setHasDrawing(false);
                force((n) => n + 1);
                redraw();
              }}
            >
              Clear
            </Button>
          </div>
        </>
      )}
      {mode === "type" && (
        <Field label="Ink color">
          <ColorSwatches value={color} onChange={(c) => c && setColor(c)} colors={INK} />
        </Field>
      )}
      {mode === "image" && (
        <>
          {image ? (
            <div className="preview-box" style={{ minHeight: 160, background: "#fff" }}>
              <img src={image} alt="Signature" style={{ maxHeight: 160, boxShadow: "none" }} />
            </div>
          ) : (
            <EmptyState icon={<ImagePlus size={22} />} title="Upload a photo or scan of your signature">
              Sign on white paper, take a photo, and upload it. The background is removed automatically.
            </EmptyState>
          )}
          <div className="row">
            <Button
              icon={<Upload size={15} />}
              onClick={async () => {
                const [f] = await pickFiles("image/*");
                if (!f) return;
                const img = await loadImageFile(f, 1600);
                setImage(img.dataUrl);
              }}
            >
              {image ? "Choose another image" : "Choose image"}
            </Button>
            <Checkbox checked={removeBg} onChange={setRemoveBg} label="Remove white background" />
          </div>
        </>
      )}
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        {kind === "initials" ? "Initials are placed about 70 pt wide." : "Signatures are placed about 180 pt wide."} You can resize them after placing.
      </p>
    </Dialog>
  );
}

/** Custom stamps: images or text labels saved for reuse from the Stamp tool. */
export function CustomStampDialog({ props, close }: DialogProps<{ use?: string }>) {
  const stamps = useSettings((s) => s.customStamps);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("#c62828");

  const choose = (id: string) => {
    useSettings.getState().set({ selectedCustomStampId: id });
    setTool("image-stamp");
    close();
    toast("Click on the page to place the stamp", "info");
  };

  useEffect(() => {
    if (props.use) choose(props.use);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addImage = async () => {
    const [f] = await pickFiles("image/*");
    if (!f) return;
    const img = await loadImageFile(f, 1200);
    const stamp = { id: uid("cs"), name: f.name.replace(/\.[^.]+$/, ""), dataUrl: img.dataUrl, width: img.width, height: img.height };
    useSettings.getState().set({ customStamps: [...useSettings.getState().customStamps, stamp] });
  };

  const addText = async () => {
    if (!label.trim()) return;
    const c = document.createElement("canvas");
    const g = c.getContext("2d")!;
    g.font = "bold 64px Helvetica, Arial, sans-serif";
    const w = Math.ceil(g.measureText(label.toUpperCase()).width) + 80;
    c.width = w;
    c.height = 130;
    const ctx = c.getContext("2d")!;
    ctx.strokeStyle = color;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.roundRect(6, 6, w - 12, 118, 22);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "bold 64px Helvetica, Arial, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(label.toUpperCase(), w / 2, 68);
    const stamp = { id: uid("cs"), name: label, dataUrl: c.toDataURL("image/png"), width: c.width, height: c.height };
    useSettings.getState().set({ customStamps: [...useSettings.getState().customStamps, stamp] });
    setLabel("");
  };

  return (
    <Dialog title="Custom stamps" icon={<Stamp size={18} />} onClose={close} width={560} footer={<Button onClick={close}>Done</Button>}>
      {stamps.length === 0 ? (
        <EmptyState icon={<Stamp size={22} />} title="No custom stamps yet">
          Create one from an image (like a company seal) or from your own text.
        </EmptyState>
      ) : (
        <div className="sig-saved-grid">
          {stamps.map((s) => (
            <div key={s.id} className="sig-saved" role="button" tabIndex={0} onClick={() => choose(s.id)} title={s.name}>
              <img src={s.dataUrl} alt={s.name} />
              <button
                className="icon-btn icon-btn-sm"
                aria-label="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  useSettings.getState().set({ customStamps: stamps.filter((x) => x.id !== s.id) });
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="dialog-section">
        <div className="dialog-section-title">New text stamp</div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <Field label="Text">
            <TextInput value={label} placeholder="e.g. PAID" onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <ColorSwatches value={color} onChange={(c) => c && setColor(c)} colors={["#c62828", "#1e8a4c", "#2f5bea", "#d35400", "#111111"]} />
          <Button variant="subtle" onClick={addText} disabled={!label.trim()}>
            Create
          </Button>
        </div>
      </div>
      <Button icon={<ImagePlus size={15} />} onClick={addImage}>
        New stamp from image…
      </Button>
    </Dialog>
  );
}
