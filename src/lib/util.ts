export const uid = (prefix = ""): string =>
  prefix + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 16);

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => t && clearTimeout(t);
  return d;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${u[i]}`;
}

export function formatDateTime(d: Date | string | number | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatRelative(d: string | number | Date): string {
  const date = new Date(d);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return date.toLocaleDateString();
}

export const baseName = (name: string) => name.replace(/\.[^./\\]+$/, "");

export const withExt = (name: string, ext: string) => `${baseName(name)}.${ext.replace(/^\./, "")}`;

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime = "application/pdf") {
  downloadBlob(new Blob([bytes as BlobPart], { type: mime }), filename);
}

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    input.onchange = () => {
      resolve(input.files ? Array.from(input.files) : []);
      input.remove();
    };
    input.oncancel = () => {
      resolve([]);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const modKeyLabel = isMac ? "⌘" : "Ctrl";

export function shortcutLabel(s: string): string {
  return s
    .replace(/Mod/g, modKeyLabel)
    .replace(/Alt/g, isMac ? "⌥" : "Alt")
    .replace(/Shift/g, isMac ? "⇧" : "Shift");
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

export const isImageFile = (f: File) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(f.name);

export const isPdfFile = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Runs async tasks with bounded concurrency, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type = "image/png", quality?: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), type, quality),
  );
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

export function nowIso() {
  return new Date().toISOString();
}

export function plural(n: number, word: string, pluralWord = word + "s") {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
