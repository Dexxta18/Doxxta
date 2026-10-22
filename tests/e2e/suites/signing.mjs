// Signature, stamp, measurement, Save As, Print, Create PDF, Preferences.
export const title = "Sign, stamp, measure, save as, print, create";

export default async function run({ page, check, st, open, shot, readPdf }) {
  const count = (kind) => st((kind) => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].annotations.filter((a) => a.kind === kind || a.role === kind).length; }, kind);
  const pageBox = () => page.locator('.pdfViewer .page[data-page-number="1"]').boundingBox();
  await open("simple.pdf");

  // Typed signature: create, then click to place.
  await page.evaluate(() => window.__doxxta.runCommand("mode.fillsign"));
  await page.waitForTimeout(300);
  await page.click(".context-toolbar .toolbar-text-btn:has-text('Sign')");
  await page.waitForSelector(".dialog-title:has-text('signature'), .dialog-title:has-text('Signature')");
  await page.fill(".dialog input[placeholder='e.g. Jane Doe']", "Ada Lovelace");
  await page.waitForTimeout(400);
  await shot("signature-dialog");
  await page.click(".dialog-footer .btn-primary");
  await page.waitForTimeout(400);
  check((await page.locator(".tool-hint").textContent())?.includes("place your signature"), "placement hint is shown");
  let b = await pageBox();
  await page.mouse.click(b.x + 300, b.y + 400);
  await page.waitForTimeout(500);
  check((await count("signature")) === 1, "typed signature is placed");
  check((await page.locator(".tool-hint").count()) === 0, "placement hint goes away after placing");

  // Stamp.
  await page.evaluate(() => window.__doxxta.runCommand("tool.stamps"));
  await page.waitForTimeout(300);
  await page.mouse.click(b.x + 200, b.y + 250);
  await page.waitForTimeout(400);
  check((await count("stamp")) === 1, "stamp is placed");

  // One drag with the distance tool makes exactly one measurement.
  await page.evaluate(() => window.__doxxta.runCommand("mode.measure"));
  await page.waitForTimeout(300);
  await page.click(".context-toolbar [data-tip*='istance'], .context-toolbar button[aria-label*='istance']");
  b = await pageBox();
  await page.mouse.move(b.x + 100, b.y + 600);
  await page.mouse.down();
  await page.mouse.move(b.x + 400, b.y + 600, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const lines = await st(() => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].annotations.filter((a) => a.kind === "line" && a.measure).map((a) => a.measure); });
  check(lines.length === 1, `one drag makes one distance measurement (${lines.length})`);
  check(lines[0]?.unit === "in" && lines[0]?.factor > 0, "measurement carries its scale and unit");
  await shot("sign-stamp-measure");

  // Save As downloads the file with the additions in it.
  await page.evaluate(() => window.__doxxta.runCommand("file.saveAs"));
  await page.waitForSelector(".dialog-title:has-text('Save')");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }).catch(() => null), page.click(".dialog-footer .btn-primary")]);
  check(!!download, `Save As downloads ${download?.suggestedFilename()}`);
  if (download) {
    const { readFile } = await import("node:fs/promises");
    const saved = await readPdf(Array.from(await readFile(await download.path())));
    check(["Stamp", "Line"].every((t) => saved.annots[0].includes(t)), `saved file has the stamp and the measurement (${saved.annots[0].join(", ")})`);
  }
  check(!(await st(() => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].dirty; })), "document is clean after saving");

  // Print renders the pages, then opens the browser's print window.
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.evaluate(() => window.__doxxta.runCommand("file.print"));
  await page.waitForSelector(".dialog-title:has-text('Print')");
  await page.click(".dialog-footer .btn-primary");
  check(await page.waitForFunction(() => window.__printed > 0, null, { timeout: 20000 }).then(() => true, () => false), "print prepares the pages and opens the print window");

  // Create a blank PDF.
  const n0 = await st(() => window.__doxxta.useApp.getState().order.length);
  await page.evaluate(() => window.__doxxta.runCommand("file.createBlank"));
  await page.waitForSelector(".dialog-title:has-text('Create')");
  await page.click(".dialog-footer .btn-primary");
  check(await page.waitForFunction((n) => window.__doxxta.useApp.getState().order.length > n, n0, { timeout: 15000 }).then(() => true, () => false), "blank PDF is created");

  await page.evaluate(() => window.__doxxta.runCommand("edit.preferences"));
  check(await page.waitForSelector(".dialog-title:has-text('Preferences')").then(() => true, () => false), "preferences open");
  await page.keyboard.press("Escape");
}
