// Edit text, bookmarks, document properties, search panel, comments panel, dark theme.
export const title = "Edit text, bookmarks, properties, search, comments";

export default async function run({ page, check, st, open, shot, build, readPdf }) {
  await open("sample.pdf");

  // Rewrite the first body paragraph.
  await page.evaluate(() => window.__quillmark.runCommand("mode.edit"));
  await page.click('.context-toolbar button[aria-label="Edit text"], .context-toolbar [data-tip="Edit text"]').catch(() => {});
  await page.waitForSelector(".quillmark-text-block", { timeout: 15000 });
  await page.locator(".quillmark-text-block").nth(1).click();
  await page.waitForSelector(".quillmark-textedit-editor");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("This paragraph was rewritten in Quillmark.");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => { const s = window.__quillmark.useApp.getState(); return s.docs[s.activeId].annotations.some((a) => a.kind === "textedit"); }, null, { timeout: 5000 }).catch(() => {});
  const edits = await st(() => { const s = window.__quillmark.useApp.getState(); return s.docs[s.activeId].annotations.filter((a) => a.kind === "textedit").map((a) => a.text); });
  check(edits.length === 1 && edits[0].includes("rewritten"), "text edit is recorded");
  await shot("edit-text");

  // Bookmark and title.
  await st(async () => {
    const s = window.__quillmark.useApp.getState();
    const { setOutline, loadOutline } = await import("/src/core/outline.ts");
    const outline = await loadOutline(s.activeId);
    await setOutline(s.activeId, [...outline, { id: "bm-test", title: "Added in Quillmark", pageId: s.docs[s.activeId].pages[2].id, top: null, children: [], open: false }], "Add bookmark");
  });
  await page.evaluate(() => window.__quillmark.runCommand("file.properties"));
  await page.waitForSelector(".dialog-title:has-text('Properties'), .dialog-title:has-text('Document properties')");
  await page.locator(".dialog input").first().fill("Quillmark test title");
  await page.click(".dialog-footer .btn-primary");
  await page.waitForTimeout(400);

  // The saved file has the new text (and not the old), the bookmark and the title.
  const saved = await readPdf(await build());
  check(saved.text[0].includes("rewritten in Quillmark"), "edited text is written into the page");
  check(!saved.text[0].includes("The quick brown fox"), "replaced text is gone from the page");
  check(saved.text.length === 6 && saved.text[1].length > 100, "other pages keep their content");
  check(saved.outline.includes("Added in Quillmark"), "bookmark is saved");
  check(saved.title === "Quillmark test title", "title is saved in the document properties");

  // Search panel.
  await page.evaluate(() => window.__quillmark.useSettings.getState().set({ rightPanel: "search" }));
  await page.waitForSelector(".search-panel input", { timeout: 10000 });
  const input = page.locator(".search-panel input").first();
  await input.fill("Lorem ipsum");
  await input.press("Enter");
  await page.waitForTimeout(2500);
  const hits = await page.locator(".search-hit").count();
  check(hits > 0, `search panel finds results (${hits})`);

  // Comments made in other apps are listed.
  await open("annotated.pdf");
  await page.evaluate(() => window.__quillmark.useSettings.getState().set({ rightPanel: "comments" }));
  await page.waitForTimeout(1200);
  const cards = await page.locator(".comments-list .comment-head").count();
  check(cards >= 4, `comments panel lists the file's comments (${cards})`);
  await shot("comments");

  await page.evaluate(() => window.__quillmark.useSettings.getState().set({ theme: "dark" }));
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.documentElement.dataset.theme === "dark" || document.documentElement.classList.contains("dark")), "dark theme applies");
  await shot("dark-theme");
  await page.evaluate(() => window.__quillmark.useSettings.getState().set({ theme: "light" }));
}
