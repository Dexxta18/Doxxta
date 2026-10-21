// Edit text, bookmarks, document properties, search panel, comments panel, dark theme.
export const title = "Edit text, bookmarks, properties, search, comments";

export default async function run({ page, check, st, open, shot, build, readPdf }) {
  const version = () => st(() => { const s = window.__quillmark.useApp.getState(); return s.docs[s.activeId].version; });
  /** Clicks the paragraph containing `containing` in Edit text mode, changes its text and commits. */
  const editText = async (containing, change) => {
    const spans = page.locator('.pdfViewer .page[data-page-number="1"] .textLayer span', { hasText: containing });
    let box = null;
    for (let i = 0; i < (await spans.count()) && !box; i++) {
      const b = await spans.nth(i).boundingBox();
      if (b && b.width > 2) box = b;
    }
    if (!box) throw new Error(`No text "${containing}" on the page`);
    await page.evaluate(() => window.__quillmark.runCommand("mode.edit"));
    await page.click('.context-toolbar button[aria-label="Edit text"], .context-toolbar [data-tip="Edit text"]').catch(() => {});
    await page.waitForSelector(".quillmark-text-block", { timeout: 15000 });
    const v0 = await version();
    await page.mouse.click(box.x + 4, box.y + box.height / 2);
    await page.waitForSelector(".quillmark-textedit-editor");
    await page.evaluate((text) => (document.querySelector(".quillmark-textedit-editor").innerText = text), change(await page.locator(".quillmark-textedit-editor").innerText()));
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction((v0) => { const s = window.__quillmark.useApp.getState(); return s.docs[s.activeId].version > v0 && !s.busy; }, v0, { timeout: 30000 });
    // Leave Edit text mode, so the next paragraph is found in the refreshed text layer.
    await page.evaluate(() => window.__quillmark.runCommand("mode.view"));
    await page.waitForTimeout(800);
  };
  await open("sample.pdf");

  // Ctrl+C on selected page text is left to the browser's copy (not swallowed by shortcuts).
  const span = await page.locator('.pdfViewer .page[data-page-number="1"] .textLayer span').nth(1).boundingBox();
  await page.mouse.move(span.x + 2, span.y + span.height / 2);
  await page.mouse.down();
  await page.mouse.move(span.x + span.width * 0.5, span.y + span.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.evaluate(() => window.addEventListener("keydown", (e) => (window.__copyKeyBlocked = e.key === "c" && e.defaultPrevented)));
  await page.keyboard.press("Control+c");
  check((await page.evaluate(() => window.__copyKeyBlocked)) === false && (await page.evaluate(() => String(document.getSelection()).length > 10)), "Ctrl+C on selected page text isn't blocked");

  // Rewrite the first body paragraph, typing in the editor.
  await page.evaluate(() => window.__quillmark.runCommand("mode.edit"));
  await page.click('.context-toolbar button[aria-label="Edit text"], .context-toolbar [data-tip="Edit text"]').catch(() => {});
  await page.waitForSelector(".quillmark-text-block", { timeout: 15000 });
  const v0 = await version();
  await page.locator(".quillmark-text-block").nth(1).click();
  await page.waitForSelector(".quillmark-textedit-editor");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("This paragraph was rewritten in Quillmark.");
  await page.keyboard.press("Control+Enter");
  const changed = await page.waitForFunction((v0) => { const s = window.__quillmark.useApp.getState(); return s.docs[s.activeId].version > v0 && !s.busy; }, v0, { timeout: 30000 }).then(() => true, () => false);
  check(changed, "text edit changes the page");
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

  // Edits keep the formatting of a CV made in an office suite (embedded font subsets).
  await open("cv.pdf");
  const before = await layout(page, await build());
  await editText("Financial Analyst, Business", (t) => `${t} (Promoted)`);
  await editText("Build monthly forecasts", (t) => t.replace("four business", "five business"));
  await editText("Worked with finance", (t) => t.replace("sales and operations", "sales, procurement and operations"));
  await editText("Languages:", (t) => t.replace("English (native)", "UK English (native)"));
  await shot("edit-cv");
  const after = await layout(page, await build());
  const line = (lines, re) => lines.find((l) => re.test(l.text));
  const title = line(after, /Business Planning/);
  check(/Business Planning \(Promoted\)\s+Feb 2022 to Mar 2025/.test(title?.text ?? ""), "added words join their line, in reading order");
  check(title?.runs.find((r) => r.str.includes("Promoted"))?.bold === true, "added words take the bold of the title");
  const date = (lines) => line(lines, /Business Planning/).runs.find((r) => r.str.includes("2025"));
  check(Math.abs(date(after).right - date(before).right) < 0.5, "the date beside the title stays right-aligned where it was");
  check(line(after, /^across five business units\.$/) && Math.abs(line(after, /^across five/).x - line(before, /^across four/).x) < 0.1, "a change on a paragraph's second line leaves its first line as it was");
  const unchanged = ["Northwind Traders", "Contoso Group", "Redesigned planning", "Supported operating", "Tools:"].every((t) => {
    const [a, b] = [line(after, new RegExp(t)), line(before, new RegExp(t))];
    return a && b && a.text === b.text && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  });
  check(unchanged, "lines that weren't edited stay exactly as they were");
  const para = after.filter((l) => l.y < line(after, /^Worked with/).y + 1 && l.y > line(after, /^Worked with/).y - 30);
  check(para.length === 3 && para.slice(0, 2).every((l) => Math.abs(l.right - 558) < 1) && para[2].right < 500, "a justified paragraph is reflowed and stays justified");
  const languages = line(after, /UK English/);
  check(languages?.runs.find((r) => r.str.includes("UK"))?.bold === false && languages.runs.find((r) => r.str.includes("Languages"))?.bold === true, "words typed before a regular word aren't made bold by the label before them");

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

/** Lines of page 1 of a PDF (pdf.js): text, left/right edges, baseline and runs with their font weight. */
function layout(page, bytes) {
  return page.evaluate(async (bytes) => {
    const { openPdf } = await import("/src/lib/pdfjs.ts");
    const { pdf } = await openPdf(new Uint8Array(bytes));
    const p = await pdf.getPage(1);
    await p.getOperatorList();
    const runs = (await p.getTextContent()).items
      .filter((it) => it.str.trim())
      .map((it) => {
        const name = p.commonObjs.has(it.fontName) ? (p.commonObjs.get(it.fontName).name ?? "") : "";
        return { str: it.str, x: it.transform[4], y: it.transform[5], right: it.transform[4] + it.width, bold: /bold/i.test(name) };
      });
    await pdf.loadingTask.destroy();
    const lines = [];
    for (const r of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
      const l = lines.find((l) => Math.abs(l.y - r.y) < 2);
      if (l) l.runs.push(r);
      else lines.push({ y: r.y, runs: [r] });
    }
    return lines.map((l) => {
      l.runs.sort((a, b) => a.x - b.x);
      const text = l.runs.map((r) => r.str).join(" ").replace(/\s+/g, " ").trim();
      return { text, y: l.y, x: l.runs[0].x, right: Math.max(...l.runs.map((r) => r.right)), runs: l.runs };
    });
  }, bytes);
}
