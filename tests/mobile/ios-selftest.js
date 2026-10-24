// The iPhone app's checks, run inside the app in a simulator: tests/mobile/ios-smoke.sh adds this
// script and sample.pdf to a test build of the app. They talk to the shell script through files in
// the app's Documents/selftest: a file named after a screenshot asks for it (the script deletes
// it once taken), results.txt has the results and done the number of failures. The app's log
// gets the results too ("[selftest] …").
(async () => {
  const lines = [];
  const log = (text) => {
    lines.push(text);
    console.log(`[selftest] ${text}`);
  };
  const files = (method, path, options = {}) => window.Capacitor.nativePromise("Filesystem", method, { path: `selftest/${path}`, directory: "DOCUMENTS", ...options });
  const write = (path, data) => files("writeFile", path, { data, encoding: "utf8", recursive: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  /** The first truthy result of `test` within `ms`, or null. */
  const until = async (test, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(250)) {
      try {
        const value = test();
        if (value) return value;
      } catch {
        // Not there yet.
      }
    }
    return null;
  };
  const errors = [];
  addEventListener("error", (e) => errors.push(e.message));
  addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.message ?? e.reason)));
  let failed = 0;
  const check = (ok, what) => {
    log(`${ok ? "✓" : "✗"} ${what}`);
    if (!ok) failed++;
  };
  /** Waits (up to 40 s) for the shell script to take a screenshot, and notes how long it took. */
  const shot = async (name) => {
    await write(name, "screenshot");
    const start = Date.now();
    let taken = "not taken in 40 s";
    for (const end = start + 40_000; Date.now() < end; await wait(250)) {
      try {
        await files("readFile", name, { encoding: "utf8" });
      } catch (e) {
        taken = `taken in ${((Date.now() - start) / 1000).toFixed(1)} s${Date.now() - start < 200 ? ` (${e?.message ?? e})` : ""}`;
        break;
      }
    }
    log(`· screenshot ${name} ${taken}`);
  };
  const button = (label) => $$(".phone-bar-btn").find((b) => b.textContent.includes(label));
  /** Opens a test PDF (copied into the test build) as a dropped file. */
  const drop = async (name) => {
    const bytes = new Uint8Array(await (await fetch(name)).arrayBuffer());
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: "application/pdf" }));
    $(".main").dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    $(".main").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  };
  /** Presses a point of the shown document's first page (a 504 × 288 pt card), given in PDF points. */
  const press = (x, y) => {
    const el = $$('.pdfViewer .page[data-page-number="1"]').find((e) => e.getBoundingClientRect().width > 0);
    const r = el.getBoundingClientRect();
    const s = r.width / 504;
    const [cx, cy] = [r.left + x * s, r.top + (288 - y) * s];
    document.elementFromPoint(cx, cy)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerType: "touch", isPrimary: true }));
  };

  try {
    await until(() => $(".app"), 30_000);
    await wait(2000);
    check(window.Capacitor?.getPlatform?.() === "ios", "the app runs in its native shell");
    check(!!$(".home-hero"), "the home screen shows");
    await shot("ios-home");

    // Open a PDF the way the other tests do (a dropped file).
    await drop("sample.pdf");
    check(!!(await until(() => $('.pdfViewer .page[data-loaded="true"]'), 60_000)), "a PDF opens");
    const drawn = await until(() => {
      const canvas = $(".pdfViewer .page canvas");
      if (!canvas?.width) return false;
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 64) if (pixels[i] < 128) dark++;
      return dark > 100;
    }, 30_000);
    check(!!drawn, "its first page is drawn");
    const box = $(".pdfViewer .page canvas")?.getBoundingClientRect();
    const shown = box ? [Math.round(box.width), Math.round(box.height)] : [0, 0];
    check(shown[0] > 200 && shown[1] > 200, `the page is shown at its size (${shown.join("×")})`);
    await wait(1000);
    await shot("ios-document");
    check(!!$(".phone-bar"), "the phone layout is used (bottom bar)");
    check($(".phone-pager span")?.textContent.trim() === "1 / 6", "the bottom bar shows the page number");

    button("Tools").click();
    await wait(800);
    check($$(".phone-sheet .tools-item").length > 10, "the tools sheet lists the tools");
    await shot("ios-tools");
    $$(".phone-sheet .tools-item").find((b) => b.textContent.includes("Add comments")).click();
    await wait(800);
    check(!!$(".mode-chip")?.textContent.includes("Comment"), "picking a tool opens it");

    button("Pages").click();
    const thumbnails = await until(() => $$(".phone-sheet .thumb-item img").filter((i) => i.complete && i.naturalWidth > 0).length >= 4, 30_000);
    check(!!thumbnails, "the Pages sheet draws the pages");
    await wait(500);
    await shot("ios-pages");
    $$(".phone-sheet .thumb-item")[3].click();
    await wait(1200);
    check($(".phone-pager span")?.textContent.trim() === "4 / 6", "tapping a page goes to it");

    // Text that's part of a picture (an invitation whose letters are outlines): recognized, then edited.
    await drop("card.pdf");
    await until(() => $(".phone-pager span")?.textContent.trim() === "1 / 1", 60_000);
    await wait(1500);
    button("Tools").click();
    await wait(800);
    $$(".phone-sheet .tools-item").find((b) => b.textContent.includes("Edit PDF")).click();
    await wait(1000);
    const tool = $('.context-toolbar [aria-label="Edit text"]');
    if (tool?.getAttribute("aria-pressed") !== "true") tool?.click();
    check(!!(await until(() => $(".doxxta-recognize"), 30_000)), "a page whose text is in a picture offers to recognize it");
    $(".doxxta-recognize").click();
    const found = await until(() => $$(".doxxta-text-block.is-seen").length >= 8, 180_000);
    check(!!found, `the text in the picture is recognized (OCR): ${$$(".doxxta-text-block.is-seen").length} lines`);
    await shot("ios-picture");
    press(290, 169);
    const opened = await until(() => $(".doxxta-textedit-editor"), 10_000);
    check(opened?.innerText === "NAFOWA HALL,", `tapping a recognized line opens it (${JSON.stringify(opened?.innerText)})`);
    const lines = $$(".doxxta-text-block.is-seen").length;
    opened.innerText = "GRAND HALL,";
    $('.text-format-bar [aria-label="Done"]').click();
    // Written: the line is the page's own text, no longer one seen in the picture (or a message says why not).
    const written = await until(() => $$(".doxxta-text-block.is-seen").length < lines || $(".toast"), 120_000);
    const toasts = $$(".toast").map((t) => t.textContent);
    check(!!written && !toasts.length, `the edit is written in the page (${toasts.join(" | ") || (written ? "no message" : "timed out")})`);
    await wait(1500);
    press(290, 169);
    const again = await until(() => $(".doxxta-textedit-editor"), 15_000);
    check(again?.innerText === "GRAND HALL,", `the edit is written as the page's text (edited again: ${JSON.stringify(again?.innerText)})`);
    await shot("ios-picture-edited");
    check(errors.length === 0, `no script errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  } catch (e) {
    failed++;
    log(`✗ stopped: ${e?.stack ?? e}`);
    await shot("ios-stopped");
  }
  await write("results.txt", lines.filter((line) => /^[✓✗·]/.test(line)).join("\n"));
  await write("done", String(failed));
  log(`done ${failed}`);
})();
