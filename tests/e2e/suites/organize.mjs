// Organize pages, insert, combine, split, crop, undo/redo.
import { readFileSync } from "node:fs";

export const title = "Organize, combine, split, crop";

export default async function run({ page, check, st, open, idle, shot, build, readPdf }) {
  const doc = () =>
    st(() => {
      const s = window.__doxxta.useApp.getState();
      const d = s.docs[s.activeId];
      return d && { name: d.name, pages: d.pages.length, rot: d.pages.map((p) => p.rotate) };
    });
  const pagesIs = (n) =>
    page
      .waitForFunction((n) => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId]?.pages.length === n; }, n, { timeout: 15000 })
      .then(() => true, () => false);

  await open("sample.pdf");
  await page.evaluate(() => window.__doxxta.runCommand("mode.organize"));
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
    await insertBlankPages(window.__doxxta.useApp.getState().activeId, 0, 1);
  });
  check(await pagesIs(6), "insert a blank page at the start");
  await page.evaluate(() => window.__doxxta.runCommand("mode.view"));

  // Combine the open files into a new document.
  const before = await st(() => window.__doxxta.useApp.getState().order.length);
  await open("simple.pdf");
  await page.evaluate(() => window.__doxxta.runCommand("file.combine"));
  await page.waitForSelector(".dialog-title:has-text('Combine')");
  await page.waitForTimeout(500);
  await page.click(".dialog-footer .btn-primary");
  await page.waitForFunction((n) => window.__doxxta.useApp.getState().order.length > n + 1, before, { timeout: 30000 }).catch(() => {});
  await idle();
  const combined = await doc();
  check(combined && combined.pages === 7, `combined document has the pages of both files (${combined?.pages})`);

  // Split into single pages → a zip download.
  await page.evaluate(() => window.__doxxta.runCommand("tool.split"));
  await page.waitForSelector(".dialog-title:has-text('Split')");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }).catch(() => null), page.click(".dialog-footer .btn-primary")]);
  check(download && download.suggestedFilename().endsWith(".zip"), `split downloads a zip (${download?.suggestedFilename()})`);

  // Crop the first page.
  await st(async () => {
    const s = window.__doxxta.useApp.getState();
    const { cropPages } = await import("/src/ops/organize.ts");
    const v = s.docs[s.activeId].pages[0].view;
    await cropPages(s.activeId, [0], { rect: [v[0] + 50, v[1] + 50, v[2] - 50, v[3] - 50] });
  });
  await idle();
  const view = await st(() => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].pages[0].view; });
  check(view && view[0] >= 49, "crop changes the visible page area");

  // A PDF with a damaged page tree (wrong counts and parents, a page without /Type).
  await open("broken-tree.pdf");
  const labels = async () => (await readPdf(await build())).text.map((t) => t.trim());
  check((await doc()).pages === 4, "all 4 pages of a PDF with a damaged page tree are shown");
  await st(async () => {
    const { movePages } = await import("/src/ops/organize.ts");
    await movePages(window.__doxxta.useApp.getState().activeId, [1], 0);
  });
  await idle();
  check((await labels()).join() === "Page 2,Page 1,Page 3,Page 4", "moving a page works on it");
  await st(async () => {
    const id = window.__doxxta.useApp.getState().activeId;
    const { insertBlankPages, duplicatePages, deletePages } = await import("/src/ops/organize.ts");
    await insertBlankPages(id, 1, 1);
    await duplicatePages(id, [4]);
    await deletePages(id, [0]);
  });
  await idle();
  const saved = await readPdf(await build());
  check(saved.text.map((t) => t.trim()).join() === ",Page 1,Page 3,Page 4,Page 4", `inserting, duplicating and deleting pages work on it (${saved.text.map((t) => t.trim() || "blank").join(", ")})`);
  check(saved.sizes.slice(2).every(([w, h]) => w === 400 && h === 400), "pages keep the size they inherited from the damaged tree");

  // A file whose page tree counts fewer pages than it has: all of them show, and Split can make a file of each.
  await open("hidden-pages.pdf");
  check((await doc()).pages === 20, "all 20 pages of a file whose page list counts only 13 are shown");
  await page.evaluate(() => window.__doxxta.runCommand("tool.split"));
  await page.waitForSelector(".dialog-title:has-text('Split')");
  await page.click(".dialog label.radio:has-text('Number of files')");
  await page.locator(".dialog input[type=number]").first().fill("20");
  check(/\b20 files\b/.test(await page.locator(".dialog-footer").innerText()), "Split can make as many files as there are pages");
  await page.locator(".dialog input[type=number]").first().fill("50");
  check(/\b20 files\b/.test(await page.locator(".dialog-footer").innerText()), "asking for more files than pages makes one file per page");
  await page.locator(".dialog input[type=number]").first().fill("6");
  await page.click(".dialog label.radio:has-text('Download as a ZIP')");
  const [zip] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }).catch(() => null), page.click(".dialog-footer .btn-primary")]);
  const entries = zip ? zipEntries(readFileSync(await zip.path())) : [];
  check(entries.length === 6, `splitting 20 pages into 6 files makes 6 files (${entries.length})`);
}

/** Names of the files in a zip archive (from its central directory). */
function zipEntries(buf) {
  const names = [];
  for (let i = buf.indexOf("PK\x01\x02"); i >= 0; i = buf.indexOf("PK\x01\x02", i + 4)) {
    const len = buf.readUInt16LE(i + 28);
    names.push(buf.subarray(i + 46, i + 46 + len).toString("utf8"));
  }
  return names;
}
