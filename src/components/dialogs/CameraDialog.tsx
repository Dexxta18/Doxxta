import { useEffect, useRef, useState } from "react";
import { Camera, Trash2, ScanText } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, EmptyState } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { toast, withBusy } from "../../state/store";
import { imagesToPdf } from "../../ops/create";
import { openGenerated } from "../../core/document";
import { canvasToBlob } from "../../lib/util";

/** Enhances a document photo: grayscale-aware contrast stretch for crisper "scans". */
function enhance(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++;
  const total = d.length / 4;
  let lo = 0,
    hi = 255,
    acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < total * 0.15; hi--);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, ((d[i + c] - lo) * 255) / span));
  ctx.putImageData(img, 0, 0);
}

export default function CameraDialog({ close }: DialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [shots, setShots] = useState<{ url: string; blob: Blob }[]>([]);
  const [improve, setImprove] = useState(true);
  const [ocr, setOcr] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let s: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment", width: { ideal: 2560 }, height: { ideal: 1920 } } })
      .then((st) => {
        s = st;
        setStream(st);
        if (videoRef.current) {
          videoRef.current.srcObject = st;
          videoRef.current.play().catch(() => {});
        }
      })
      .catch(() => setError("Camera access was denied or no camera is available."));
    return () => s?.getTracks().forEach((t) => t.stop());
  }, []);

  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    if (improve) enhance(c);
    const blob = await canvasToBlob(c, "image/jpeg", 0.9);
    setShots((s) => [...s, { url: URL.createObjectURL(blob), blob }]);
  };

  const done = async () => {
    if (!shots.length) return;
    stream?.getTracks().forEach((t) => t.stop());
    close();
    await withBusy("Creating PDF…", async () => {
      const bytes = await imagesToPdf(
        shots.map((s) => s.blob),
        { pageSize: "Letter", margin: 0, orientation: "auto" },
      );
      const id = await openGenerated(bytes, "Scan.pdf");
      if (ocr && id) {
        const { runOcr } = await import("../../ops/ocr");
        await runOcr(id, { languages: ["eng"], pages: null, dpi: 300 }).catch((e) => toast(String(e), "error"));
      }
    });
  };

  return (
    <Dialog
      title="Scan with camera"
      icon={<Camera size={18} />}
      subtitle="Capture paper documents page by page."
      onClose={close}
      width={640}
      dismissable={false}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={done} disabled={!shots.length}>
            Create PDF ({shots.length})
          </Button>
        </>
      }
    >
      {error ? (
        <EmptyState icon={<Camera size={22} />} title="Camera unavailable">
          {error}
        </EmptyState>
      ) : (
        <video ref={videoRef} className="camera-view" playsInline muted />
      )}
      {shots.length > 0 && (
        <div className="capture-strip">
          {shots.map((s, i) => (
            <div key={i} style={{ position: "relative" }}>
              <img src={s.url} alt={`Page ${i + 1}`} />
              <button className="icon-btn icon-btn-sm" style={{ position: "absolute", top: 2, right: 2, background: "var(--surface)" }} aria-label="Remove" onClick={() => setShots(shots.filter((_, k) => k !== i))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Button variant="subtle" icon={<Camera size={15} />} onClick={capture} disabled={!stream}>
          Capture page
        </Button>
        <Checkbox checked={improve} onChange={setImprove} label="Enhance contrast" />
        <Checkbox checked={ocr} onChange={setOcr} label={<span className="row" style={{ gap: 5 }}><ScanText size={13} /> Make text searchable (OCR)</span>} />
      </div>
    </Dialog>
  );
}
