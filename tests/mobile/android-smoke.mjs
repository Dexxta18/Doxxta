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
const shot = (name) => device.screenshot({ path: join(shots, `${name}.png`) });
let page;
let webViewVersion = "";
const errors = [];
const logged = [];
try {
  await device.shell("pm uninstall app.doxxta.mobile").catch(() => {});
  await device.installApk(readFileSync(apk));
  await device.shell("logcat -c").catch(() => {});
  await device.shell("am start -n app.doxxta.mobile/.MainActivity");
  const webView = await device.webView({ pkg: "app.doxxta.mobile" }, { timeout: 90_000 });
  page = await webView.page();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && logged.push(`${m.type()}: ${m.text()}`));
  await page.waitForSelector(".app", { timeout: 90_000 });
  webViewVersion = await page.evaluate(() => navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent);
  await page.waitForTimeout(1500);
  await shot("home");
  check(await page.evaluate(() => !!window.Capacitor?.isNativePlatform?.()), "the app runs in its native shell");
  check(await page.locator(".home-hero").count() === 1, "the home screen shows");

  // Open a PDF the way the browser tests do (a dropped file).
  const b64 = readFileSync(join(FIXTURES, "sample.pdf")).toString("base64");
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "sample.pdf", { type: "application/pdf" }));
    const target = document.querySelector(".main");
    target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, b64);
  const opened = await page.waitForSelector('.pdfViewer .page[data-loaded="true"] canvas', { timeout: 60_000 }).then(() => true, () => false);
  check(opened, "a PDF opens and its first page is drawn");
  if (!opened) throw new Error("The PDF didn't open, so the rest can't be checked.");
  await page.waitForTimeout(1500);
  await shot("document");
  check(await page.locator(".phone-bar").count() === 1, "the phone layout is used (bottom bar)");
  check((await page.locator(".phone-pager span").innerText()).trim() === "1 / 6", "the bottom bar shows the page number");

  await page.locator(".phone-bar-btn", { hasText: "Tools" }).tap();
  await page.waitForTimeout(800);
  await shot("tools");
  check(await page.locator(".phone-sheet .tools-item").count() > 10, "the tools sheet lists the tools");
  await page.locator(".phone-sheet .tools-item", { hasText: "Add comments" }).tap();
  await page.waitForTimeout(800);
  check((await page.locator(".mode-chip").innerText()).includes("Comment"), "picking a tool opens it");
  await shot("comment");

  await page.locator(".phone-bar-btn", { hasText: "Pages" }).tap();
  await page.waitForTimeout(1500);
  await shot("pages");
  await page.locator(".phone-sheet .thumb-item").nth(3).tap();
  await page.waitForTimeout(1200);
  check((await page.locator(".phone-pager span").innerText()).trim() === "4 / 6", "tapping a page goes to it");

  // Android's Back button: closes the tool, then the document.
  await device.shell("input keyevent KEYCODE_BACK");
  await page.waitForTimeout(800);
  check(await page.locator(".mode-chip").count() === 0, "Back closes the tool");
  await device.shell("input keyevent KEYCODE_BACK");
  await page.waitForTimeout(800);
  check(await page.locator(".home-hero").count() === 1, "Back again goes to the home screen");
  await shot("back-home");
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
