// An invitation card whose text is part of the picture, as design apps export it: the layout of
// test-fixtures/card.pdf (letters drawn as outlines, by make-fixtures.mjs) and card-picture.pdf (the
// card as one image, made by tests/e2e/fixtures.mjs). In PDF points; `top` is a baseline's
// distance from the top of the card.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
