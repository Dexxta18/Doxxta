// Creates the test PDFs when they are missing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { FIXTURES, ROOT } from "./harness.mjs";
import { CARD, faceFile } from "../../scripts/card-design.mjs";

/** Written by scripts/make-fixtures.mjs. */
const MADE = ["sample.pdf", "card.pdf", "light.pdf", "broken-tree.pdf", "hidden-pages.pdf", "form.pdf", "annotated.pdf", "simple.pdf"];

export async function ensureFixtures(browser) {
  if (MADE.some((f) => !existsSync(join(FIXTURES, f)))) execFileSync(process.execPath, [join(ROOT, "scripts", "make-fixtures.mjs")], { stdio: "inherit" });
  if (!existsSync(join(FIXTURES, "scanned.pdf"))) await makeScanned(browser);
  if (!existsSync(join(FIXTURES, "card-picture.pdf"))) await makeCardPicture(browser);
  if (!existsSync(join(FIXTURES, "poster-picture.pdf"))) await makePosterPicture(browser);
}

/** A poster whose text is on a gradient, as one picture: covering its text needs what's behind it, not a color. */
async function makePosterPicture(browser) {
  const page = await browser.newPage({ viewport: { width: 432, height: 288 }, deviceScaleFactor: 3 });
  const face = (family, file, weight, style) =>
    `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: ${style}; src: url(data:font/ttf;base64,${readFileSync(faceFile(file)).toString("base64")}); }`;
  await page.setContent(`<style>${face("Montserrat", "Montserrat-700", 700, "normal")} ${face("Montserrat", "Montserrat-400", 400, "normal")} ${face("Cormorant Garamond", "CormorantGaramond-400i", 400, "italic")}
    body { margin: 0; width: 432px; height: 288px; background: linear-gradient(90deg, #f6d365, #fd8a6b); color: #3a2e2a; text-align: center; }
    div { position: absolute; left: 0; right: 0; white-space: nowrap; }</style>
    <div style="top: 70px; font: 700 30px/1 Montserrat; letter-spacing: 1px">SUMMER SALE</div>
    <div style="top: 124px; font: italic 400 20px/1 'Cormorant Garamond'">Up to 50% off everything</div>
    <div style="top: 182px; font: 400 11px/1 Montserrat; letter-spacing: 1.5px">SATURDAY 14 NOVEMBER</div>`);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot();
  await page.close();
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  doc.addPage([432, 288]).drawImage(image, { x: 0, y: 0, width: 432, height: 288 });
  writeFileSync(join(FIXTURES, "poster-picture.pdf"), await doc.save());
}

/** The invitation card of scripts/card-design.mjs as one picture (216 dpi), as a design app exports it flattened. */
async function makeCardPicture(browser) {
  const page = await browser.newPage({ viewport: { width: CARD.width, height: CARD.height }, deviceScaleFactor: 3 });
  const faces = [...new Set(CARD.items.map((i) => i.face))];
  const fontFace = (face) => {
    const [family, style] = face.split("-");
    return `@font-face { font-family: "${family}"; font-weight: ${parseInt(style)}; font-style: ${style.endsWith("i") ? "italic" : "normal"};
      src: url(data:font/ttf;base64,${readFileSync(faceFile(face)).toString("base64")}); }`;
  };
  const s = CARD.strip;
  const items = CARD.items.map((i) => {
    const [family, style] = i.face.split("-");
    const font = `${style.endsWith("i") ? "italic" : "normal"} ${parseInt(style)} ${i.size}px/1 '${family}'`;
    // Centered on its middle, with its baseline (about 0.8 of the size below the top of the line) at `top`.
    const place = i.vertical ? `left:${i.cx}px;top:${i.top}px;transform:translate(-50%,-50%) rotate(-90deg)` : `left:${i.cx}px;top:${i.top - i.size * 0.8}px;transform:translateX(-50%)`;
    return `<div style="position:absolute;white-space:nowrap;${place};font:${font};letter-spacing:${i.spacing}px;margin-right:${-i.spacing}px;color:${i.color ?? CARD.ink}">${i.text}</div>`;
  });
  const rules = CARD.rules.map(([x1, t1, x2, t2]) => `<line x1="${x1}" y1="${t1}" x2="${x2}" y2="${t2}" stroke="${CARD.ink}" stroke-width="0.6"/>`);
  await page.setContent(`<style>${faces.map(fontFace).join("\n")} body{margin:0;width:${CARD.width}px;height:${CARD.height}px;position:relative;overflow:hidden;background:${CARD.background}}</style>
    <div style="position:absolute;left:${s.x}px;top:${s.top}px;width:${s.width}px;height:${s.height}px;background:${s.color}"></div>
    <svg width="${CARD.width}" height="${CARD.height}" style="position:absolute;left:0;top:0">${rules.join("")}</svg>${items.join("")}`);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot();
  await page.close();
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  doc.addPage([CARD.width, CARD.height]).drawImage(image, { x: 0, y: 0, width: CARD.width, height: CARD.height });
  writeFileSync(join(FIXTURES, "card-picture.pdf"), await doc.save());
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
