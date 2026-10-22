// Generates PDFs used for manual and automated testing: node scripts/make-fixtures.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFArray, PDFNumber, PDFDict, degrees } from "@cantoo/pdf-lib";
import fontkit from "@cantoo/fontkit";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");
mkdirSync(out, { recursive: true });

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. Donec ullamcorper nulla non metus auctor fringilla. Vestibulum id ligula porta felis euismod semper. Cras justo odio, dapibus ac facilisis in, egestas eget quam.";

function wrap(text, font, size, width) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

async function sample() {
  const doc = await PDFDocument.create();
  doc.setTitle("Doxxta sample document");
  doc.setAuthor("Doxxta test suite");
  doc.setSubject("Fixture for testing");
  doc.setKeywords(["pdf", "test", "doxxta"]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const pages = [];
  for (let i = 0; i < 6; i++) {
    const page = doc.addPage([612, 792]);
    pages.push(page);
    page.drawText(`Chapter ${i + 1}: ${["Introduction", "Getting started", "Annotations", "Forms", "Security", "Appendix"][i]}`, { x: 72, y: 710, size: 22, font: bold, color: rgb(0.1, 0.15, 0.35) });
    let y = 670;
    for (let p = 0; p < 3; p++) {
      const font = p === 1 ? times : helv;
      for (const line of wrap(`${p === 0 ? "The quick brown fox jumps over the lazy dog. " : ""}${LOREM}`, font, 11.5, 468)) {
        page.drawText(line, { x: 72, y, size: 11.5, font, color: rgb(0.1, 0.1, 0.1) });
        y -= 16;
      }
      y -= 12;
    }
    if (i === 1) {
      // A simple table for Excel export tests.
      const rows = [
        ["Item", "Quantity", "Price", "Total"],
        ["Apples", "4", "0.50", "2.00"],
        ["Bananas", "12", "0.25", "3.00"],
        ["Cherries", "200", "0.05", "10.00"],
      ];
      rows.forEach((r, ri) => {
        r.forEach((c, ci) => page.drawText(c, { x: 72 + ci * 110, y: y - ri * 18, size: 11, font: ri === 0 ? bold : helv }));
      });
      y -= rows.length * 18 + 20;
      page.drawText("int main() { return 0; }  // monospaced sample", { x: 72, y, size: 10, font: courier });
      y -= 24;
    }
    page.drawRectangle({ x: 72, y: 90, width: 468, height: 60, color: rgb(0.93, 0.95, 1), borderColor: rgb(0.6, 0.65, 0.9), borderWidth: 1 });
    page.drawText(`Note box on page ${i + 1}. Confidential contact: jane.doe@example.com, +1 (555) 012-3456.`, { x: 84, y: 124, size: 10, font: helv });
    page.drawText(`SSN 123-45-6789 · Card 4111 1111 1111 1111`, { x: 84, y: 106, size: 10, font: helv });
    page.drawText(`${i + 1}`, { x: 300, y: 40, size: 10, font: helv, color: rgb(0.4, 0.4, 0.4) });
  }
  // Link on page 1 to page 4 and an external URL.
  const ctx = doc.context;
  const p1 = pages[0];
  const linkInternal = ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 60, 250, 80], Border: [0, 0, 0], Dest: [pages[3].ref, PDFName.of("XYZ"), null, 792, null] });
  const linkUrl = ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [300, 60, 540, 80], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/") } });
  p1.drawText("Go to chapter 4", { x: 74, y: 66, size: 11, font: helv, color: rgb(0, 0.2, 0.8) });
  p1.drawText("https://example.com/", { x: 302, y: 66, size: 11, font: helv, color: rgb(0, 0.2, 0.8) });
  p1.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(linkInternal), ctx.register(linkUrl)]));

  // Outline with nesting.
  const outlineRef = ctx.nextRef();
  const items = pages.map((p, i) => ({ ref: ctx.nextRef(), page: p, title: `Chapter ${i + 1}` }));
  const childRef = ctx.nextRef();
  items.forEach((it, i) => {
    const dict = {
      Title: PDFString.of(it.title),
      Parent: outlineRef,
      Dest: [it.page.ref, PDFName.of("XYZ"), null, 740, null],
    };
    if (i > 0) dict.Prev = items[i - 1].ref;
    if (i < items.length - 1) dict.Next = items[i + 1].ref;
    if (i === 1) {
      dict.First = childRef;
      dict.Last = childRef;
      dict.Count = 1;
    }
    ctx.assign(it.ref, ctx.obj(dict));
  });
  ctx.assign(childRef, ctx.obj({ Title: PDFString.of("2.1 Data table"), Parent: items[1].ref, Dest: [pages[1].ref, PDFName.of("XYZ"), null, 520, null] }));
  ctx.assign(outlineRef, ctx.obj({ Type: "Outlines", First: items[0].ref, Last: items[items.length - 1].ref, Count: items.length }));
  doc.catalog.set(PDFName.of("Outlines"), outlineRef);
  // Page labels: i, ii for the first two pages then 1, 2, …
  doc.catalog.set(
    PDFName.of("PageLabels"),
    ctx.obj({ Nums: [0, ctx.obj({ S: "r" }), 2, ctx.obj({ S: "D", St: 1 })] }),
  );
  await doc.attach(new TextEncoder().encode("name,qty\napples,4\n"), "data.csv", { mimeType: "text/csv", description: "Sample data" });
  writeFileSync(join(out, "sample.pdf"), await doc.save());
}

async function form() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText("Application form", { x: 72, y: 720, size: 22, font: bold });
  const form = doc.getForm();
  const label = (t, y) => page.drawText(t, { x: 72, y, size: 11, font: helv });
  label("Full name", 672);
  const name = form.createTextField("applicant.name");
  name.addToPage(page, { x: 180, y: 662, width: 300, height: 22 });
  label("Email", 632);
  const email = form.createTextField("applicant.email");
  email.addToPage(page, { x: 180, y: 622, width: 300, height: 22 });
  label("Subscribe", 592);
  const sub = form.createCheckBox("subscribe");
  sub.addToPage(page, { x: 180, y: 588, width: 16, height: 16 });
  label("Plan", 552);
  const plan = form.createRadioGroup("plan");
  plan.addOptionToPage("basic", page, { x: 180, y: 548, width: 16, height: 16 });
  plan.addOptionToPage("pro", page, { x: 260, y: 548, width: 16, height: 16 });
  page.drawText("Basic", { x: 200, y: 552, size: 10, font: helv });
  page.drawText("Pro", { x: 280, y: 552, size: 10, font: helv });
  label("Country", 512);
  const country = form.createDropdown("country");
  country.addOptions(["Canada", "Nigeria", "United Kingdom", "United States"]);
  country.addToPage(page, { x: 180, y: 502, width: 200, height: 22 });
  label("Comments", 470);
  const comments = form.createTextField("comments");
  comments.enableMultiline();
  comments.addToPage(page, { x: 180, y: 380, width: 300, height: 90 });
  form.updateFieldAppearances(helv);
  writeFileSync(join(out, "form.pdf"), await doc.save());
}

function apStream(ctx, ops, bbox, resources) {
  return ctx.register(ctx.flateStream(ops, { Type: "XObject", Subtype: "Form", BBox: bbox, Resources: resources ?? {} }));
}

async function annotated() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("This sentence has an existing highlight from another app.", { x: 72, y: 700, size: 14, font: helv });
  page.drawText("A sticky note, a text box, a drawing and a rectangle follow.", { x: 72, y: 670, size: 14, font: helv });
  const ctx = doc.context;
  const annots = [];
  // Highlight
  const q = [72, 716, 300, 716, 72, 696, 300, 696];
  annots.push(
    ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: [72, 696, 300, 716],
        QuadPoints: q,
        C: [1, 0.85, 0],
        CA: 0.5,
        T: PDFString.of("Alice Reviewer"),
        Contents: PDFString.of("Please double-check this claim."),
        NM: PDFString.of("hl-1"),
        AP: { N: apStream(ctx, "1 0.85 0 rg 72 696 228 20 re f", [72, 696, 300, 716], { ExtGState: { G: ctx.obj({ CA: 0.5, ca: 0.5, BM: "Multiply" }) } }) },
      }),
    ),
  );
  // Sticky note with a reply
  const noteRef = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [520, 640, 540, 660], C: [1, 1, 0], Name: "Comment", T: PDFString.of("Bob"), Contents: PDFString.of("Looks good to me."), NM: PDFString.of("note-1") }));
  annots.push(noteRef);
  annots.push(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [520, 640, 540, 660], IRT: noteRef, RT: "R", T: PDFString.of("Alice Reviewer"), Contents: PDFString.of("Thanks Bob!"), NM: PDFString.of("reply-1"), F: 30 })));
  // FreeText
  annots.push(
    ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "FreeText",
        Rect: [72, 560, 300, 600],
        DA: PDFString.of("/Helv 12 Tf 0 0 1 rg"),
        Contents: PDFString.of("Existing text box comment"),
        T: PDFString.of("Carol"),
        C: [1, 1, 1],
        NM: PDFString.of("ft-1"),
      }),
    ),
  );
  // Ink
  annots.push(
    ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Ink",
        Rect: [320, 520, 480, 620],
        InkList: [[330, 530, 360, 600, 400, 540, 440, 610, 470, 530]],
        C: [0.9, 0.1, 0.2],
        BS: { W: 3 },
        T: PDFString.of("Dave"),
        NM: PDFString.of("ink-1"),
      }),
    ),
  );
  // Square
  annots.push(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [72, 420, 260, 520], C: [0, 0.5, 0], IC: [0.85, 1, 0.85], BS: { W: 2 }, T: PDFString.of("Erin"), NM: PDFString.of("sq-1") })));
  page.node.set(PDFName.of("Annots"), ctx.obj(annots));
  writeFileSync(join(out, "annotated.pdf"), await doc.save());
}

async function encrypted() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Top secret: this file is encrypted with the password 'secret'.", { x: 72, y: 700, size: 14, font: helv });
  doc.encrypt({ userPassword: "secret", ownerPassword: "owner", permissions: { printing: "highResolution", modifying: false, copying: false } });
  writeFileSync(join(out, "encrypted.pdf"), await doc.save());
}

async function rotated() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (const r of [0, 90, 180, 270]) {
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(r));
    page.drawText(`This page has /Rotate ${r}`, { x: 72, y: 700, size: 24, font: helv });
    page.drawText("Top-left marker", { x: 20, y: 770, size: 10, font: helv });
  }
  writeFileSync(join(out, "rotated.pdf"), await doc.save());
}

async function simple() {
  // A one-page document with a single heading.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText("INVOICE 2026", { x: 72, y: 700, size: 36, font: helv });
  writeFileSync(join(out, "simple.pdf"), await doc.save());
}

/**
 * Four pages ("Page 1"…"Page 4") in a damaged page tree, the kind some PDF tools write: wrong
 * /Count entries, a page whose /Parent points to the wrong node, a page without /Type, and
 * pages 3–4 inheriting their size and fonts from their parent node. pdf-lib's own page
 * insertion fails on it ("corrupt page tree").
 */
async function brokenTree() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 4; i++) {
    const page = doc.addPage(i <= 2 ? [612, 792] : [400, 400]);
    page.drawText(`Page ${i}`, { x: 60, y: page.getHeight() - 100, size: 40, font: helv });
  }
  const ctx = doc.context;
  const root = doc.catalog.Pages();
  const rootRef = doc.catalog.get(PDFName.of("Pages"));
  const leaves = doc.getPages();
  const node = (kids, count, extra = {}) => {
    const ref = ctx.register(ctx.obj({ Type: "Pages", Parent: rootRef, Kids: kids.map((p) => p.ref), Count: count, ...extra }));
    for (const p of kids) p.node.set(PDFName.of("Parent"), ref);
    return ref;
  };
  // Fonts of pages 3 and 4 in one resource dictionary that both inherit.
  const fonts = ctx.obj({});
  for (const p of leaves.slice(2)) {
    const own = p.node.Resources().lookup(PDFName.of("Font"));
    for (const [k, v] of own.entries()) fonts.set(k, v);
  }
  const a = node(leaves.slice(0, 2), 2);
  const b = node(leaves.slice(2), 5, { MediaBox: [0, 0, 400, 400], Resources: ctx.obj({ Font: fonts }) });
  for (const p of leaves.slice(2)) {
    p.node.delete(PDFName.of("MediaBox"));
    p.node.delete(PDFName.of("Resources"));
  }
  leaves[1].node.set(PDFName.of("Parent"), rootRef);
  leaves[3].node.delete(PDFName.of("Type"));
  root.set(PDFName.of("Kids"), ctx.obj([a, b]));
  root.set(PDFName.of("Count"), PDFNumber.of(7));
  writeFileSync(join(out, "broken-tree.pdf"), await doc.save({ useObjectStreams: false }));
}

/** 20 pages, but the page tree's /Count says 13: viewers that trust it show only 13. */
async function hiddenPages() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 20; i++) doc.addPage([612, 792]).drawText(`Page ${i}`, { x: 60, y: 692, size: 40, font: helv });
  doc.catalog.Pages().set(PDFName.of("Count"), PDFNumber.of(13));
  writeFileSync(join(out, "hidden-pages.pdf"), await doc.save({ useObjectStreams: false }));
}

/**
 * Like PDFObject's sample PDF, made on a Mac: a title and a paragraph in Helvetica Neue Light, a
 * line in Light Italic, embedded as subsets (here Inter Light under Helvetica Neue's names).
 * Text typed into it must stay light.
 */
async function light() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts", "library", "Inter");
  const upright = await doc.embedFont(readFileSync(join(lib, "Inter-300.ttf")), { subset: true });
  const italic = await doc.embedFont(readFileSync(join(lib, "Inter-300i.ttf")), { subset: true });
  const page = doc.addPage([612, 792]);
  page.drawText("Sample PDF", { x: 72, y: 700, size: 30, font: upright });
  page.drawText("This is a simple PDF file. Fun fun fun.", { x: 72, y: 664, size: 14, font: italic });
  wrap(LOREM, upright, 11, 468).forEach((line, i) => page.drawText(line, { x: 72, y: 630 - i * 15, size: 11, font: upright }));
  await doc.flush();
  const rename = (name) => name.replace("Inter-Light", "HelveticaNeue-Light");
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    for (const key of ["BaseFont", "FontName"]) {
      const v = obj.get(PDFName.of(key));
      if (v instanceof PDFName && v.decodeText().includes("Inter-Light")) obj.set(PDFName.of(key), PDFName.of(rename(v.decodeText())));
    }
    const family = obj.get(PDFName.of("FontFamily"));
    if (family) obj.set(PDFName.of("FontFamily"), PDFString.of("Helvetica Neue"));
  }
  writeFileSync(join(out, "light.pdf"), await doc.save());
}

await sample();
await light();
await brokenTree();
await hiddenPages();
await form();
await annotated();
await encrypted();
await rotated();
await simple();
console.log("Fixtures written to", out);
void PDFArray;
void PDFNumber;
