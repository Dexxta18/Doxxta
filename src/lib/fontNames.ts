/**
 * Reads font names as PDFs store them ("ABCDEF+HelveticaNeue-LightItalic",
 * "Arial-BoldMT", "TimesNewRomanPS-BoldItalicMT", "Calibri,Bold", "Montserrat-SemiBold")
 * into a family, a weight (100–900) and italics.
 */

export interface ParsedFontName {
  /** Family name with spaces, e.g. "Helvetica Neue". Empty when the name says nothing (e.g. "F1"). */
  family: string;
  /** The family as a key for comparing names: lowercase letters and digits only, without "MT", "PS", "Pro"… */
  key: string;
  /** Weight the name states, if it states one. */
  weight?: number;
  italic: boolean;
  /** Narrow or condensed. */
  condensed: boolean;
}

/** Style words in font names, longest first so "ExtraLight" isn't read as "Light". */
const WEIGHT_WORDS: [RegExp, number][] = [
  [/^(hairline|thin)/, 100],
  [/^(extralight|ultralight|extlight)/, 200],
  [/^(semilight|demilight)/, 350],
  [/^light/, 300],
  [/^(semibold|demibold|demi|sbold|semibd)/, 600],
  [/^(extrabold|ultrabold|xbold)/, 800],
  [/^(extrablack|ultrablack|fat|poster)/, 950],
  [/^(black|heavy|ultra)/, 900],
  [/^(bold|bd)/, 700],
  [/^(medium|med)/, 500],
  [/^(regular|normal|book|roman|plain|reg|text)/, 400],
];
const ITALIC_WORDS = /^(italic|oblique|ital|obl|it|slanted|kursiv)/;
const WIDTH_WORDS = /^(condensed|compressed|narrow|cond|cn|extended|expanded|wide|semicondensed)/;
/** Vendor and format tags that end many PostScript names. */
const TAGS = /(psmt|mt|ps|std|pro|lt|ot|ttf|otf|w\d\d|ce|cyr|wgl4)$/;

/** A family name as a key: "Times New Roman" and "TimesNewRomanPSMT" both become "timesnewroman". */
export function familyKey(name: string): string {
  let k = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < 3; i++) {
    const before = k;
    k = k.replace(TAGS, "").replace(/\d+$/, "");
    if (k === before) break;
  }
  return k;
}

/** Splits "HelveticaNeue" into "Helvetica Neue"; "IBMPlexSans" into "IBM Plex Sans". */
function spaced(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_]+/g, " ")
    .trim();
}

/** Reads the style part of a name ("BoldItalic", "LightIt", "SemiboldCond") into weight, italics and width. */
function readStyle(style: string, out: ParsedFontName) {
  let s = style.toLowerCase().replace(/[^a-z0-9]/g, "");
  let guard = 0;
  while (s && guard++ < 8) {
    const w = WEIGHT_WORDS.find(([re]) => re.test(s));
    if (w) {
      out.weight = w[1];
      s = s.replace(w[0], "");
      continue;
    }
    const it = ITALIC_WORDS.exec(s);
    if (it) {
      out.italic = true;
      s = s.slice(it[0].length);
      continue;
    }
    const wd = WIDTH_WORDS.exec(s);
    if (wd) {
      out.condensed = out.condensed || !/extended|expanded|wide/.test(wd[0]);
      s = s.slice(wd[0].length);
      continue;
    }
    // Vendor tags ("MT") and unknown words.
    s = s.replace(/^(psmt|mt|ps|[a-z]{1,2}\d*)/, "");
    if (!/^[a-z]/.test(s)) break;
  }
}

/** Style words a family name may end with when the name has no "-" before its style ("CalibriBold"). */
const TRAILING_STYLE = /(Thin|Hairline|ExtraLight|UltraLight|Light|SemiLight|Regular|Book|Medium|SemiBold|DemiBold|Demi|ExtraBold|UltraBold|Bold|Black|Heavy|Italic|Oblique|It|Condensed|Cond|Narrow|MT|PS|PSMT)$/;

export function parseFontName(raw: string): ParsedFontName {
  // Without the subset tag: "ABCDEF+" before the name, or (pdf-lib) "-1234" after its style.
  const name = raw
    .replace(/^[A-Z]{6}\+/, "")
    .replace(/(-[A-Za-z][^-]*)-\d{1,4}$/, "$1")
    .trim();
  const out: ParsedFontName = { family: "", key: "", italic: false, condensed: false };
  if (!name) return out;
  // "Family-Style", "Family,Style" (older TrueType names) or "Family Style".
  let [fam, style = ""] = name.split(/[-,](?=[^-,]*$)/);
  if (!style && /\s/.test(name)) {
    const words = name.split(/\s+/);
    const firstStyle = words.findIndex((w, i) => i > 0 && (WEIGHT_WORDS.some(([re]) => re.test(w.toLowerCase())) || ITALIC_WORDS.test(w.toLowerCase())));
    if (firstStyle > 0) {
      fam = words.slice(0, firstStyle).join(" ");
      style = words.slice(firstStyle).join("");
    }
  }
  readStyle(style, out);
  // Styles glued to the family ("CalibriBold", "ArialBoldMT", "TimesNewRomanPSMT").
  let guard = 0;
  while (TRAILING_STYLE.test(fam) && guard++ < 4) {
    const m = TRAILING_STYLE.exec(fam)!;
    if (fam.length - m[0].length < 3) break;
    readStyle(m[0], out);
    fam = fam.slice(0, fam.length - m[0].length);
  }
  fam = fam.replace(/[-_,\s]+$/, "");
  // Non-descriptive names ("F1", "TT0", "T1_0", "Font3") say nothing about the family.
  if (/^(f|tt|t|c|font|ft)\d+(_\d+)?$/i.test(fam)) return out;
  out.family = spaced(fam.replace(/(PSMT|PS|MT|Std|LT)$/, ""));
  out.key = familyKey(fam);
  return out;
}

/** CSS-like choice of the face nearest a weight: heavier ones first above 500, lighter ones first below 400. */
export function nearestWeight(available: number[], target: number): number {
  return [...available].sort((a, b) => {
    const da = Math.abs(a - target),
      db = Math.abs(b - target);
    if (da !== db) return da - db;
    return target > 500 ? b - a : a - b;
  })[0];
}
