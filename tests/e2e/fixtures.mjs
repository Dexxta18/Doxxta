// Creates the test PDFs when they are missing.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { FIXTURES, ROOT } from "./harness.mjs";

/** Written by scripts/make-fixtures.mjs. */
const MADE = ["sample.pdf", "light.pdf", "broken-tree.pdf", "hidden-pages.pdf", "form.pdf", "annotated.pdf", "simple.pdf"];

export async function ensureFixtures(browser) {
  if (MADE.some((f) => !existsSync(join(FIXTURES, f)))) execFileSync(process.execPath, [join(ROOT, "scripts", "make-fixtures.mjs")], { stdio: "inherit" });
  if (!existsSync(join(FIXTURES, "scanned.pdf"))) await makeScanned(browser);
}

/** A page that is only a picture of text, like a scan: a screenshot of some HTML placed on a Letter page. */
async function makeScanned(browser) {
  const page = await browser.newPage({ viewport: { width: 816, height: 1056 }, deviceScaleFactor: 2 });
  const lorem =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. Donec ullamcorper nulla non metus auctor fringilla.";
  await page.setContent(`<body style="margin:0;padding:96px;font:16px/1.5 Arial,Helvetica,sans-serif;color:#111;background:#fff">
    <h1 style="font-size:28px;color:#1f3a7a;margin:0 0 20px">Chapter 1: Introduction</h1>
    <p>The quick brown fox jumps over the lazy dog. ${lorem}</p>
    <p style="font-family:Georgia,serif">${lorem}</p>
    <p>Invoice total: 1,250.00 USD, due 30 November 2026.</p>
  </body>`);
  const png = await page.screenshot();
  await page.close();
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  doc.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  writeFileSync(join(FIXTURES, "scanned.pdf"), await doc.save());
}
