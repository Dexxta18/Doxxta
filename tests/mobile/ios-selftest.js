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
  /** Waits (up to 15 s) for the shell script to take a screenshot. */
  const shot = async (name) => {
    await write(name, "");
    for (const end = Date.now() + 15_000; Date.now() < end; await wait(250)) {
      try {
        await files("stat", name);
      } catch {
        return;
      }
    }
  };
  const button = (label) => $$(".phone-bar-btn").find((b) => b.textContent.includes(label));

  try {
    await until(() => $(".app"), 30_000);
    await wait(2000);
    check(window.Capacitor?.getPlatform?.() === "ios", "the app runs in its native shell");
    check(!!$(".home-hero"), "the home screen shows");
    await shot("ios-home");

    // Open a PDF the way the other tests do (a dropped file).
    const bytes = new Uint8Array(await (await fetch("sample.pdf")).arrayBuffer());
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "sample.pdf", { type: "application/pdf" }));
    $(".main").dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    $(".main").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
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
    check(errors.length === 0, `no script errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  } catch (e) {
    failed++;
    log(`✗ stopped: ${e?.stack ?? e}`);
    await shot("ios-stopped");
  }
  await write("results.txt", lines.filter((line) => /^[✓✗]/.test(line)).join("\n"));
  await write("done", String(failed));
  log(`done ${failed}`);
})();
