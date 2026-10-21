export type RGB = [number, number, number];

export const PALETTE = [
  "#ffd400", // yellow
  "#ff6b6b", // red
  "#ff9f43", // orange
  "#5fd068", // green
  "#4cc9f0", // cyan
  "#3d7bfd", // blue
  "#a66cff", // purple
  "#ff66c4", // pink
  "#000000",
  "#5b6270",
  "#ffffff",
];

export const HIGHLIGHT_COLORS = ["#ffd400", "#5fd068", "#4cc9f0", "#ff66c4", "#ff9f43", "#a66cff"];

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Hex color to PDF color components in 0..1. */
export function hexToPdf(hex: string): RGB {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/** PDF color array (gray, rgb or cmyk, 0..1) to hex. */
export function pdfColorToHex(c: ArrayLike<number> | null | undefined): string | null {
  if (!c || c.length === 0) return null;
  if (c.length === 1) return rgbToHex(c[0] * 255, c[0] * 255, c[0] * 255);
  if (c.length === 3) return rgbToHex(c[0] * 255, c[1] * 255, c[2] * 255);
  if (c.length === 4) {
    const [C, M, Y, K] = [c[0], c[1], c[2], c[3]];
    return rgbToHex(255 * (1 - C) * (1 - K), 255 * (1 - M) * (1 - K), 255 * (1 - Y) * (1 - K));
  }
  return null;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const contrastText = (hex: string) => (luminance(hex) > 0.45 ? "#111111" : "#ffffff");

export function pdfColorOp(hex: string, stroke: boolean): string {
  const [r, g, b] = hexToPdf(hex);
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${stroke ? "RG" : "rg"}`;
}

/** Compact number formatting for PDF content streams. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = (Math.round(n * 10000) / 10000).toString();
  return s === "-0" ? "0" : s;
}
