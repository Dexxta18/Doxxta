// An invitation card whose text is part of the picture, as design apps export it: the layout of
// test-fixtures/card.pdf (letters drawn as outlines, by outlinedCard below) and card-picture.pdf (the
// card as one image, made by tests/e2e/fixtures.mjs). In PDF points; `top` is a baseline's
// distance from the top of the card.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "@cantoo/pdf-lib";
import fontkit from "@cantoo/fontkit";

const library = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts", "library");

/** A face of the app's font library, e.g. "Montserrat-300" or "CormorantGaramond-400i". */
export const faceFile = (face) => join(library, face.split("-")[0], `${face}.ttf`);

export const CARD = {
  width: 504,
  height: 288,
  background: "#6b7a58",
  ink: "#ffffff",
  strip: { x: 40, top: 56, width: 44, height: 176, color: "#ffffff" },
  rules: [
    [246, 40, 246, 98],
    [334, 40, 334, 98],
    [268, 154, 312, 154],
    [268, 214, 312, 214],
  ],
  items: [
    { text: "THURSDAY", face: "Montserrat-300", size: 9, spacing: 2.2, cx: 200, top: 66 },
    { text: "29", face: "Montserrat-300", size: 30, spacing: 0, cx: 290, top: 76 },
    { text: "2026", face: "Montserrat-400", size: 7.5, spacing: 2, cx: 290, top: 92 },
    { text: "OCTOBER", face: "Montserrat-300", size: 9, spacing: 2.2, cx: 380, top: 66 },
    { text: "NAFOWA HALL,", face: "Montserrat-400", size: 9, spacing: 2.2, cx: 290, top: 122 },
    { text: "Sam Ethnan Airforce Base, Off Airport Road, Ikeja", face: "CormorantGaramond-400i", size: 12, spacing: 0, cx: 290, top: 140 },
    { text: "RECEPTION", face: "Montserrat-400", size: 9, spacing: 2.2, cx: 290, top: 180 },
    { text: "at 01:00 in the Afternoon", face: "CormorantGaramond-400i", size: 12, spacing: 0, cx: 290, top: 198 },
    { text: "COLORS OF THE DAY", face: "Montserrat-400", size: 9, spacing: 2.2, cx: 290, top: 240 },
    { text: "Sage Green and Dusty pink", face: "CormorantGaramond-400i", size: 12, spacing: 0, cx: 290, top: 258 },
    // Reading upwards, in the white strip.
    { text: "INVITE ADMITS ONE", face: "Montserrat-400", size: 7, spacing: 1.6, cx: 62, top: 144, vertical: true, color: "#5d6b4b" },
  ],
};

/** A card as a PDF whose letters are drawn as outlines, not text (test-fixtures/card.pdf, by default). */
export async function outlinedCard(card = CARD) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([card.width, card.height]);
  const f = (v) => +v.toFixed(3);
  const rgbOf = (hex) => [1, 3, 5].map((i) => f(parseInt(hex.slice(i, i + 2), 16) / 255)).join(" ");
  const y = (top) => card.height - top;
  const ops = [`${rgbOf(card.background)} rg 0 0 ${card.width} ${card.height} re f`];
  const s = card.strip;
  ops.push(`${rgbOf(s.color)} rg ${s.x} ${y(s.top + s.height)} ${s.width} ${s.height} re f`);
  ops.push(`${rgbOf(card.ink)} RG 0.6 w`, ...card.rules.map(([x1, t1, x2, t2]) => `${x1} ${y(t1)} m ${x2} ${y(t2)} l S`));
  const fonts = new Map();
  for (const item of card.items) {
    if (!fonts.has(item.face)) fonts.set(item.face, fontkit.create(readFileSync(faceFile(item.face))));
    const font = fonts.get(item.face);
    const run = font.layout(item.text);
    const k = item.size / font.unitsPerEm;
    const width = run.positions.reduce((w, p) => w + p.xAdvance * k, 0) + item.spacing * (run.glyphs.length - 1);
    // Text space (x along the line, y up) to the page: across, or reading upwards.
    const [ox, oy] = item.vertical ? [item.cx + item.size * 0.36, y(item.top) - width / 2] : [item.cx - width / 2, y(item.top)];
    const at = (gx, gy) => (item.vertical ? `${f(ox - gy)} ${f(oy + gx)}` : `${f(ox + gx)} ${f(oy + gy)}`);
    ops.push(`${rgbOf(item.color ?? card.ink)} rg`);
    let pen = 0;
    run.glyphs.forEach((glyph, i) => {
      const p = run.positions[i];
      const dx = pen + p.xOffset * k;
      let cur = [0, 0];
      for (const { command, args } of glyph.path.commands) {
        const pt = (j) => [dx + args[j] * k, args[j + 1] * k];
        if (command === "moveTo") ops.push(`${at(...(cur = pt(0)))} m`);
        else if (command === "lineTo") ops.push(`${at(...(cur = pt(0)))} l`);
        else if (command === "quadraticCurveTo") {
          const [c, e] = [pt(0), pt(2)];
          const c1 = [cur[0] + (2 / 3) * (c[0] - cur[0]), cur[1] + (2 / 3) * (c[1] - cur[1])];
          const c2 = [e[0] + (2 / 3) * (c[0] - e[0]), e[1] + (2 / 3) * (c[1] - e[1])];
          ops.push(`${at(...c1)} ${at(...c2)} ${at(...e)} c`);
          cur = e;
        } else if (command === "bezierCurveTo") {
          ops.push(`${at(...pt(0))} ${at(...pt(2))} ${at(...(cur = pt(4)))} c`);
        } else if (command === "closePath") ops.push("h");
      }
      ops.push("f");
      pen += p.xAdvance * k + item.spacing;
    });
  }
  page.node.addContentStream(doc.context.register(doc.context.flateStream(ops.join("\n"))));
  return doc.save();
}
