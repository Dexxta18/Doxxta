// The phone layout (iPhone-sized, touch): bottom bar, sheets, pinch zoom, finger drawing, dialogs.
export const title = "Phone layout";
export const device = "iPhone 15";

export default async function run({ page, check, st, open, shot }) {
  const active = () => st(() => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId]; });
  // Without what Safari (the iPhone app's browser) lacks: reading a stream with `for await`, as pdf.js
  // reads a page's text, and AbortSignal.any (Safari before 17.4).
  await page.addInitScript(() => {
    delete ReadableStream.prototype.values;
    delete ReadableStream.prototype[Symbol.asyncIterator];
    delete AbortSignal.any;
  });
  await page.reload();
  await page.waitForSelector(".app");
  await open("sample.pdf");
  check(await page.locator(".phone-bar").count() === 1 && (await page.locator(".tools-panel, .right-rail, .statusbar").count()) === 0, "phones get a bottom bar instead of the side panels and status bar");
  check((await page.locator(".phone-pager span").innerText()).trim() === "1 / 6", "the bottom bar shows the page number");
  const undo = await page.locator('.context-toolbar button[aria-label^="Undo"]').boundingBox();
  check(undo && undo.x + undo.width <= 393, "Undo stays on screen");
  await shot("document");

  // Tools: a sheet over the screen; picking a tool closes it.
  await page.tap(".phone-bar-btn:has-text('Tools')");
  check(await page.locator(".phone-sheet .tools-item").count() > 15, "Tools opens the list of tools");
  await shot("tools");
  await page.tap(".phone-sheet .tools-item:has-text('Fill & Sign')");
  check((await page.locator(".phone-sheet").count()) === 0 && (await active()).mode === "fillsign", "picking a tool opens it and closes the sheet");

  // Pages: tapping a page goes to it.
  await page.tap(".phone-bar-btn:has-text('Pages')");
  await page.waitForSelector(".phone-sheet .thumb-item");
  await page.locator(".phone-sheet .thumb-item").nth(2).tap();
  await page.waitForTimeout(600);
  check((await page.locator(".phone-sheet").count()) === 0 && (await active()).view.page === 3, "tapping a page in Pages goes to it");

  // The menus are a sheet too.
  await page.tap("button[aria-label='Menu']");
  check((await page.locator(".phone-menu-title").allInnerTexts()).join(",").toUpperCase().includes("FILE,EDIT,VIEW,TOOLS,HELP"), "the menu button lists the File, Edit, View, Tools and Help menus");
  await page.tap(".phone-sheet-head button[aria-label='Close']");

  // Two fingers zoom the pages; one finger draws with a drawing tool.
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const before = (await active()).view.scale;
  await touch("touchStart", [[150, 420], [250, 420]]);
  for (let d = 100; d <= 240; d += 20) {
    await touch("touchMove", [[200 - d / 2, 420], [200 + d / 2, 420]]);
    await page.waitForTimeout(16);
  }
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
  const after = (await active()).view.scale;
  check(after > before * 1.6, `pinching zooms in (${before.toFixed(2)} → ${after.toFixed(2)})`);
  await st(() => window.__doxxta.runCommand("mode.comment"));
  await st(() => window.__doxxta.useApp.setState({ tool: "ink" }));
  await touch("touchStart", [[120, 450]]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[120 + i * 12, 450 + (i % 2) * 20]]);
    await page.waitForTimeout(16);
  }
  await touch("touchEnd", []);
  await page.waitForTimeout(500);
  check((await active()).annotations.some((a) => a.kind === "ink"), "drawing with a finger makes an ink mark");

  // Dialogs fit the screen.
  await st(() => window.__doxxta.runCommand("tool.watermark"));
  await page.waitForSelector(".dialog");
  const dialog = await page.locator(".dialog").boundingBox();
  check(dialog && dialog.x >= 0 && dialog.x + dialog.width <= 393, `dialogs fit the screen (${Math.round(dialog?.width ?? 0)} px wide)`);
  await shot("dialog");
  await page.keyboard.press("Escape");

  // Edit text: the formatting toolbar is along the bottom, not over the text.
  await st(() => window.__doxxta.runCommand("mode.edit"));
  await st(() => window.__doxxta.useApp.setState({ tool: "edit-text" }));
  await page.waitForSelector(".doxxta-text-block", { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.locator(".doxxta-text-block").nth(1).tap();
  await page.waitForSelector(".text-format-bar", { timeout: 10000 });
  const bar = await page.locator(".text-format-bar").boundingBox();
  const editor = await page.locator(".doxxta-textedit-editor").boundingBox();
  const screen = page.viewportSize();
  check(bar && editor && bar.y + bar.height >= screen.height - 2 && bar.width >= screen.width - 2 && bar.y > editor.y, "the formatting toolbar sits along the bottom of the screen");
  await shot("edit-text");

  // An on-screen keyboard (as on an iPhone, where the page isn't shrunk for it) covering the bottom 300 px.
  await page.evaluate(() => {
    const height = Object.getOwnPropertyDescriptor(VisualViewport.prototype, "height");
    Object.defineProperty(VisualViewport.prototype, "height", { configurable: true, get: () => window.innerHeight - 300 });
    window.visualViewport.dispatchEvent(new Event("resize"));
    window.__keyboardOff = () => {
      Object.defineProperty(VisualViewport.prototype, "height", height);
      window.visualViewport.dispatchEvent(new Event("resize"));
    };
  });
  await page.waitForTimeout(200);
  const raised = await page.locator(".text-format-bar").boundingBox();
  check(raised && Math.abs(raised.y + raised.height - (screen.height - 300)) <= 2, "the formatting toolbar stays above the on-screen keyboard");
  await page.evaluate(() => window.__keyboardOff());
  await page.keyboard.press("Escape");

  // Text in a picture: tapping it recognizes it and opens it, with the toolbar along the bottom.
  await open("card.pdf");
  await st(() => window.__doxxta.runCommand("mode.edit"));
  await st(() => window.__doxxta.useApp.setState({ tool: "edit-text" }));
  await page.waitForSelector(".doxxta-recognize", { timeout: 15000 });
  const offer = await page.locator(".doxxta-recognize").boundingBox();
  check(offer && offer.x >= 0 && offer.x + offer.width <= screen.width, `the offer to recognize the text fits the screen (${Math.round(offer?.width ?? 0)} px)`);
  const at = await st(() => {
    const el = [...document.querySelectorAll('.pdfViewer .page[data-page-number="1"]')].find((e) => e.getBoundingClientRect().width > 0);
    const r = el.getBoundingClientRect();
    const k = r.width / 504;
    return { x: r.left + 290 * k, y: r.top + (288 - 169) * k };
  });
  await page.touchscreen.tap(at.x, at.y);
  await page.waitForSelector(".doxxta-textedit-editor", { timeout: 60000 });
  check((await page.locator(".doxxta-textedit-editor").innerText()) === "NAFOWA HALL," && (await page.locator(".text-format-bar.is-docked").count()) === 1, "tapping text in a picture opens it, with the toolbar along the bottom");
  await shot("picture-text");
  // Done: the line is written in the page, as the page's own text.
  await st(() => (document.querySelector(".doxxta-textedit-editor").innerText = "GRAND HALL,"));
  await page.tap('.text-format-bar [aria-label="Done"]');
  const own = await page.waitForSelector(".doxxta-text-block:not(.is-seen)", { timeout: 30000 }).then(() => true, () => false);
  check(own, "the edited line is then the page's own text");
}
