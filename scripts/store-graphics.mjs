// The Google Play listing's graphics (fastlane/metadata/android/en-US/images): the icon, the feature
// graphic, and phone screenshots of the app with a caption, taken in Chromium at a phone's size
// (the Android app shows the same pages) with demo documents made here.
// Run: node scripts/store-graphics.mjs (CHROMIUM_PATH as for the browser tests).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb } from "@cantoo/pdf-lib";
import fontkit from "@cantoo/fontkit";
import { CARD, faceFile, outlinedCard } from "./card-design.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, "test-output", "store");
const images = join(root, "fastlane", "metadata", "android", "en-US", "images");
mkdirSync(work, { recursive: true });

// ---------------- Demo documents ----------------

const color = (hex) => rgb(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));
const INK = color("#1f2933");
const GRAY = color("#6b7280");
const LINE = color("#d9dee5");

async function withFonts(doc, faces) {
  doc.registerFontkit(fontkit);
  const fonts = {};
  for (const face of faces) fonts[face] = await doc.embedFont(readFileSync(faceFile(face)), { subset: true });
  return fonts;
}

/** The lines of `text` that fit in `width`. */
function wrap(font, text, size, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  return [...lines, line];
}

/** A page with a pen: text, paragraphs and lines from the top down. */
function writer(page, fonts, margin = 40) {
  const { width, height } = page.getSize();
  const pen = {
    y: height - margin,
    text(text, { face, size, x = margin, color: c = INK, after = 0 }) {
      pen.y -= size;
      page.drawText(text, { x, y: pen.y, size, font: fonts[face], color: c });
      pen.y -= after;
    },
    paragraph(text, { face = "Inter-400", size = 9.5, leading = 13.5, x = margin, after = 10 } = {}) {
      for (const line of wrap(fonts[face], text, size, width - x - margin)) {
        page.drawText(line, { x, y: pen.y - size, size, font: fonts[face], color: INK });
        pen.y -= leading;
      }
      pen.y -= after;
    },
    heading(text) {
      pen.y -= 6;
      pen.text(text, { face: "Lora-700", size: 12.5, after: 9 });
    },
    bullets(items) {
      for (const item of items) {
        page.drawCircle({ x: margin + 3, y: pen.y - 6.5, size: 1.8, color: color("#b4532a") });
        pen.paragraph(item, { x: margin + 12, after: 2 });
      }
      pen.y -= 8;
    },
    /** Rows of a label and a number (aligned right), the first row as headings and the last bold with `total`. */
    table(rows, { total = false } = {}) {
      rows.forEach((row, i) => {
        row.forEach((cell, j) => {
          const face = i === 0 || (total && i === rows.length - 1) ? "Inter-600" : "Inter-400";
          const size = i === 0 ? 8 : 9.5;
          const x = j === 0 ? margin : width - margin - fonts[face].widthOfTextAtSize(cell, size);
          page.drawText(cell, { x, y: pen.y - 10, size, font: fonts[face], color: i === 0 ? GRAY : INK });
        });
        pen.y -= 19;
        page.drawLine({ start: { x: margin, y: pen.y + 3 }, end: { x: width - margin, y: pen.y + 3 }, thickness: 0.6, color: LINE });
      });
      pen.y -= 10;
    },
  };
  return pen;
}

/** A short project proposal: headings, paragraphs, lists, tables and a page to sign. */
async function proposal() {
  const doc = await PDFDocument.create();
  doc.setTitle("Website Redesign Proposal");
  const fonts = await withFonts(doc, ["Lora-700", "Lora-400i", "Inter-400", "Inter-600"]);
  const accent = color("#b4532a");
  const header = (page, label) => {
    const pen = writer(page, fonts);
    pen.text(label, { face: "Inter-600", size: 8, color: accent, after: 10 });
    return pen;
  };

  let page = doc.addPage([420, 595]);
  let pen = header(page, "PROPOSAL");
  pen.text("Website Redesign", { face: "Lora-700", size: 25, after: 6 });
  pen.text("for Bloom Bakery", { face: "Lora-400i", size: 17, color: color("#4b5563"), after: 10 });
  pen.text("Prepared by Northlight Studio  ·  3 March 2027", { face: "Inter-400", size: 8.5, color: GRAY, after: 14 });
  page.drawRectangle({ x: 40, y: pen.y, width: 36, height: 2.5, color: accent });
  pen.y -= 16;
  pen.heading("Overview");
  pen.paragraph(
    "Bloom Bakery has grown from one shop to three, and its website hasn't kept up. Customers can't order ahead, the menu is out of date, and pages load slowly on phones. We propose a new site that makes ordering easy and shows off what Bloom bakes best.",
  );
  pen.heading("Goals");
  pen.bullets(["Order ahead for pickup at any of the three shops.", "A menu the team can update in minutes.", "Fast pages on phones, where most visitors browse."]);
  pen.heading("Timeline");
  pen.table(
    [
      ["PHASE", "WEEKS"],
      ["Discovery and design", "1–3"],
      ["Building and content", "4–7"],
      ["Testing and launch", "8"],
    ],
  );

  page = doc.addPage([420, 595]);
  pen = header(page, "BUDGET");
  pen.text("What it costs", { face: "Lora-700", size: 20, after: 16 });
  pen.table(
    [
      ["ITEM", "COST"],
      ["Design", "$2,400"],
      ["Development", "$4,800"],
      ["Content and photos", "$1,200"],
      ["Testing and launch", "$600"],
      ["Total", "$9,000"],
    ],
    { total: true },
  );
  pen.paragraph("Prices include three rounds of changes and a month of support after launch. Half is due when the project starts, and half at launch.");
  pen.heading("Why Northlight");
  pen.paragraph(
    "We've built sites for twelve local food businesses, from a coffee roaster to a family restaurant with four branches. We keep our sites simple to run, so your team can change prices and photos without calling us.",
  );
  page.drawRectangle({ x: 40, y: 60, width: 340, height: 120, color: color("#f6efe9") });
  const quote = writer(page, fonts);
  quote.y = 160;
  quote.paragraph("“Our online orders tripled in the first month, and the team updates the menu themselves.”", { face: "Lora-400i", size: 11, leading: 16, x: 56, after: 4 });
  quote.text("Ada Mensah, Harbor Coffee Roasters", { face: "Inter-600", size: 8, x: 56, color: GRAY });

  page = doc.addPage([420, 595]);
  pen = header(page, "AGREEMENT");
  pen.text("Next steps", { face: "Lora-700", size: 20, after: 12 });
  pen.paragraph(
    "To get started, sign below and return this proposal. We'll schedule a kickoff meeting in the first week, where we'll visit each shop, meet the team and agree on the order of work.",
  );
  pen.paragraph("This proposal is valid for 30 days from the date above.");
  for (const [who, y] of [["Bloom Bakery", 300], ["Northlight Studio", 200]]) {
    page.drawLine({ start: { x: 40, y }, end: { x: 250, y }, thickness: 0.8, color: color("#9ca3af") });
    page.drawLine({ start: { x: 280, y }, end: { x: 380, y }, thickness: 0.8, color: color("#9ca3af") });
    page.drawText(`Signature, ${who}`, { x: 40, y: y - 13, size: 8, font: fonts["Inter-400"], color: GRAY });
    page.drawText("Date", { x: 280, y: y - 13, size: 8, font: fonts["Inter-400"], color: GRAY });
  }
  return doc.save();
}

/** A membership application with form fields. */
async function application() {
  const doc = await PDFDocument.create();
  doc.setTitle("Membership Application");
  const fonts = await withFonts(doc, ["Lora-700", "Inter-400", "Inter-600"]);
  const page = doc.addPage([420, 595]);
  const teal = color("#0f766e");
  page.drawRectangle({ x: 0, y: 595 - 104, width: 420, height: 104, color: teal });
  page.drawText("Riverside Book Club", { x: 40, y: 595 - 56, size: 21, font: fonts["Lora-700"], color: rgb(1, 1, 1) });
  page.drawText("Membership application", { x: 40, y: 595 - 78, size: 10.5, font: fonts["Inter-400"], color: color("#ccfbf1") });
  const form = doc.getForm();
  const field = { borderColor: color("#cbd5e1"), backgroundColor: color("#f8fafc"), borderWidth: 1 };
  let y = 595 - 140;
  const label = (text) => page.drawText(text, { x: 40, y, size: 8.5, font: fonts["Inter-600"], color: color("#374151") });
  for (const [name, text] of [["name", "Full name"], ["email", "Email"], ["phone", "Phone"]]) {
    label(text);
    form.createTextField(name).addToPage(page, { x: 40, y: y - 30, width: 340, height: 22, ...field });
    y -= 56;
  }
  label("Membership");
  ["Individual", "Family", "Student"].forEach((text, i) => {
    const x = 40 + i * 112;
    form.createCheckBox(text.toLowerCase()).addToPage(page, { x, y: y - 26, width: 13, height: 13, ...field });
    page.drawText(text, { x: x + 20, y: y - 23, size: 9.5, font: fonts["Inter-400"], color: INK });
  });
  y -= 56;
  label("Favorite book");
  form.createTextField("book").addToPage(page, { x: 40, y: y - 30, width: 340, height: 22, ...field });
  y -= 76;
  page.drawLine({ start: { x: 40, y }, end: { x: 250, y }, thickness: 0.8, color: color("#9ca3af") });
  page.drawText("Signature", { x: 40, y: y - 13, size: 8, font: fonts["Inter-400"], color: GRAY });
  form.createTextField("date").addToPage(page, { x: 280, y: y + 2, width: 100, height: 22, ...field });
  page.drawText("Date", { x: 280, y: y - 13, size: 8, font: fonts["Inter-400"], color: GRAY });
  return doc.save();
}

/** The invitation card of the browser tests (its layout and fonts), with made-up details. */
function invitation() {
  const text = [
    "SATURDAY",
    "14",
    "2026",
    "NOVEMBER",
    "THE GARDEN PAVILION,",
    "12 Palm Grove Avenue, Riverside",
    "RECEPTION",
    "at four o'clock in the Afternoon",
    "COLORS OF THE DAY",
    "Sage Green and Dusty Pink",
    "INVITE ADMITS ONE",
  ];
  if (text.length !== CARD.items.length) throw new Error("The card's design has changed: give each of its lines a text here.");
  return outlinedCard({ ...CARD, items: CARD.items.map((item, i) => ({ ...item, text: text[i] })) });
}

/** All of them in one file, for organizing. */
async function bundle() {
  const doc = await PDFDocument.create();
  for (const name of ["proposal.pdf", "application.pdf", "invitation.pdf"]) {
    const from = await PDFDocument.load(readFileSync(join(work, name)));
    for (const page of await doc.copyPages(from, from.getPageIndices())) doc.addPage(page);
  }
  return doc.save();
}

const documents = { "proposal.pdf": proposal, "application.pdf": application, "invitation.pdf": invitation, "project-files.pdf": bundle };
for (const [name, make] of Object.entries(documents)) writeFileSync(join(work, name), await make());
if (process.argv.includes("--documents")) {
  console.log(`Demo documents in ${work}`);
  process.exit(0);
}

// ---------------- The app at a phone's size ----------------

const { createServer } = await import("vite");
const { launchBrowser } = await import("../tests/e2e/harness.mjs");
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 5213, strictPort: true } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await launchBrowser();

/** A phone (360 × 720 points, at 3 pixels a point: 1080 × 2160) showing the app with `file` open. */
async function phone(file) {
  const context = await browser.newContext({ viewport: { width: 360, height: 720 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.warn(`  page error: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector(".app");
  // No passing hints over the page.
  await page.addStyleTag({ content: ".tool-hint { display: none !important; }" });
  const st = (fn, arg) => page.evaluate(fn, arg);
  await st(
    ({ b64, file }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file, { type: "application/pdf" }));
      const main = document.querySelector(".main");
      main.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
      main.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { b64: readFileSync(join(work, file)).toString("base64"), file },
  );
  await page.waitForFunction((file) => {
    const s = window.__doxxta.useApp.getState();
    const d = s.docs[s.activeId];
    return d?.name === file && d.status === "ready";
  }, file);
  await page.waitForSelector('.pdfViewer .page[data-loaded="true"]');
  await page.waitForTimeout(1000);
  /** Where a point of the first page (in PDF points) is on the screen. */
  const at = (x, y) =>
    st(([x, y]) => {
      const el = [...document.querySelectorAll('.pdfViewer .page[data-page-number="1"]')].find((e) => e.getBoundingClientRect().width > 0);
      const r = el.getBoundingClientRect();
      const s = window.__doxxta.useApp.getState();
      const [x0, y0, x1, y1] = s.docs[s.activeId].pages[0].view;
      const k = r.width / (x1 - x0);
      return { x: r.left + (x - x0) * k, y: r.top + (y1 - y) * k };
    }, [x, y]);
  const shot = async () => {
    await page.waitForTimeout(800);
    const png = await page.screenshot();
    await context.close();
    return png;
  };
  return { page, st, at, shot };
}

/** Opens Edit PDF's Edit text. */
const editText = (st) => st(() => {
  window.__doxxta.runCommand("mode.edit");
  window.__doxxta.useApp.setState({ tool: "edit-text" });
});

const scenes = [
  {
    name: "edit",
    caption: "Edit the text in any PDF",
    sub: "Changes keep the document's fonts and layout",
    async shoot() {
      const { page, st, shot } = await phone("proposal.pdf");
      await st(() => window.__doxxta.runCommand("view.zoomIn"));
      await editText(st);
      await page.waitForSelector(".doxxta-text-block");
      await page.waitForTimeout(1200);
      // The paragraph under Overview.
      const box = await page.evaluate(() => [...document.querySelectorAll(".doxxta-text-block")].map((b) => b.getBoundingClientRect()).find((r) => r.height > 40));
      await page.touchscreen.tap(box.x + 40, box.y + 12);
      await page.waitForSelector(".text-format-bar");
      return shot();
    },
  },
  {
    name: "picture",
    caption: "Even text in pictures",
    sub: "Invitations, posters and scans",
    async shoot() {
      const { page, st, at, shot } = await phone("invitation.pdf");
      await editText(st);
      await page.click(".doxxta-recognize");
      await page.waitForSelector(".doxxta-text-block.is-seen", { timeout: 120_000 });
      // Close up on the card's text.
      await st(() => {
        const s = window.__doxxta.useApp.getState();
        const viewer = window.__doxxta.runtimes.get(s.activeId).viewer;
        viewer.setScale(0.9);
        viewer.scrollToPoint(0, 290, 150, { center: true });
      });
      await page.waitForTimeout(1500);
      const line = await at(290, 169);
      await page.touchscreen.tap(line.x, line.y);
      await page.waitForSelector(".doxxta-textedit-editor");
      return shot();
    },
  },
  {
    name: "sign",
    caption: "Fill in forms and sign",
    sub: "Type, draw or add a photo of your signature",
    async shoot() {
      const { page, st, shot } = await phone("application.pdf");
      await st(() => window.__doxxta.runCommand("mode.fillsign"));
      await page.waitForTimeout(800);
      const values = { name: "Maya Bennett", email: "maya.bennett@example.com", phone: "+1 555 0142", book: "Things Fall Apart", date: "14 Mar 2027" };
      for (const [name, value] of Object.entries(values)) await page.fill(`.annotationLayer input[name="${name}"]`, value);
      await page.click('.annotationLayer input[name="family"]');
      // A signature as the signature dialog makes one (the name in a script font), on the line.
      await st(async () => {
        const face = new FontFace("Store Signature", "url(/fonts/library/GreatVibes/GreatVibes-400.ttf)");
        document.fonts.add(await face.load());
        const c = document.createElement("canvas");
        const font = '96px "Store Signature"';
        let g = c.getContext("2d");
        g.font = font;
        c.width = Math.ceil(g.measureText("Maya Bennett").width) + 60;
        c.height = 190;
        g = c.getContext("2d");
        g.font = font;
        g.fillStyle = "#1d3fbf";
        g.textBaseline = "middle";
        g.fillText("Maya Bennett", 30, 100);
        const { createImage } = await import("/src/annotations/factory.ts");
        const { addAnnotations } = await import("/src/state/annotActions.ts");
        const s = window.__doxxta.useApp.getState();
        const signature = createImage(s.docs[s.activeId].pages[0].id, { x: 140, y: 160 }, 0, c.toDataURL("image/png"), c.width, c.height, "signature", 150);
        addAnnotations(s.activeId, [signature], "Sign", false);
      });
      await st(() => document.activeElement?.blur());
      return shot();
    },
  },
  {
    name: "comment",
    caption: "Highlight, comment and draw",
    sub: "Notes, shapes, stamps and more",
    async shoot() {
      const { st, shot } = await phone("proposal.pdf");
      await st(() => window.__doxxta.runCommand("view.zoomIn"));
      await st(() => window.__doxxta.runCommand("mode.comment"));
      await st(async () => {
        const { analyzePage } = await import("/src/lib/textLayout.ts");
        const { createInk, createMarkup, createNote } = await import("/src/annotations/factory.ts");
        const { addAnnotations } = await import("/src/state/annotActions.ts");
        const s = window.__doxxta.useApp.getState();
        const page = s.docs[s.activeId].pages[0].id;
        const { lines } = await analyzePage(window.__doxxta.runtimes.get(s.activeId).pdf, 0);
        const line = (text) => lines.find((l) => l.text.startsWith(text));
        const quad = ([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0];
        const highlight = createMarkup("highlight", "highlight", page, [quad(line("Order ahead").rect)], 0, line("Order ahead").text);
        const underline = createMarkup("underline", "underline", page, [quad(line("Fast pages").rect)], 0, line("Fast pages").text);
        underline.color = "#e5484d";
        // A loop around the launch week.
        const [x0, y0, x1, y1] = lines.find((l) => l.text === "8").rect;
        const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
        const loop = Array.from({ length: 40 }, (_, i) => ({ x: cx + Math.cos((i / 39) * 7.6) * 14, y: cy + Math.sin((i / 39) * 7.6) * 9 }));
        const ink = createInk("ink", page, [loop], 0);
        ink.color = "#e5484d";
        const note = createNote(page, { x: 330, y: line("Timeline").rect[3] }, 0);
        note.contents = "Could we launch a week earlier?";
        addAnnotations(s.activeId, [highlight, underline, ink, note], "Comments", false);
      });
      return shot();
    },
  },
  {
    name: "organize",
    caption: "Organize your pages",
    sub: "Reorder, rotate, combine and split",
    async shoot() {
      const { page, st, shot } = await phone("project-files.pdf");
      await st(() => window.__doxxta.runCommand("mode.organize"));
      await page.waitForTimeout(800);
      // Two pages a row, with the toolbar back at its start.
      for (let i = 0; i < 3; i++) await page.locator('button[aria-label="Smaller"]').first().tap();
      await page.waitForTimeout(1500);
      await st(() => (document.querySelector(".organize-toolbar").scrollLeft = 0));
      return shot();
    },
  },
  {
    name: "tools",
    caption: "Every PDF tool you need",
    sub: "Convert, compress, protect, OCR and more",
    async shoot() {
      const { page, shot } = await phone("proposal.pdf");
      await page.tap(".phone-bar-btn:has-text('Tools')");
      await page.waitForSelector(".phone-sheet .tools-item");
      return shot();
    },
  },
];

// ---------------- The listing's images ----------------

const font = (weight) => `url(data:font/ttf;base64,${readFileSync(join(root, "public", "fonts", "library", "Inter", `Inter-${weight}.ttf`)).toString("base64")})`;
const BASE_CSS = `
  @font-face { font-family: Inter; font-weight: 400; src: ${font(400)}; }
  @font-face { font-family: Inter; font-weight: 700; src: ${font(700)}; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: Inter; color: #fff; overflow: hidden; background: linear-gradient(160deg, #3b6af0 0%, #2f5bea 45%, #1f3fb8 100%); }
  .phone { position: absolute; background: #0f1115; padding: 14px; border-radius: 64px; box-shadow: 0 30px 80px rgba(8, 20, 60, 0.45); }
  .phone img { display: block; width: 100%; border-radius: 50px; }
`;
// The app's quill (public/favicon.svg), drawn on its own.
const QUILL = `
  <path d="M47.5 13.5C33 15.5 22.5 25.5 18.6 40.6l-1.7 6.6 6.4-2.4C37.4 39.4 45.6 28.3 47.5 13.5z" fill="#fff"/>
  <path d="M44 18L20.2 44.6" stroke="#2f5bea" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M16.6 48.6l-3 3.9" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <path d="M27 51.5h21" stroke="#9fb4ff" stroke-width="3.6" stroke-linecap="round"/>`;
/** The icon: the quill, centered and about the size it has in the phone's icon, on the app's blue. */
const ICON_SVG = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}"><rect width="64" height="64" fill="#2f5bea"/><g transform="translate(32 32) scale(0.64) translate(-31 -33.75)">${QUILL}</g></svg>`;

/** Renders HTML at a size: a PNG (with `png`) or a JPEG (Google Play takes no transparency in these). */
async function render(html, width, height, { png = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const image = await page.screenshot(png ? { type: "png" } : { type: "jpeg", quality: 92 });
  await page.close();
  return image;
}

const dataUrl = (png) => `data:image/png;base64,${png.toString("base64")}`;
mkdirSync(join(images, "phoneScreenshots"), { recursive: true });

writeFileSync(join(images, "icon.png"), await render(`<style>body{margin:0}</style>${ICON_SVG(512)}`, 512, 512, { png: true }));
console.log("icon.png");

const shots = {};
for (const [i, scene] of scenes.entries()) {
  shots[scene.name] = await scene.shoot();
  writeFileSync(join(work, `${scene.name}.png`), shots[scene.name]);
  const html = `<style>${BASE_CSS}
    h1 { position: absolute; top: 120px; width: 100%; text-align: center; font-size: 76px; font-weight: 700; letter-spacing: -1.5px; }
    p { position: absolute; top: 228px; width: 100%; text-align: center; font-size: 38px; opacity: 0.86; }
    .phone { left: 159px; top: 330px; width: 762px; }
  </style>
  <h1>${scene.caption}</h1><p>${scene.sub}</p>
  <div class="phone"><img src="${dataUrl(shots[scene.name])}"></div>`;
  writeFileSync(join(images, "phoneScreenshots", `${i + 1}-${scene.name}.jpg`), await render(html, 1080, 1920));
  console.log(`phoneScreenshots/${i + 1}-${scene.name}.jpg`);
}

const feature = `<style>${BASE_CSS}
  .icon { position: absolute; left: 72px; top: 118px; width: 104px; height: 104px; border-radius: 24px; overflow: hidden; box-shadow: 0 10px 30px rgba(8, 20, 60, 0.35); }
  h1 { position: absolute; left: 200px; top: 122px; font-size: 92px; font-weight: 700; letter-spacing: -2.5px; }
  p { position: absolute; left: 74px; top: 262px; width: 520px; font-size: 40px; line-height: 1.3; opacity: 0.9; }
  .phone { left: 662px; top: 52px; width: 300px; padding: 9px; border-radius: 34px; }
  .phone img { border-radius: 26px; }
</style>
<div class="icon">${ICON_SVG(104)}</div><h1>Doxxta</h1>
<p>Edit, sign and organize PDFs on your phone</p>
<div class="phone"><img src="${dataUrl(shots.edit)}"></div>`;
writeFileSync(join(images, "featureGraphic.jpg"), await render(feature, 1024, 500));
console.log("featureGraphic.jpg");

await browser.close();
await server.close();
console.log(`Written to ${images}`);
