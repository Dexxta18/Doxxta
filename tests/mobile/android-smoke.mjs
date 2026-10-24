// The Android app on a phone (an emulator in GitHub Actions: .github/workflows/phone-check.yml):
// installs the APK, starts it, opens a PDF in it and goes through the phone layout, checking what
// the app's web view shows. Screenshots go to test-output/mobile. In GitHub Actions the results,
// and what the app showed and logged when something failed, are also notes on the run's page.
// Run: node tests/mobile/android-smoke.mjs path/to/app.apk (needs adb and a running device).
import { _android as android } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, OUTPUT } from "../e2e/harness.mjs";

const apk = process.argv[2];
const shots = join(OUTPUT, "mobile");
mkdirSync(shots, { recursive: true });
const results = [];
let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${what}`);
  results.push(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failed++;
};

/** A note on the GitHub Actions run (a workflow command). */
const escape = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const note = (level, title, text) => process.env.GITHUB_ACTIONS && console.log(`::${level} title=${title}::${escape(text)}`);

const [device] = await android.devices();
if (!device) throw new Error("No Android device or emulator found (adb devices).");
console.log(`Android app on ${device.model()}`);
let page;
const shot = async (name) => {
  const png = await device.screenshot({ path: join(shots, `${name}.png`) });
  // A small copy in the run's notes, for where the run's downloads can't be reached.
  if (process.env.SCREENSHOT_NOTES && page) note("notice", `Screenshot ${name}`, await thumbnail(png).catch((e) => String(e)));
};
/** A small JPEG of a screenshot (a data: URL that fits in a note), drawn by the app's web view. */
const thumbnail = (png) =>
  page.evaluate(async (b64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    for (let width = 240; ; width -= 20) {
      canvas.width = width;
      canvas.height = Math.round((image.height * width) / image.width);
      const context = canvas.getContext("2d");
      context.filter = "grayscale(1)";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.5);
      if (url.length <= 4000 || width <= 60) return url;
    }
  }, png.toString("base64"));
let cdp;
/** Taps an element with a finger (a touch, through the web view's DevTools). */
const tap = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  cdp ??= await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
/** The app's page as it shows on the screen (a web view left from an earlier start can linger, with no size). */
async function appPage() {
  for (const end = Date.now() + 90_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 1000))) {
    for (const webView of await device.webViews()) {
      if (webView.pkg() !== "app.doxxta.mobile") continue;
      for (const candidate of (await webView.page()).context().pages()) {
        if (await candidate.evaluate(() => innerWidth > 0 && !!document.querySelector(".app")).catch(() => false)) return candidate;
      }
    }
  }
  throw new Error("The app's page didn't show up on the screen.");
}
/** Opens a test PDF as a dropped file. */
const drop = (name) =>
  page.evaluate(
    ({ b64, name }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "application/pdf" }));
      const target = document.querySelector(".main");
      target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { b64: readFileSync(join(FIXTURES, name)).toString("base64"), name },
  );
/** Taps a point of the first page, given in PDF points. */
const tapPage = async (x, y) => {
  const at = await page.evaluate(([x, y]) => {
    // The shown document's page (another document's viewer may be kept, hidden).
    const el = [...document.querySelectorAll('.pdfViewer .page[data-page-number="1"]')].find((e) => e.getBoundingClientRect().width > 0);
    const r = el.getBoundingClientRect();
    const s = r.width / 504;
    return { x: r.left + x * s, y: r.top + (288 - y) * s };
  }, [x, y]);
  cdp ??= await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
/**
 * Closes other apps' "… isn't responding" dialogs, which take the Back key (slow emulators show them
 * for the launcher, sometimes before the setting that hides them is made).
 */
const closeDialogs = async () => {
  for (let i = 0; i < 3; i++) {
    const focus = (await device.shell("dumpsys window | grep mCurrentFocus").catch(() => "")).toString();
    const stuck = focus.match(/Application (?:Not Responding|Error): ([\w.]+)/)?.[1];
    if (!stuck) return;
    results.push(`· a dialog said ${stuck} isn't responding`);
    if (stuck === "app.doxxta.mobile") return;
    await device.shell(`am force-stop ${stuck}`).catch(() => {});
    await page.waitForTimeout(1000);
  }
};
let webViewVersion = "";
const errors = [];
const logged = [];
try {
  await device.shell("pm uninstall app.doxxta.mobile").catch(() => {});
  await device.installApk(readFileSync(apk));
  await device.shell("logcat -c").catch(() => {});
  // No "… isn't responding" dialogs (slow emulators show them for the launcher): they take the Back key.
  await device.shell("settings put global hide_error_dialogs 1").catch(() => {});
  await device.shell("input keyevent KEYCODE_WAKEUP");
  await device.shell("wm dismiss-keyguard").catch(() => {});
  await device.shell("am start -W -n app.doxxta.mobile/.MainActivity");
  page = await appPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && logged.push(`${m.type()}: ${m.text()}`));
  await page.waitForSelector(".app", { timeout: 90_000 });
  webViewVersion = await page.evaluate(() => navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent);
  await page.waitForTimeout(1500);
  await shot("home");
  check(await page.evaluate(() => !!window.Capacitor?.isNativePlatform?.()), "the app runs in its native shell");
  check(await page.locator(".home-hero").count() === 1, "the home screen shows");

  // Open a PDF the way the browser tests do (a dropped file).
  await drop("sample.pdf");
  const opened = await page.waitForSelector('.pdfViewer .page[data-loaded="true"]', { state: "attached", timeout: 60_000 }).then(() => true, () => false);
  check(opened, "a PDF opens");
  if (!opened) throw new Error("The PDF didn't open, so the rest can't be checked.");
  // Drawn: the first page's canvas has the page's (dark) text on it.
  const drawn = await page
    .waitForFunction(
      () => {
        const canvas = document.querySelector(".pdfViewer .page canvas");
        if (!canvas?.width) return false;
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = 0;
        for (let i = 0; i < pixels.length; i += 64) if (pixels[i] < 128) dark++;
        return dark > 100;
      },
      null,
      { timeout: 30_000, polling: 500 },
    )
    .then(() => true, () => false);
  check(drawn, "its first page is drawn");
  const shown = await page.evaluate(() => {
    const box = document.querySelector(".pdfViewer .page canvas")?.getBoundingClientRect();
    return box ? [Math.round(box.width), Math.round(box.height)] : [0, 0];
  });
  check(shown[0] > 200 && shown[1] > 200, `the page is shown at its size (${shown.join("×")})`);
  await page.waitForTimeout(1500);
  await shot("document");
  check(await page.locator(".phone-bar").count() === 1, "the phone layout is used (bottom bar)");
  check((await page.locator(".phone-pager span").innerText()).trim() === "1 / 6", "the bottom bar shows the page number");

  await tap(page.locator(".phone-bar-btn", { hasText: "Tools" }));
  await page.waitForFunction(() => document.querySelector(".phone-sheet")?.getAnimations({ subtree: true }).every((a) => a.playState !== "running"));
  await page.waitForTimeout(1000);
  await shot("tools");
  check(await page.locator(".phone-sheet .tools-item").count() > 10, "the tools sheet lists the tools");
  await tap(page.locator(".phone-sheet .tools-item", { hasText: "Add comments" }));
  await page.waitForTimeout(800);
  check((await page.locator(".mode-chip").innerText()).includes("Comment"), "picking a tool opens it");
  await shot("comment");

  await tap(page.locator(".phone-bar-btn", { hasText: "Pages" }));
  const thumbnails = await page
    .waitForFunction(() => [...document.querySelectorAll(".phone-sheet .thumb-item img")].filter((i) => i.complete && i.naturalWidth > 0).length >= 4, null, { timeout: 30_000, polling: 500 })
    .then(() => true, () => false);
  check(thumbnails, "the Pages sheet draws the pages");
  await page.waitForTimeout(500);
  await shot("pages");
  await tap(page.locator(".phone-sheet .thumb-item").nth(3));
  await page.waitForTimeout(1200);
  check((await page.locator(".phone-pager span").innerText()).trim() === "4 / 6", "tapping a page goes to it");

  // Android's Back button: closes the tool, then the document.
  await closeDialogs();
  await device.shell("input keyevent KEYCODE_BACK");
  await page.waitForTimeout(800);
  check(await page.locator(".mode-chip").count() === 0, "Back closes the tool");
  await closeDialogs();
  await device.shell("input keyevent KEYCODE_BACK");
  await page.waitForTimeout(800);
  check(await page.locator(".home-hero").count() === 1, "Back again goes to the home screen");
  await shot("back-home");

  // Text that's part of a picture (an invitation whose letters are outlines): recognized, then edited.
  await drop("card.pdf");
  await page.waitForFunction(() => document.querySelector(".phone-pager span")?.textContent.trim() === "1 / 1", null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await tap(page.locator(".phone-bar-btn", { hasText: "Tools" }));
  await page.waitForTimeout(1000);
  await tap(page.locator(".phone-sheet .tools-item", { hasText: "Edit PDF" }));
  await page.waitForTimeout(1000);
  const editTool = page.locator('.context-toolbar [aria-label="Edit text"]').first();
  if ((await editTool.getAttribute("aria-pressed")) !== "true") await tap(editTool);
  const offered = await page.waitForSelector(".doxxta-recognize", { timeout: 30_000 }).then(() => true, () => false);
  check(offered, "a page whose text is in a picture offers to recognize it");
  await shot("picture-offer");
  await tapPage(290, 169);
  const recognized = await page.waitForSelector(".doxxta-textedit-editor", { timeout: 180_000 }).then(() => true, () => false);
  const seenText = recognized ? await page.locator(".doxxta-textedit-editor").innerText() : "";
  check(seenText === "NAFOWA HALL,", `tapping text in a picture recognizes it (OCR) and opens it (${JSON.stringify(seenText)})`);
  await page.waitForTimeout(1000);
  await shot("picture-editing");
  await page.evaluate(() => (document.querySelector(".doxxta-textedit-editor").innerText = "GRAND HALL,"));
  await tap(page.locator('.text-format-bar [aria-label="Done"]'));
  // Written: the line is the page's own text, no longer one seen in the picture (or a message says why not).
  const written = await page
    .waitForFunction(() => document.querySelector(".doxxta-text-block:not(.is-seen)") || document.querySelector(".toast"), null, { timeout: 120_000, polling: 500 })
    .then(() => true, () => false);
  const toasts = await page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent));
  check(written && !toasts.length, `the edit is written in the page (${toasts.join(" | ") || (written ? "no message" : "timed out")})`);
  await page.waitForTimeout(1500);
  await tapPage(290, 169);
  const again = await page.waitForSelector(".doxxta-textedit-editor", { timeout: 30_000 }).then(() => page.locator(".doxxta-textedit-editor").innerText(), () => "");
  check(again === "GRAND HALL,", `the edit is written as the page's text (edited again: ${JSON.stringify(again)})`);
  await shot("picture-edited");
  check(errors.length === 0, `no script errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} catch (e) {
  failed++;
  results.push(`✗ stopped: ${e?.stack ?? e}`);
  console.error(e);
  await shot("stopped").catch(() => {});
} finally {
  if (failed) {
    // What the app showed and logged, for finding out why without the screenshots.
    const state = await page
      ?.evaluate(() => ({
        address: location.href,
        screen: `${innerWidth}×${innerHeight}`,
        text: document.body.innerText.replace(/\s+/g, " ").slice(0, 600),
        toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent),
        pages: [...document.querySelectorAll(".pdfViewer .page")].map((p) => p.getAttribute("data-loaded") ?? "-").join(" "),
        canvases: [...document.querySelectorAll(".pdfViewer .page")].slice(0, 2).map((p) =>
          [...p.querySelectorAll("canvas")].map((c) => {
            const r = c.getBoundingClientRect();
            const style = getComputedStyle(c);
            return `${c.className || "canvas"} ${c.width}×${c.height} shown ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)} ${style.display} ${style.visibility} opacity ${style.opacity}`;
          }).join("; ") || `none (${p.innerHTML.slice(0, 300)})`,
        ),
      }))
      .catch((e) => ({ unavailable: String(e) }));
    const logcat = await device.shell("logcat -d -t 400").then((b) => b.toString(), () => "");
    const appLines = logcat.split("\n").filter((l) => /Capacitor|chromium|AndroidRuntime|doxxta| E /.test(l)).slice(-60);
    note("error", "Android app check failed", [
      ...results.filter((r) => r.startsWith("✗")),
      `Web view: ${webViewVersion || "not reached"}`,
      `Page: ${JSON.stringify(state ?? "not reached", null, 1)}`,
      `Script errors: ${errors.join(" | ") || "none"}`,
      `Console: ${logged.slice(-15).join("\n") || "nothing"}`,
      "Logcat:",
      ...appLines,
    ].join("\n").slice(0, 30_000));
  }
  note("notice", "Android app check", [`On ${device.model()}, ${webViewVersion || "web view not reached"}`, ...results].join("\n"));
  await device.close();
}
console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
