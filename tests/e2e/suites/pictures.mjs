// Edit text on text that's part of a picture: an invitation card whose letters are outlines
// (card.pdf), the same card as one picture (card-picture.pdf), and a poster on a gradient.
export const title = "Text in pictures";

export default async function run({ page, check, st, open, shot, build, readPdf }) {
  const version = () => st(() => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].version; });
  const saved = async (v0) => page.waitForFunction((v0) => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].version > v0 && !s.busy; }, v0, { timeout: 30000 });
  /** Clicks a point of page 1 given in PDF points. */
  const tap = async (x, y) => {
    const at = await st(([x, y]) => {
      const el = document.querySelector('.pdfViewer .page[data-page-number="1"]');
      const r = el.getBoundingClientRect();
      const { view } = window.__doxxta.useApp.getState().docs[window.__doxxta.useApp.getState().activeId].pages[0];
      const s = r.width / (view[2] - view[0]);
      return { x: r.left + (x - view[0]) * s, y: r.top + (view[3] - y) * s };
    }, [x, y]);
    await page.mouse.click(at.x, at.y);
  };
  const editor = () => page.locator(".doxxta-textedit-editor");
  /** Types `text` in place of the editor's text and commits it. */
  const replace = async (text) => {
    const v0 = await version();
    await st((text) => (document.querySelector(".doxxta-textedit-editor").innerText = text), text);
    await page.keyboard.press("Control+Enter");
    await saved(v0);
    await page.waitForTimeout(800);
  };
  /** Page 1 of a PDF drawn at 3×: per PDF rectangle, its near-white pixels and its average color. */
  const pixels = (bytes, rects) =>
    st(async ({ bytes, rects }) => {
      const { pdfjs } = await import("/src/lib/pdfjs.ts");
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      const p = await pdf.getPage(1);
      const vp = p.getViewport({ scale: 3 });
      const c = document.createElement("canvas");
      c.width = vp.width;
      c.height = vp.height;
      await p.render({ canvas: c, viewport: vp }).promise;
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      return rects.map(([x0, y0, x1, y1]) => {
        let white = 0;
        const sum = [0, 0, 0];
        let n = 0;
        for (let y = Math.round((p.view[3] - y1) * 3); y < Math.round((p.view[3] - y0) * 3); y++) {
          for (let x = Math.round(x0 * 3); x < Math.round(x1 * 3); x++) {
            const i = (y * c.width + x) * 4;
            if (data[i] > 215 && data[i + 1] > 215 && data[i + 2] > 215) white++;
            sum[0] += data[i];
            sum[1] += data[i + 1];
            sum[2] += data[i + 2];
            n++;
          }
        }
        return { white, color: sum.map((v) => Math.round(v / Math.max(1, n))) };
      });
    }, { bytes, rects });
  /** The fonts the page's text is drawn in, by text. */
  const fontsOf = () =>
    st(async () => {
      const s = window.__doxxta.useApp.getState();
      const { getRuntime } = await import("/src/state/runtime.ts");
      const { analyzePage } = await import("/src/lib/textLayout.ts");
      const l = await analyzePage(getRuntime(s.activeId).pdf, 0);
      return l.runs.map((r) => ({ text: r.str, font: r.psName, size: r.size }));
    });
  const editText = async () => {
    await st(() => window.__doxxta.runCommand("mode.edit"));
    await st(() => window.__doxxta.useApp.setState({ tool: "edit-text" }));
  };

  // ----- The card with its letters as outlines -----
  await open("card.pdf");
  await editText();
  const offer = await page.waitForSelector(".doxxta-recognize", { timeout: 15000 }).then(() => true, () => false);
  check(offer && (await page.locator(".doxxta-recognize").innerText()).includes("Recognize text"), "a page whose text is in a picture offers to recognize it");
  await shot("card-offer");
  // Clicking the text recognizes the page's text and opens it.
  await tap(290, 169);
  const opened = await page.waitForSelector(".doxxta-textedit-editor", { timeout: 60000 }).then(() => true, () => false);
  check(opened && (await editor().innerText()) === "NAFOWA HALL,", `clicking text in a picture recognizes it and opens it (${opened ? JSON.stringify(await editor().innerText()) : "no editor"})`);
  const found = await page.locator(".doxxta-text-block.is-seen").count();
  check(found >= 8, `the lines found in the picture are outlined (${found})`);
  const look = await st(() => {
    const s = getComputedStyle(document.querySelector(".doxxta-textedit-editor span"));
    return { family: s.fontFamily, spacing: parseFloat(s.letterSpacing) || 0, color: s.color, background: getComputedStyle(document.querySelector(".doxxta-textedit-editor")).backgroundColor };
  });
  check(/Montserrat/.test(look.family) && look.spacing > 1.5 && look.color === "rgb(255, 255, 255)", `it's shown as it looks: Montserrat, letter-spaced, white (${look.family}, ${look.spacing}px, ${look.color})`);
  check(look.background === "rgb(107, 122, 88)", `on the card's color, not white (${look.background})`);
  await shot("card-editing");
  const before = await pixels(await build(), [[238, 163, 342, 176]]);
  await replace("GRAND HALL,");
  const bytes = await build();
  const text = (await readPdf(bytes)).text[0].replace(/\s/g, "");
  check(text.includes("GRANDHALL,") && !text.includes("NAFOWA"), "the new text is the page's text, and the old is gone");
  // The old line was wider: its ends are now the card's color, and the new letters are white.
  const [left, right, middle] = await pixels(bytes, [[236, 163, 247, 176], [333, 163, 344, 176], [262, 163, 318, 176]]);
  check(before[0].white > 300 && left.white === 0 && right.white === 0 && middle.white > 200, `the old letters are covered, the new drawn in white (ends ${left.white}, ${right.white}; middle ${middle.white})`);
  check(Math.abs(left.color[0] - 107) <= 3 && Math.abs(left.color[1] - 122) <= 3 && Math.abs(left.color[2] - 88) <= 3, `the cover is the card's color (${left.color})`);
  const fonts = await fontsOf();
  const grand = fonts.find((f) => f.text.replace(/\s/g, "").startsWith("GRAND"));
  check(!!grand && /Montserrat/.test(grand.font) && Math.abs(grand.size - 9) < 0.6, `it's written in Montserrat at the size seen (${grand?.font} ${grand?.size.toFixed(1)}pt)`);
  await shot("card-edited");
  // Edited again, it's the page's own text, read without the spaces pdf.js puts between letter-spaced letters.
  await tap(290, 169);
  await page.waitForSelector(".doxxta-textedit-editor", { timeout: 20000 });
  check((await editor().innerText()) === "GRAND HALL,", `edited again, it reads "GRAND HALL," (${JSON.stringify(await editor().innerText())})`);
  await page.keyboard.press("Escape");
  // Undo brings the picture's text back.
  await st(() => window.__doxxta.runCommand("edit.undo"));
  await page.waitForTimeout(1500);
  const undone = (await readPdf(await build())).text[0].replace(/\s/g, "");
  check(!undone.includes("GRAND"), "Undo takes the edit back");

  // ----- The same card as one picture, with "Text in pictures" in the toolbar -----
  await open("card-picture.pdf");
  await st(() => window.__doxxta.runCommand("mode.edit"));
  await page.click('.context-toolbar button:has-text("Text in pictures")');
  const listed = await page.waitForSelector(".doxxta-text-block.is-seen", { timeout: 60000 }).then(() => true, () => false);
  check(listed && (await st(() => window.__doxxta.useApp.getState().tool)) === "edit-text", "Text in pictures (toolbar) recognizes the page's text in Edit text");
  await tap(290, 149);
  await page.waitForSelector(".doxxta-textedit-editor", { timeout: 20000 });
  check((await editor().innerText()) === "Sam Ethnan Airforce Base, Off Airport Road, Ikeja", "the italic line is recognized");
  await replace("Eko Hotel, Victoria Island, Lagos");
  const eko = (await fontsOf()).find((f) => f.text.startsWith("Eko"));
  check(!!eko && /CormorantGaramond.*Italic/.test(eko.font), `it's written in an italic serif like the card's (${eko?.font})`);
  check((await readPdf(await build())).text[0].includes("Eko Hotel, Victoria Island, Lagos"), "the new line is the page's text");
  await shot("picture-edited");

  // ----- A poster on a gradient: covered with what's behind the text, not with one color -----
  await open("poster-picture.pdf");
  await editText();
  await page.waitForSelector(".doxxta-recognize", { timeout: 15000 });
  await tap(216, 152);
  await page.waitForSelector(".doxxta-textedit-editor", { timeout: 60000 });
  check((await editor().innerText()) === "Up to 50% off everything", `text on a gradient is recognized (${JSON.stringify(await editor().innerText())})`);
  await replace("Up to 70% off");
  // Where "everything" was: the gradient, as just above it.
  const [gone, aboveIt] = await pixels(await build(), [[262, 143, 300, 160], [262, 172, 300, 180]]);
  const step = Math.max(...gone.color.map((v, i) => Math.abs(v - aboveIt.color[i])));
  check(step <= 6, `where the old words were, the gradient goes on (${gone.color} under ${aboveIt.color})`);
  await shot("poster-edited");
}
