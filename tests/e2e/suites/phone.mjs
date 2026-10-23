// The phone layout (iPhone-sized, touch): bottom bar, sheets, pinch zoom, finger drawing, dialogs.
export const title = "Phone layout";
export const device = "iPhone 15";

export default async function run({ page, check, st, open, shot }) {
  const active = () => st(() => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId]; });
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
}
