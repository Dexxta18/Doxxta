// Desktop app tests: npm run test:desktop (needs a display; on Linux servers run it under xvfb-run).
// Set QUILLMARK_APP to a packaged executable to test an installer's build.
// Native dialogs are replaced in the main process with answers chosen by the test.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { FIXTURES, ROOT, launchBrowser, recorder } from "../e2e/harness.mjs";
import { ensureFixtures } from "../e2e/fixtures.mjs";

const require = createRequire(import.meta.url);
const stage = join(ROOT, ".desktop-app");
if (spawnSync(process.execPath, [join(ROOT, "scripts", "desktop.mjs"), "stage"], { stdio: "inherit" }).status !== 0) process.exit(1);
if (!["sample.pdf", "simple.pdf", "scanned.pdf"].every((f) => existsSync(join(FIXTURES, f)))) {
  const browser = await launchBrowser();
  await ensureFixtures(browser);
  await browser.close();
}

// Work on copies, since the app saves into them.
const dir = mkdtempSync(join(tmpdir(), "quillmark-desktop-"));
const userData = mkdtempSync(join(tmpdir(), "quillmark-profile-"));
for (const f of ["sample.pdf", "simple.pdf", "scanned.pdf"]) copyFileSync(join(FIXTURES, f), join(dir, f));
const file = (name) => join(dir, name);

const { results, check } = recorder("desktop");
const errors = [];
const cspViolations = [];
// Root can't use Chromium's sandbox (CI containers); a normal user's app always runs with it.
const flags = [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "--disable-gpu", `--user-data-dir=${userData}`];
// QUILLMARK_APP tests a packaged build instead, e.g. QUILLMARK_APP=release/linux-unpacked/quillmark
const packaged = process.env.QUILLMARK_APP;
const app = await electron.launch(
  packaged ? { executablePath: packaged, args: [...flags, file("sample.pdf")] } : { executablePath: require("electron"), args: [...flags, stage, file("sample.pdf")], cwd: ROOT },
);
const win = await app.firstWindow();
win.on("pageerror", (e) => errors.push(e.message));
win.on("console", (m) => /Content Security Policy/i.test(m.text()) && cspViolations.push(m.text()));

const main = (fn, arg) => app.evaluate(fn, arg);
const title = () => win.title();
const waitTitle = (re) => win.waitForFunction((src) => new RegExp(src).test(document.title), re.source, { timeout: 20000 }).then(() => true, () => false);
const loaded = () => win.waitForSelector('.pdfViewer .page[data-loaded="true"]', { timeout: 20000 });
/** Annotation types on the first page of a saved file. */
const annotTypes = async (name) => {
  const doc = await PDFDocument.load(readFileSync(file(name)));
  const annots = doc.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? [];
  return annots.map((ref) => doc.context.lookup(ref, PDFDict).get(PDFName.of("Subtype"))?.toString().slice(1));
};

try {
  console.log("\nDesktop app");
  await win.waitForSelector(".app");
  check(win.url().startsWith("app://quillmark/"), "the app is served from inside the desktop app");
  check(await waitTitle(/^sample\.pdf — Quillmark$/), `a PDF passed on the command line (Open with) opens: "${await title()}"`);
  await loaded();

  // Draw a rectangle, then Ctrl+S writes back to the same file.
  const before = statSync(file("sample.pdf")).size;
  await win.click('button.tools-item:has-text("Add comments")');
  await win.click('button[aria-label="Rectangle"]');
  const box = await win.locator('.pdfViewer .page[data-page-number="1"]').boundingBox();
  await win.mouse.move(box.x + 120, box.y + 400);
  await win.mouse.down();
  await win.mouse.move(box.x + 300, box.y + 480, { steps: 6 });
  await win.mouse.up();
  check(await waitTitle(/^• sample\.pdf/), "unsaved changes show in the window title");
  await win.keyboard.press("Escape");
  await win.keyboard.press("Control+s");
  check(await waitTitle(/^sample\.pdf — Quillmark$/), "Ctrl+S saves (the title loses its unsaved mark)");
  check(statSync(file("sample.pdf")).size !== before && (await annotTypes("sample.pdf")).includes("Square"), "the rectangle is saved into the original file on disk");

  // Ctrl+O shows the native Open dialog.
  await main(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, file("simple.pdf"));
  await win.keyboard.press("Control+o");
  check(await waitTitle(/^simple\.pdf — Quillmark$/), "Ctrl+O opens the file chosen in the Open dialog");
  await loaded();

  // Save As writes a new file through the native Save dialog, and Save then goes there.
  await main(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, file("copy.pdf"));
  await win.click(".menubar-item:has-text('File')");
  await win.click(".menu-item:has-text('Save as')");
  await win.waitForSelector(".dialog-title:has-text('Save')");
  await win.click(".dialog-footer .btn-primary");
  check(await waitTitle(/^copy\.pdf — Quillmark$/), "Save As switches the document to the new file");
  check(existsSync(file("copy.pdf")) && readFileSync(file("copy.pdf")).subarray(0, 5).toString() === "%PDF-", "Save As writes a PDF where the dialog said");

  // A file sent by the OS while the app is open (second launch, or macOS "open-file").
  await main(({ app }, path) => {
    app.emit("second-instance", {}, [process.execPath, ".", path]);
  }, file("scanned.pdf"));
  check(await waitTitle(/^scanned\.pdf — Quillmark$/), "a PDF opened from the OS while running opens in a new tab");
  await loaded();

  // OCR: WebAssembly and workers run under the app's security policy.
  await win.click(".menubar-item:has-text('Tools')");
  await win.click(".menu-item:has-text('Recognize text')");
  await win.waitForSelector(".dialog-title:has-text('Recognize')");
  await win.click(".dialog-footer .btn-primary");
  check(await win.waitForSelector(".toast:has-text('Recognized')", { timeout: 180000 }).then(() => true, () => false), "OCR runs in the desktop app");

  // Export to Word goes through the native Save dialog (answered here).
  await main(({ session }, folder) => {
    session.defaultSession.on("will-download", (_e, item) => item.setSavePath(`${folder}/${item.getFilename()}`));
  }, dir);
  await win.click('button.tools-item:has-text("Export PDF")');
  await win.waitForSelector(".dialog-title:has-text('Export')");
  await win.click(".dialog-footer .btn-primary");
  check(await win.waitForFunction(() => /Exported|Downloaded|Saved/i.test(document.querySelector(".toasts")?.textContent ?? ""), null, { timeout: 60000 }).then(() => true, () => false), "Export finishes");
  await win.waitForTimeout(1000);
  check(existsSync(file("scanned.docx")) && readFileSync(file("scanned.docx")).subarray(0, 2).toString() === "PK", "Export to Word saves a .docx file");

  // Links open in the default browser, never inside the app.
  await main(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => void globalThis.__opened.push(url);
  });
  await win.evaluate(() => window.open("https://example.com/", "_blank", "noopener"));
  await win.waitForTimeout(500);
  check((await main(() => globalThis.__opened)).includes("https://example.com/"), "web links open in the default browser");
  check(app.windows().length === 1, "no extra windows are opened");

  // Recent files reopen from disk.
  await win.click(".doc-tab-home");
  await win.waitForSelector(".recent-card");
  const recentNames = await win.locator(".recent-card .recent-meta").allTextContents();
  check(recentNames.some((t) => t.includes("sample.pdf")), "opened files are listed in recent files");

  // Closing with unsaved changes asks first.
  await win.click(".recent-card:has-text('simple.pdf')");
  check(await waitTitle(/simple\.pdf — Quillmark$/), "a recent file reopens from disk");
  await loaded();
  await win.click('button.tools-item:has-text("Add comments")');
  await win.click('button[aria-label="Rectangle"]');
  const box2 = await win.locator('.pdfViewer .page[data-page-number="1"]').boundingBox();
  await win.mouse.move(box2.x + 100, box2.y + 200);
  await win.mouse.down();
  await win.mouse.move(box2.x + 220, box2.y + 260, { steps: 4 });
  await win.mouse.up();
  await waitTitle(/^• simple\.pdf/);
  await main(({ dialog }) => {
    globalThis.__asked = 0;
    dialog.showMessageBoxSync = () => (globalThis.__asked++, 1); // "Cancel"
  });
  await main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await win.waitForTimeout(800);
  check((await main(() => globalThis.__asked)) === 1 && app.windows().length === 1, "closing with unsaved changes asks, and Cancel keeps the window open");
  const closed = app.waitForEvent("close", { timeout: 15000 }).then(() => true, () => false);
  await main(({ dialog, BrowserWindow }) => {
    dialog.showMessageBoxSync = () => 0; // "Close without saving"
    BrowserWindow.getAllWindows()[0].close();
  });
  check(await closed, "Close without saving quits the app");
} catch (e) {
  check(false, `stopped: ${String(e.message ?? e).split("\n")[0]}`);
  await win.screenshot({ path: join(ROOT, "test-output", "shots", "desktop-stopped.png") }).catch(() => {});
}
for (const message of errors) check(false, `page error: ${message}`);
check(cspViolations.length === 0, `no security policy violations${cspViolations.length ? `: ${cspViolations.slice(0, 3).join(" | ")}` : ""}`);
await app.close().catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
