// Edit text, bookmarks, document properties, search panel, comments panel, dark theme.
export const title = "Edit text, bookmarks, properties, search, comments";

export default async function run({ page, check, st, open, shot, build, readPdf }) {
  const version = () => st(() => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].version; });
  /** Clicks the paragraph containing `containing` in Edit text mode, changes its text and commits. */
  const editText = async (containing, change) => {
    const spans = page.locator('.pdfViewer .page[data-page-number="1"] .textLayer span', { hasText: containing });
    let box = null;
    for (let i = 0; i < (await spans.count()) && !box; i++) {
      const b = await spans.nth(i).boundingBox();
      if (b && b.width > 2) box = b;
    }
    if (!box) throw new Error(`No text "${containing}" on the page`);
    await page.evaluate(() => window.__doxxta.runCommand("mode.edit"));
    await page.click('.context-toolbar button[aria-label="Edit text"], .context-toolbar [data-tip="Edit text"]').catch(() => {});
    await page.waitForSelector(".doxxta-text-block", { timeout: 15000 });
    const v0 = await version();
    await page.mouse.click(box.x + 4, box.y + box.height / 2);
    await page.waitForSelector(".doxxta-textedit-editor");
    await page.evaluate((text) => (document.querySelector(".doxxta-textedit-editor").innerText = text), change(await page.locator(".doxxta-textedit-editor").innerText()));
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction((v0) => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].version > v0 && !s.busy; }, v0, { timeout: 30000 });
    // Leave Edit text mode, so the next paragraph is found in the refreshed text layer.
    await page.evaluate(() => window.__doxxta.runCommand("mode.view"));
    await page.waitForTimeout(800);
  };
  /** Clicks the paragraph containing `containing` in Edit text mode, runs `actions` in the editor and commits. */
  const formatText = async (containing, actions, { commit = true } = {}) => {
    const box = await page.locator('.pdfViewer .page[data-page-number="1"] .textLayer span', { hasText: containing }).first().boundingBox();
    await page.evaluate(() => window.__doxxta.runCommand("mode.edit"));
    await page.click('.context-toolbar button[aria-label="Edit text"], .context-toolbar [data-tip="Edit text"]').catch(() => {});
    await page.waitForSelector(".doxxta-text-block", { timeout: 15000 });
    const v0 = await version();
    await page.mouse.click(box.x + 3, box.y + box.height / 2);
    await page.waitForSelector(".text-format-bar");
    await actions();
    if (commit) {
      await page.keyboard.press("Control+Enter");
      await page.waitForFunction((v0) => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].version > v0 && !s.busy; }, v0, { timeout: 30000 });
    } else await page.keyboard.press("Escape");
    await page.evaluate(() => window.__doxxta.runCommand("mode.view"));
    await page.waitForTimeout(800);
  };
  /** Selects the first `word` in the editor. */
  const select = (word) =>
    page.evaluate((word) => {
      const root = document.querySelector(".doxxta-textedit-editor");
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.nodeValue.search(new RegExp(`\\b${word}\\b`));
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + word.length);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        return;
      }
      throw new Error(`No "${word}" in the editor`);
    }, word);
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
  await page.evaluate(() => window.__doxxta.runCommand("mode.edit"));
  await page.click('.context-toolbar button[aria-label="Edit text"], .context-toolbar [data-tip="Edit text"]').catch(() => {});
  await page.waitForSelector(".doxxta-text-block", { timeout: 15000 });
  const v0 = await version();
  const paragraph = await page.locator(".doxxta-text-block").nth(1).boundingBox();
  await page.locator(".doxxta-text-block").nth(1).click();
  await page.waitForSelector(".doxxta-textedit-editor");
  // Its lines are as far apart as the page's: the editor is as tall as the paragraph.
  const opened = await page.locator(".doxxta-textedit-editor").boundingBox();
  check(opened.height <= paragraph.height * 1.1 + 2, `the editor's lines are spaced as the paragraph's (${Math.round(opened.height)} px for ${Math.round(paragraph.height)} px)`);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("This paragraph was rewritten in Doxxta.");
  await page.keyboard.press("Control+Enter");
  const changed = await page.waitForFunction((v0) => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].version > v0 && !s.busy; }, v0, { timeout: 30000 }).then(() => true, () => false);
  check(changed, "text edit changes the page");
  await shot("edit-text");

  // Bookmark and title.
  await st(async () => {
    const s = window.__doxxta.useApp.getState();
    const { setOutline, loadOutline } = await import("/src/core/outline.ts");
    const outline = await loadOutline(s.activeId);
    await setOutline(s.activeId, [...outline, { id: "bm-test", title: "Added in Doxxta", pageId: s.docs[s.activeId].pages[2].id, top: null, children: [], open: false }], "Add bookmark");
  });
  await page.evaluate(() => window.__doxxta.runCommand("file.properties"));
  await page.waitForSelector(".dialog-title:has-text('Properties'), .dialog-title:has-text('Document properties')");
  await page.locator(".dialog input").first().fill("Doxxta test title");
  await page.click(".dialog-footer .btn-primary");
  await page.waitForTimeout(400);

  // The saved file has the new text (and not the old), the bookmark and the title.
  const saved = await readPdf(await build());
  check(saved.text[0].includes("rewritten in Doxxta"), "edited text is written into the page");
  check(!saved.text[0].includes("The quick brown fox"), "replaced text is gone from the page");
  check(saved.text.length === 6 && saved.text[1].length > 100, "other pages keep their content");
  check(saved.outline.includes("Added in Doxxta"), "bookmark is saved");
  check(saved.title === "Doxxta test title", "title is saved in the document properties");

  // Search panel.
  await page.evaluate(() => window.__doxxta.useSettings.getState().set({ rightPanel: "search" }));
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

  // Text typed into light text stays light (the font isn't installed, the closest one is used).
  await open("light.pdf");
  await formatText("Fun fun", async () => {
    await page.keyboard.press("End");
    await page.keyboard.type(" kbksjvb");
  });
  let items = await textItems(page, await build());
  check(/Inter-LightItalic/.test(items.find((i) => i.str.includes("kbksjvb"))?.font ?? ""), `new text keeps the light italic weight (${items.find((i) => i.str.includes("kbksjvb"))?.font})`);
  check(/HelveticaNeue-LightItalic/.test(items.find((i) => i.str.includes("Fun fun fun."))?.font ?? ""), "the rest of the line keeps the document's font");

  // Word-style formatting: shortcuts and the toolbar.
  await formatText("Lorem ipsum", async () => {
    await select("Lorem");
    await page.keyboard.press("Control+Shift+Period");
    await page.keyboard.press("Control+Shift+Period");
    await select("ipsum");
    await page.keyboard.press("Control+i");
    await page.keyboard.press("Control+u");
    await select("dolor");
    await page.keyboard.press("Control+b");
    await select("amet");
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Control+z");
    await select("Integer");
    await page.click('.text-format-bar button[aria-label="Font color"]');
    await page.click('.popover .swatch[aria-label="#c00000"]');
    await select("posuere");
    await page.click('.text-format-bar button[aria-label="Highlight color"]');
    await page.click('.popover .swatch[aria-label="#ffd400"]');
    await select("venenatis");
    await page.selectOption(".text-format-font", "Playfair Display");
    check(await page.locator(".text-format-font").inputValue() === "Playfair Display", "the toolbar shows the font of the selection");
  });
  await formatText("Sample PDF", () => page.keyboard.press("Control+e"));
  await shot("format-text");
  const bytes = await build();
  items = await textItems(page, bytes);
  const item = (word) => items.find((i) => i.str.split(/\s+/).includes(word) || i.str === word);
  check(Math.abs(item("Lorem")?.size - 14) < 0.01 && Math.abs(item("dapibus")?.size - 11) < 0.01, `Ctrl+Shift+> makes text bigger, a size at a time (${item("Lorem")?.size})`);
  check(/Italic/.test(item("ipsum")?.font ?? "") && !/Italic/.test(item("dolor")?.font ?? ""), "Ctrl+I makes text italic");
  check(/Bold/.test(item("dolor")?.font ?? "") && !/Bold/.test(item("amet,")?.font ?? ""), "Ctrl+B makes text bold, and Ctrl+Z in the editor undoes it");
  check(/PlayfairDisplay/.test(item("venenatis")?.font ?? ""), `the font menu changes the font (${item("venenatis")?.font})`);
  const heading = item("Sample");
  check(heading && Math.abs(heading.x + heading.width / 2 - 305) < 1.5, `Ctrl+E centers a line on the page (${heading && heading.x + heading.width / 2})`);
  const marks = await page.evaluate(async ({ bytes, integer, posuere }) => {
    const { openPdf, pdfjs } = await import("/src/lib/pdfjs.ts");
    const { sampleRegionColors } = await import("/src/lib/colorSample.ts");
    const { pdf } = await openPdf(new Uint8Array(bytes));
    const ops = await (await pdf.getPage(1)).getOperatorList();
    const paths = ops.fnArray.filter((f) => f === pdfjs.OPS.constructPath).length;
    const red = await sampleRegionColors(pdf, 0, integer);
    const yellow = await sampleRegionColors(pdf, 0, posuere);
    await pdf.loadingTask.destroy();
    return { paths, red: red.foreground, yellow: yellow.background };
  }, { bytes, integer: wordRect(item("Integer"), "Integer"), posuere: wordRect(item("posuere"), "posuere") });
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r, g, b] = rgb(marks.red);
  check(r > 150 && g < 60 && b < 60, `the font color is applied (${marks.red})`);
  const [hr, hg, hb] = rgb(marks.yellow);
  check(hr > 200 && hg > 170 && hb < 100, `the highlight is drawn behind the text (${marks.yellow})`);
  check(marks.paths >= 2, `underline and highlight are drawn (${marks.paths} shapes)`);

  // Opened again, the editor shows the paragraph's fonts, sizes, weights and colors as they are on the page.
  await formatText("Lorem", async () => {
    await page.waitForTimeout(500);
    const shown = await page.evaluate(() => {
      const span = (word) => [...document.querySelectorAll(".doxxta-textedit-editor span")].find((s) => s.textContent.includes(word));
      const css = (word) => getComputedStyle(span(word));
      return { lorem: css("Lorem").fontSize, dolor: css("dolor").fontWeight, integer: css("Integer").color, venenatis: css("venenatis").fontFamily };
    });
    check(shown.lorem === "14px" && shown.dolor === "700" && shown.integer === "rgb(192, 0, 0)" && /g_d\d+_f\d+/.test(shown.venenatis), `the editor shows the text's own formatting (${JSON.stringify(shown)})`);
  }, { commit: false });

  // Comments made in other apps are listed.
  await open("annotated.pdf");
  await page.evaluate(() => window.__doxxta.useSettings.getState().set({ rightPanel: "comments" }));
  await page.waitForTimeout(1200);
  const cards = await page.locator(".comments-list .comment-head").count();
  check(cards >= 4, `comments panel lists the file's comments (${cards})`);
  await shot("comments");

  await page.evaluate(() => window.__doxxta.useSettings.getState().set({ theme: "dark" }));
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.documentElement.dataset.theme === "dark" || document.documentElement.classList.contains("dark")), "dark theme applies");
  await shot("dark-theme");
  await page.evaluate(() => window.__doxxta.useSettings.getState().set({ theme: "light" }));
}

/** Text items of page 1 of a PDF (pdf.js): text, font name, size and position. */
function textItems(page, bytes) {
  return page.evaluate(async (bytes) => {
    const { openPdf } = await import("/src/lib/pdfjs.ts");
    const { pdf } = await openPdf(new Uint8Array(bytes));
    const p = await pdf.getPage(1);
    await p.getOperatorList();
    const items = (await p.getTextContent()).items
      .filter((it) => it.str.trim())
      .map((it) => ({ str: it.str, font: p.commonObjs.has(it.fontName) ? (p.commonObjs.get(it.fontName).name ?? "") : "", size: Math.hypot(it.transform[0], it.transform[1]), x: it.transform[4], y: it.transform[5], width: it.width }));
    await pdf.loadingTask.destroy();
    return items;
  }, bytes);
}

/** About the middle of a word of a text item (PDF coordinates), by its share of the item's characters. */
function wordRect(it, word) {
  const at = it.str.indexOf(word);
  const x0 = it.x + (it.width * at) / it.str.length;
  const w = (it.width * word.length) / it.str.length;
  return [x0 + w * 0.25, it.y, x0 + w * 0.75, it.y + it.size * 0.6];
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
