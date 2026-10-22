// Smoke test of the production build through the UI only: npm run test:smoke
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { preview } from "vite";
import { PDFDocument, PDFName, PDFArray, PDFDict } from "@cantoo/pdf-lib";
import { ROOT, fixture, launchBrowser, openApp, recorder, shot } from "./harness.mjs";
import { ensureFixtures } from "./fixtures.mjs";

if (!existsSync(join(ROOT, "dist", "index.html"))) {
  console.error("No production build found. Run `npm run build` first (or use `npm run test:smoke`).");
  process.exit(2);
}
const browser = await launchBrowser();
await ensureFixtures(browser);
const server = await preview({ root: ROOT, logLevel: "error", preview: { host: "127.0.0.1", port: 4199 } });
const url = server.resolvedUrls.local[0];
const { context, page, errors } = await openApp(browser, url);
const failedRequests = [];
page.on("response", (r) => r.status() >= 400 && failedRequests.push(`${r.status()} ${r.url()}`));
page.on("requestfailed", (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url()}`));
const { results, check } = recorder("smoke");

const open = async (name) => {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Control+o")]);
  await chooser.setFiles(fixture(name));
  await page.waitForFunction((name) => [...document.querySelectorAll(".doc-tab.is-active .doc-tab-name")].some((e) => e.textContent === name), name, { timeout: 20000 });
  await page.waitForSelector('.pdfViewer .page[data-loaded="true"]', { timeout: 20000 });
  await page.waitForTimeout(600);
};
const findCount = async (text) => {
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const status = (await page.locator(".findbar-status").textContent().catch(() => "")) ?? "";
  await page.keyboard.press("Escape");
  return status.trim();
};

try {
  console.log("\nProduction build");
  check(!(await page.evaluate(() => "__doxxta" in window)), "no development hooks in the build");
  await open("sample.pdf");
  check(true, "opens a PDF with the Open command (Ctrl+O)");

  // Highlight text and draw a rectangle.
  await page.click('button.tools-item:has-text("Add comments")');
  await page.click('button[aria-label="Highlight text"]');
  const span = await page.locator('.pdfViewer .page[data-page-number="1"] .textLayer span').nth(1).boundingBox();
  await page.mouse.move(span.x + 2, span.y + span.height / 2);
  await page.mouse.down();
  await page.mouse.move(span.x + span.width * 0.6, span.y + span.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const box = await page.locator('.pdfViewer .page[data-page-number="1"]').boundingBox();
  await page.click('button[aria-label="Rectangle"]');
  await page.mouse.move(box.x + 120, box.y + 420);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + 520, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  const drawn = await page.locator('.pdfViewer .page[data-page-number="1"] g[data-annot-id]').evaluateAll((els) => new Set(els.map((e) => e.dataset.annotId)).size);
  check(drawn === 2, `highlight and rectangle are drawn (${drawn})`);

  check(/^1 of \d+/.test(await findCount("lorem")), "find (Ctrl+F) finds matches");

  // Save, then read the file with pdf-lib.
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }).catch(() => null), page.keyboard.press("Control+s")]);
  check(!!download, `save (Ctrl+S) downloads ${download?.suggestedFilename()}`);
  if (download) {
    const doc = await PDFDocument.load(await readFile(await download.path()));
    const annots = doc.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    const types = (annots?.asArray() ?? []).map((ref) => doc.context.lookup(ref, PDFDict).get(PDFName.of("Subtype"))?.toString());
    check(types.includes("/Highlight") && types.includes("/Square"), `saved file contains the comments (${types.join(" ")})`);
  }

  await page.click('button.tools-item:has-text("Organize pages")');
  await page.waitForSelector(".org-item");
  await page.waitForTimeout(500);
  check((await page.locator(".org-item").count()) === 6, "Organize pages shows all pages");
  await shot(page, "smoke-organize");

  // OCR runs with the engine and language data served by the build.
  await open("scanned.pdf");
  await page.click(".menubar-item:has-text('Tools')");
  await page.click(".menu-item:has-text('Recognize text')");
  await page.waitForSelector(".dialog-title:has-text('Recognize')");
  await page.click(".dialog-footer .btn-primary");
  const recognized = await page.waitForSelector(".toast:has-text('Recognized')", { timeout: 180000 }).then(() => true, () => false);
  check(recognized, "OCR recognizes the scanned page");
  check(/^1 of \d+/.test(await findCount("brown fox")), "recognized text is searchable");
  await shot(page, "smoke-ocr");
} catch (e) {
  check(false, `stopped: ${String(e.message ?? e).split("\n")[0]}`);
  await shot(page, "smoke-stopped").catch(() => {});
}
for (const message of errors) check(false, `page error: ${message}`);
check(failedRequests.length === 0, `all requests succeed${failedRequests.length ? `: ${failedRequests.join(", ")}` : ""}`);
await context.close();
await browser.close();
await new Promise((resolve) => server.httpServer.close(resolve));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
