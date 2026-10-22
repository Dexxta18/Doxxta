// Browser tests against the dev server: npm run test:e2e [-- suite …]
// Suites drive the real UI and use the dev-only `window.__doxxta` handle to check app state.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import { ROOT, dropFile, fixture, launchBrowser, openApp, recorder, shot } from "./harness.mjs";
import { ensureFixtures } from "./fixtures.mjs";
import { startFileServer } from "./server.mjs";

const ALL = ["organize", "forms", "editing", "export", "signing", "security", "redaction", "openurl"];
const picked = process.argv.slice(2);
const unknown = picked.filter((s) => !ALL.includes(s));
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(", ")}. Available: ${ALL.join(", ")}`);
  process.exit(2);
}
const suites = picked.length ? picked : ALL;

if (!existsSync(join(ROOT, "public", "vendor", "pdfjs"))) execFileSync(process.execPath, [join(ROOT, "scripts", "copy-vendor.mjs")], { stdio: "inherit" });
const browser = await launchBrowser();
await ensureFixtures(browser);
const server = await createServer({ root: ROOT, logLevel: "error", server: { host: "127.0.0.1", port: 5199 } });
await server.listen();
const url = server.resolvedUrls.local[0];
const fileServer = await startFileServer();

const results = [];
for (const name of suites) {
  const suite = await import(`./suites/${name}.mjs`);
  console.log(`\n${suite.title}`);
  const { context, page, errors } = await openApp(browser, url);
  const { results: own, check } = recorder(name);
  try {
    await suite.default(suiteContext(page, check, name));
  } catch (e) {
    check(false, `stopped: ${String(e.message ?? e).split("\n")[0]}`);
    await shot(page, `${name}-stopped`).catch(() => {});
  }
  for (const message of errors) check(false, `page error: ${message}`);
  results.push(...own);
  await context.close();
}
await browser.close();
await server.close();
await fileServer.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) for (const f of failed) console.log(`  ✗ [${f.suite}] ${f.message}`);
console.log(`Screenshots: ${join(ROOT, "test-output", "shots")}`);
process.exit(failed.length ? 1 : 0);

function suiteContext(page, check, suite) {
  return {
    page,
    check,
    /** Address of the local test website (see server.mjs). */
    files: fileServer.url,
    st: (fn, arg) => page.evaluate(fn, arg),
    shot: (name) => shot(page, `${suite}-${name}`),
    idle: () => page.waitForFunction(() => !window.__doxxta.useApp.getState().busy, null, { timeout: 60000 }),
    /** Opens a fixture (with a password when it is encrypted) and waits until it is shown. */
    async open(name, password) {
      if (password) {
        const b64 = readFileSync(fixture(name)).toString("base64");
        await page.evaluate(
          async ({ b64, name, password }) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const { openBytes } = await import("/src/core/document.ts");
            await openBytes(bytes, name, { password });
          },
          { b64, name, password },
        );
      } else await dropFile(page, name);
      await page.waitForFunction((name) => { const s = window.__doxxta.useApp.getState(); const d = s.docs[s.activeId]; return d?.name === name && d.status === "ready"; }, name, { timeout: 20000 });
      await page.waitForSelector('.pdfViewer .page[data-loaded="true"]', { timeout: 20000 });
      await page.waitForTimeout(600);
    },
    /** The bytes Save would write for the active document. */
    build: () => page.evaluate(async () => Array.from(await (await import("/src/core/save.ts")).buildPdf(window.__doxxta.useApp.getState().activeId, {}))),
    /** Reads a PDF back with pdf.js: text, annotations, bookmarks, title, permissions. */
    readPdf: (bytes, password) => page.evaluate(readPdfInPage, { bytes, password }),
  };
}

async function readPdfInPage({ bytes, password }) {
  const { openPdf, PasswordCancelled } = await import("/src/lib/pdfjs.ts");
  let pdf;
  try {
    ({ pdf } = await openPdf(new Uint8Array(bytes), { password }));
  } catch (e) {
    if (e instanceof PasswordCancelled) return { needsPassword: true };
    throw e;
  }
  const permissions = await pdf.getPermissions(); // a Set of allowed flags, or null when unrestricted
  const out = { needsPassword: false, pages: pdf.numPages, text: [], annots: [], notes: [], outline: [], title: null, permissions: permissions ? [...permissions] : null };
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const content = await p.getTextContent();
    out.text.push(content.items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("").replace(/[ \t]+/g, " "));
    out.sizes = [...(out.sizes ?? []), [Math.round(p.view[2] - p.view[0]), Math.round(p.view[3] - p.view[1])]];
    const annots = await p.getAnnotations();
    out.annots.push(annots.map((a) => a.subtype));
    for (const a of annots) if (a.contentsObj?.str) out.notes.push(a.contentsObj.str);
  }
  const walk = (items) => (items ?? []).flatMap((o) => [o.title, ...walk(o.items)]);
  out.outline = walk(await pdf.getOutline());
  out.title = (await pdf.getMetadata()).info?.Title ?? null;
  await pdf.loadingTask.destroy();
  return out;
}
