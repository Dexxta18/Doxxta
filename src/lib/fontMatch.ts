import { familyKey, nearestWeight, parseFontName } from "./fontNames";
import { desktop } from "./desktop";

/**
 * Finds the font to write new text in, for a font a PDF uses: the same font installed on the
 * computer (desktop app), the same family in the app's font library, an open font made to
 * stand in for it (Carlito for Calibri, Gelasio for Georgia…), or the closest one by kind and
 * weight. Library fonts are in public/fonts (built by scripts/fonts/build_library.py).
 */

export type FontCategory = "sans-serif" | "serif" | "monospace" | "display" | "handwriting";

export interface FontFile {
  family: string;
  weight: number;
  italic: boolean;
  source: "library" | "system";
  /** Library: the file's path in the app. System: the desktop app's id for it. */
  ref: string;
  /** The font's license only allows embedding it whole. */
  noSubset?: boolean;
}

export interface FontFamily {
  family: string;
  category: FontCategory;
  faces: FontFile[];
}

/** A font as a PDF uses it. */
export interface FontWish {
  /** PostScript name, e.g. "HelveticaNeue-LightItalic". */
  name: string;
  /** Family name when known otherwise (e.g. from the font descriptor). */
  familyName?: string;
  family: "serif" | "sans-serif" | "monospace";
  weight?: number;
  bold: boolean;
  italic: boolean;
}

export interface FontChoice {
  file: FontFile;
  family: FontFamily;
  /** The same family as the PDF's, not a stand-in. */
  exact: boolean;
  /** Italics were asked for but the family has none: slant the upright face. */
  slant: boolean;
  /** Bold was asked for but the family is no heavier than regular: embolden it. */
  embolden: boolean;
}

const variants = (prefix: string, upright: Record<number, string>, italic: Record<number, string>, family: string): FontFile[] => [
  ...Object.entries(upright).map(([w, s]) => ({ family, weight: +w, italic: false, source: "library" as const, ref: `${prefix}${s}.ttf` })),
  ...Object.entries(italic).map(([w, s]) => ({ family, weight: +w, italic: true, source: "library" as const, ref: `${prefix}${s}.ttf` })),
];
const four = (family: string, category: FontCategory, prefix: string): FontFamily => ({
  family,
  category,
  faces: variants(prefix, { 400: "Regular", 700: "Bold" }, { 400: "Italic", 700: "BoldItalic" }, family),
});

/** Fonts with the same widths as Arial, Times New Roman, Courier New, Calibri and Cambria. */
const BUILT_IN: FontFamily[] = [
  four("Liberation Sans", "sans-serif", "vendor/pdfjs/standard_fonts/LiberationSans-"),
  four("Liberation Serif", "serif", "fonts/LiberationSerif-"),
  four("Liberation Mono", "monospace", "fonts/LiberationMono-"),
  four("Carlito", "sans-serif", "fonts/Carlito-"),
  four("Caladea", "serif", "fonts/Caladea-"),
];

/** The Liberation font with the widths of Helvetica/Arial, Times or Courier. */
export function builtInFace(kind: FontWish["family"], bold: boolean, italic: boolean): FontFile {
  const family = BUILT_IN[kind === "serif" ? 1 : kind === "monospace" ? 2 : 0];
  return family.faces.find((f) => f.weight === (bold ? 700 : 400) && f.italic === italic)!;
}

/** Open fonts that stand in for fonts that can't be bundled. The first match wins. */
const STAND_INS: [RegExp, string | ((weight: number) => string)][] = [
  [/^helveticaneue/, (w) => (w === 400 || w === 700 ? "Liberation Sans" : "Inter")],
  [/^(arialnarrow|helveticacondensed|helveticanarrow|nimbussansnarrow)/, "Roboto Condensed"],
  [/^(arial|helvetica|arimo|liberationsans|nimbussans|swiss)/, "Liberation Sans"],
  [/^(timesnewroman|times|tinos|liberationserif|nimbusroman|thorndale)/, "Liberation Serif"],
  [/^(couriernew|courier|cousine|liberationmono|nimbusmono)/, "Liberation Mono"],
  [/^calibri/, (w) => (w < 350 ? "Lato" : "Carlito")],
  [/^cambria/, "Caladea"],
  [/^(georgia|constantia)/, "Gelasio"],
  [/^segoeui/, "Open Sans"],
  [/^(verdana|tahoma|dejavusans|bitstreamvera|lucidasans|lucidagrande|candara|corbel)/, "Noto Sans"],
  [/^trebuchet/, "Fira Sans"],
  [/^(centurygothic|avantgarde|itcavantgarde|futura|urwgothic|twcen)/, "Jost"],
  [/^(garamond|adobegaramond|stempelgaramond|sabon)/, "EB Garamond"],
  [/^(bookantiqua|palatino|pagella|minion|crimson)/, "Crimson Pro"],
  [/^(bookman|baskerville|caslon)/, "Libre Baskerville"],
  [/^(centuryschoolbook|century|newcenturyschlbk)/, "PT Serif"],
  [/^franklingothic/, "Libre Franklin"],
  [/^(gillsans|johnston)/, "Cabin"],
  [/^myriad/, "Source Sans 3"],
  [/^(rockwell|memphis|museoslab)/, "Arvo"],
  [/^(consolas|lucidaconsole|monaco|menlo|sfmono|andalemono)/, "Source Code Pro"],
  [/^(comicsans|chalkboard)/, "Comic Neue"],
  [/^impact/, "Anton"],
  [/^(aptos|sfpro|sanfrancisco|systemui|helveticanow|neuehaas)/, "Inter"],
  [/^avenir/, "Nunito Sans"],
  [/^(proximanova|gotham)/, "Montserrat"],
  [/^(bahnschrift|din)/, "Barlow"],
  [/^(didot|bodoni)/, "Playfair Display"],
  [/^(brushscript|edwardian|scriptmt|vivaldi|lucidahandwriting|kunstler)/, "Great Vibes"],
  [/^(segoescript|segoeprint|bradleyhand|inkfree)/, "Caveat"],
];

/** For fonts the library has no stand-in for: by kind, and weights between regular and bold from fonts that have them. */
function closest(kind: FontWish["family"], weight: number): string {
  const plain = weight === 400 || weight === 700;
  if (kind === "serif") return plain ? "Liberation Serif" : "Source Serif 4";
  if (kind === "monospace") return plain ? "Liberation Mono" : "Roboto Mono";
  return plain ? "Liberation Sans" : "Inter";
}

const base = () => new URL(import.meta.env.BASE_URL, typeof document === "undefined" ? location.href : document.baseURI).href;

let libraryPromise: Promise<Map<string, FontFamily>> | null = null;

/** The app's fonts by family key. */
export function fontLibrary(): Promise<Map<string, FontFamily>> {
  libraryPromise ??= fetch(new URL("fonts/library/index.json", base()))
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((index: { family: string; category: FontCategory; faces: { weight: number; italic: boolean; file: string }[] }[]) => {
      const map = new Map<string, FontFamily>();
      for (const f of BUILT_IN) map.set(familyKey(f.family), f);
      for (const f of index) {
        map.set(familyKey(f.family), {
          family: f.family,
          category: f.category,
          faces: f.faces.map((x) => ({ family: f.family, weight: x.weight, italic: x.italic, source: "library", ref: x.file })),
        });
      }
      return map;
    });
  return libraryPromise;
}

let systemPromise: Promise<Map<string, FontFamily>> | null = null;

/** Fonts installed on the computer that may be embedded in documents (desktop app only). */
export function systemFonts(): Promise<Map<string, FontFamily>> {
  systemPromise ??= (desktop?.systemFonts?.() ?? Promise.resolve([]))
    .catch(() => [])
    .then((fonts) => {
      const map = new Map<string, FontFamily>();
      for (const f of fonts) {
        const key = familyKey(f.family);
        if (!key) continue;
        let fam = map.get(key);
        if (!fam) map.set(key, (fam = { family: f.family, category: "sans-serif", faces: [] }));
        fam.faces.push({ family: f.family, weight: f.weight, italic: f.italic, source: "system", ref: f.id, noSubset: f.noSubset });
      }
      return map;
    });
  return systemPromise;
}

/** The face of a family nearest a weight, in the slant asked for when the family has it. */
export function pickFace(family: FontFamily, weight: number, italic: boolean, exact: boolean): FontChoice {
  const same = family.faces.filter((f) => f.italic === italic);
  const pool = same.length ? same : family.faces.filter((f) => !f.italic).length ? family.faces.filter((f) => !f.italic) : family.faces;
  const w = nearestWeight(pool.map((f) => f.weight), weight);
  const file = pool.find((f) => f.weight === w)!;
  return { file, family, exact, slant: italic && !file.italic, embolden: weight >= 600 && file.weight < 550 };
}

/** The font to write text in, for a PDF font. */
export async function matchFont(wish: FontWish): Promise<FontChoice> {
  const [library, system] = await Promise.all([fontLibrary(), systemFonts()]);
  const parsed = parseFontName(wish.name);
  const key = parsed.key || familyKey(wish.familyName ?? "");
  const weight = wish.weight ?? parsed.weight ?? (wish.bold ? 700 : 400);
  const italic = wish.italic;
  const find = (k: string) => (parsed.condensed && (system.get(`${k}condensed`) ?? library.get(`${k}condensed`))) || system.get(k) || library.get(k);
  if (key) {
    const same = find(key);
    if (same) return pickFace(same, weight, italic, true);
    const stand = STAND_INS.find(([re]) => re.test(key));
    const name = stand && (typeof stand[1] === "function" ? stand[1](weight) : stand[1]);
    const standIn = name && (system.get(familyKey(name)) ?? library.get(familyKey(name)));
    if (standIn) return pickFace(standIn, weight, italic, false);
  }
  const kind = closest(wish.family, weight);
  return pickFace(library.get(familyKey(kind)) ?? BUILT_IN[0], weight, italic, false);
}

/** A family by name, from the computer's fonts or the library (for the font menu). */
export async function familyByName(name: string): Promise<FontFamily | undefined> {
  const [library, system] = await Promise.all([fontLibrary(), systemFonts()]);
  const key = familyKey(name);
  return system.get(key) ?? library.get(key);
}

const bytesCache = new Map<string, Promise<Uint8Array>>();

/** The font file's bytes. */
export function fontBytes(file: FontFile): Promise<Uint8Array> {
  const id = `${file.source}:${file.ref}`;
  let bytes = bytesCache.get(id);
  if (!bytes) {
    bytes =
      file.source === "system"
        ? desktop!.fontFile!(file.ref)
        : fetch(new URL(file.ref, base())).then(async (r) => {
            if (!r.ok) throw new Error(`The font ${file.family} couldn't be loaded.`);
            return new Uint8Array(await r.arrayBuffer());
          });
    bytes.catch(() => bytesCache.delete(id));
    bytesCache.set(id, bytes);
  }
  return bytes;
}

const cssFaces = new Map<string, Promise<boolean>>();

/**
 * Makes a family usable in the page's CSS under the name "Doxxta <family>", face by face as
 * they're needed (the browser picks a face by font-weight and font-style). Returns that name.
 */
export function cssFamily(family: FontFamily): string {
  const name = `Doxxta ${family.family}`;
  for (const file of family.faces) {
    const id = `${name}|${file.weight}|${file.italic}`;
    if (cssFaces.has(id)) continue;
    const descriptors = { weight: String(file.weight), style: file.italic ? "italic" : "normal" };
    const face =
      file.source === "library"
        ? new FontFace(name, `url("${new URL(file.ref, base()).href}")`, descriptors)
        : null;
    if (face) {
      document.fonts.add(face);
      cssFaces.set(id, Promise.resolve(true));
    } else {
      // Installed fonts come from the desktop app as bytes.
      cssFaces.set(
        id,
        fontBytes(file)
          .then((bytes) => new FontFace(name, bytes.slice().buffer as ArrayBuffer, descriptors).load())
          .then((f) => (document.fonts.add(f), true))
          .catch(() => false),
      );
    }
  }
  return `"${name}"`;
}

/** Families for the font menu: those the PDF uses first, then the library's (and, in the desktop app, the computer's). */
export async function fontMenu(): Promise<{ family: string; category: FontCategory | "installed" }[]> {
  const [library, system] = await Promise.all([fontLibrary(), systemFonts()]);
  const out = [...library.values()].map((f) => ({ family: f.family, category: f.category as FontCategory | "installed" }));
  const known = new Set(out.map((f) => familyKey(f.family)));
  for (const f of system.values()) if (!known.has(familyKey(f.family))) out.push({ family: f.family, category: "installed" });
  return out.sort((a, b) => a.family.localeCompare(b.family));
}
