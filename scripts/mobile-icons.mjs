// Draws the Doxxta logo into the Android and iOS app icons and launch screens (with Playwright's
// Chromium). Run after changing the logo: node scripts/mobile-icons.mjs
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCENT = "#2f5bea";

/** The feather and its line (from the logo in TopBar.tsx), in a 64×64 box. */
const glyph = `
  <path d="M47.5 13.5C33 15.5 22.5 25.5 18.6 40.6l-1.7 6.6 6.4-2.4C37.4 39.4 45.6 28.3 47.5 13.5z" fill="#fff"/>
  <path d="M44 18L20.2 44.6" stroke="${ACCENT}" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M16.6 48.6l-3 3.9" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <path d="M27 51.5h21" stroke="#9fb4ff" stroke-width="3.6" stroke-linecap="round"/>`;

/** An image: the glyph at `scale` of the shorter side, centered, on `background` (a shape, or none). */
function svg(width, height, { background = "none", scale = 0.6 } = {}) {
  const side = Math.min(width, height) * scale;
  const x = (width - side) / 2;
  const y = (height - side) / 2;
  const bg =
    background === "square" ? `<rect width="${width}" height="${height}" fill="${ACCENT}"/>`
    : background === "rounded" ? `<rect width="${width}" height="${height}" rx="${width * 0.22}" fill="${ACCENT}"/>`
    : background === "circle" ? `<circle cx="${width / 2}" cy="${height / 2}" r="${width / 2}" fill="${ACCENT}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bg}<svg x="${x}" y="${y}" width="${side}" height="${side}" viewBox="0 0 64 64">${glyph}</svg></svg>`;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
async function draw(file, width, height, opts, transparent = false) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<style>html,body{margin:0;background:${transparent ? "transparent" : ACCENT}}svg{display:block}</style>${svg(width, height, opts)}`);
  await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
}

// Android: launcher icons for older versions, and the adaptive icon's foreground (the system
// draws it on the background color, cropped to the device's shape; the middle 66% is always seen).
const res = join(root, "android", "app", "src", "main", "res");
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(densities)) {
  await draw(join(res, `mipmap-${d}`, "ic_launcher.png"), 48 * k, 48 * k, { background: "rounded", scale: 0.66 }, true);
  await draw(join(res, `mipmap-${d}`, "ic_launcher_round.png"), 48 * k, 48 * k, { background: "circle", scale: 0.62 }, true);
  await draw(join(res, `mipmap-${d}`, "ic_launcher_foreground.png"), 108 * k, 108 * k, { scale: 0.5 }, true);
}
// Launch screens: the logo on the app's color, at each size the template has.
for (const dir of readdirSync(res).filter((d) => d.startsWith("drawable"))) {
  const file = join(res, dir, "splash.png");
  try {
    statSync(file);
  } catch {
    continue;
  }
  const [w, h] = dir.includes("land") ? [{ mdpi: 480, hdpi: 800, xhdpi: 1280, xxhdpi: 1600, xxxhdpi: 1920 }, { mdpi: 320, hdpi: 480, xhdpi: 720, xxhdpi: 960, xxxhdpi: 1280 }].map((m) => m[dir.split("-").pop()])
    : dir.includes("port") ? [{ mdpi: 320, hdpi: 480, xhdpi: 720, xxhdpi: 960, xxxhdpi: 1280 }, { mdpi: 480, hdpi: 800, xhdpi: 1280, xxhdpi: 1600, xxxhdpi: 1920 }].map((m) => m[dir.split("-").pop()])
    : [480, 320];
  await draw(file, w, h, { scale: 0.28 });
}

// iOS: one 1024×1024 icon (iOS rounds the corners itself; no transparency) and the launch screen.
const assets = join(root, "ios", "App", "App", "Assets.xcassets");
await draw(join(assets, "AppIcon.appiconset", "AppIcon-512@2x.png"), 1024, 1024, { background: "square", scale: 0.62 });
for (const f of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  await draw(join(assets, "Splash.imageset", f), 2732, 2732, { scale: 0.16 });
}
await browser.close();
console.log("Icons and launch screens written.");
