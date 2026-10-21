// Organize pages, insert, combine, split, crop, undo/redo.
export const title = "Organize, combine, split, crop";

export default async function run({ page, check, st, open, idle, shot }) {
  const doc = () =>
    st(() => {
      const s = window.__folio.useApp.getState();
      const d = s.docs[s.activeId];
      return d && { name: d.name, pages: d.pages.length, rot: d.pages.map((p) => p.rotate) };
    });
  const pagesIs = (n) =>
    page
      .waitForFunction((n) => { const s = window.__folio.useApp.getState(); return s.docs[s.activeId]?.pages.length === n; }, n, { timeout: 15000 })
      .then(() => true, () => false);

  await open("sample.pdf");
  await page.evaluate(() => window.__folio.runCommand("mode.organize"));
  await page.waitForSelector(".org-item");
  check((await page.locator(".org-item").count()) === 6, "organize grid shows 6 pages");
  await page.hover(".org-item >> nth=1");
  await page.click(".org-item >> nth=1 >> button[aria-label='Rotate right']");
  await idle();
  check((await doc()).rot[1] === 90, "rotate page 2 right");
  await page.hover(".org-item >> nth=5");
  await page.click(".org-item >> nth=5 >> button[aria-label='Delete page']");
  await idle();
  check((await doc()).pages === 5, "delete page 6");
  await shot("organize");
  await page.keyboard.press("Control+z");
  check(await pagesIs(6), "undo (Ctrl+Z) restores the page");
  await page.keyboard.press("Control+Shift+z");
  check(await pagesIs(5), "redo (Ctrl+Shift+Z) deletes it again");
  await st(async () => {
    const { insertBlankPages } = await import("/src/ops/organize.ts");
    await insertBlankPages(window.__folio.useApp.getState().activeId, 0, 1);
  });
  check(await pagesIs(6), "insert a blank page at the start");
  await page.evaluate(() => window.__folio.runCommand("mode.view"));

  // Combine the open files into a new document.
  const before = await st(() => window.__folio.useApp.getState().order.length);
  await open("simple.pdf");
  await page.evaluate(() => window.__folio.runCommand("file.combine"));
  await page.waitForSelector(".dialog-title:has-text('Combine')");
  await page.waitForTimeout(500);
  await page.click(".dialog-footer .btn-primary");
  await page.waitForFunction((n) => window.__folio.useApp.getState().order.length > n + 1, before, { timeout: 30000 }).catch(() => {});
  await idle();
  const combined = await doc();
  check(combined && combined.pages === 7, `combined document has the pages of both files (${combined?.pages})`);

  // Split into single pages → a zip download.
  await page.evaluate(() => window.__folio.runCommand("tool.split"));
  await page.waitForSelector(".dialog-title:has-text('Split')");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }).catch(() => null), page.click(".dialog-footer .btn-primary")]);
  check(download && download.suggestedFilename().endsWith(".zip"), `split downloads a zip (${download?.suggestedFilename()})`);

  // Crop the first page.
  await st(async () => {
    const s = window.__folio.useApp.getState();
    const { cropPages } = await import("/src/ops/organize.ts");
    const v = s.docs[s.activeId].pages[0].view;
    await cropPages(s.activeId, [0], { rect: [v[0] + 50, v[1] + 50, v[2] - 50, v[3] - 50] });
  });
  await idle();
  const view = await st(() => { const s = window.__folio.useApp.getState(); return s.docs[s.activeId].pages[0].view; });
  check(view && view[0] >= 49, "crop changes the visible page area");
}
