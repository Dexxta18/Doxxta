import { loadImage } from "./util";

export interface LoadedImage {
  dataUrl: string;
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg";
}

/**
 * Loads any browser-decodable image file as PNG/JPEG data URL (the formats
 * PDFs can embed directly), downscaling very large images.
 */
export async function loadImageFile(file: Blob, maxDim = 3000): Promise<LoadedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const isJpeg = file.type === "image/jpeg";
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    if (isJpeg) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);
    const mime = isJpeg ? "image/jpeg" : "image/png";
    return { dataUrl: canvas.toDataURL(mime, 0.92), width: w, height: h, mime };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Trims transparent (or near-white) margins around a drawn signature. */
export function trimCanvas(canvas: HTMLCanvasElement, pad = 6, whiteIsEmpty = false): HTMLCanvasElement {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x1 = width,
    y1 = height,
    x2 = -1,
    y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      const empty = a < 10 || (whiteIsEmpty && data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245);
      if (!empty) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return canvas;
  x1 = Math.max(0, x1 - pad);
  y1 = Math.max(0, y1 - pad);
  x2 = Math.min(width - 1, x2 + pad);
  y2 = Math.min(height - 1, y2 + pad);
  const out = document.createElement("canvas");
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext("2d")!.drawImage(canvas, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Makes near-white pixels transparent (for photographed/scanned signatures). */
export function removeWhiteBackground(canvas: HTMLCanvasElement, threshold = 225): HTMLCanvasElement {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum > threshold) d[i + 3] = 0;
    else if (lum > threshold - 40) d[i + 3] = Math.round(d[i + 3] * ((threshold - lum) / 40));
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
