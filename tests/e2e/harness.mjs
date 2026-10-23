// Shared helpers for the browser tests: launching Chromium, opening fixtures, checks.
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = join(ROOT, "test-fixtures");
export const OUTPUT = join(ROOT, "test-output");
mkdirSync(join(OUTPUT, "shots"), { recursive: true });

/** Chromium from `npx playwright install chromium`, or the one at CHROMIUM_PATH. */
export async function launchBrowser() {
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  try {
    return await chromium.launch({ executablePath, args: ["--disable-gpu"] });
  } catch (e) {
    if (!executablePath && /Executable doesn't exist/.test(String(e))) {
      throw new Error("Chromium for Playwright isn't installed. Run `npx playwright install chromium`, or set CHROMIUM_PATH to a Chromium binary.");
    }
    throw e;
  }
}

/** A fresh page on the app with the native file windows disabled (headless Chromium can't show them). A phone's settings (Playwright's devices) make it a phone. */
export async function openApp(browser, url, device) {
  const context = await browser.newContext({ ...(device ?? { viewport: { width: 1440, height: 900 } }), acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.showOpenFilePicker = undefined;
    window.showSaveFilePicker = undefined;
  });
  await page.goto(url);
  await page.waitForSelector(".app");
  return { context, page, errors };
}

/** A test PDF: generated ones are in test-fixtures, the ones kept with the tests in tests/assets. */
export function fixture(name) {
  for (const dir of [FIXTURES, join(ROOT, "tests", "assets")]) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  throw new Error(`Missing fixture ${name}`);
}

/** Opens a fixture through the app's drag & drop handler. */
export async function dropFile(page, name, mime = "application/pdf") {
  const b64 = readFileSync(fixture(name)).toString("base64");
  await page.evaluate(
    ({ b64, name, mime }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: mime }));
      const target = document.querySelector(".main");
      target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { b64, name, mime },
  );
}

/** Waits until the active document (dev build) is loaded and its first page is drawn. */
export async function waitForPages(page) {
  await page.waitForFunction(
    () => {
      const s = window.__doxxta?.useApp.getState();
      const d = s?.activeId && s.docs[s.activeId];
      return d && d.status === "ready" && document.querySelector('.pdfViewer .page[data-loaded="true"]');
    },
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(500);
}

export async function shot(page, name) {
  const path = join(OUTPUT, "shots", `${name}.png`);
  await page.screenshot({ path });
  return path;
}

/** Collects pass/fail results for one suite. */
export function recorder(suite) {
  const results = [];
  const check = (cond, message) => {
    results.push({ suite, ok: !!cond, message });
    console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${message}`);
    return !!cond;
  };
  return { results, check };
}
