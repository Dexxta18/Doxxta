#!/usr/bin/env python3
"""Builds the font library in public/fonts/library from Google Fonts.

For each family: Light, Regular, SemiBold and Bold, upright and italic where the family has
them, as static TrueType fonts cut down to Latin, Greek and Cyrillic, with the family's
license, plus index.json listing every face. Edit text uses them to write text in the font
a PDF uses (or one like it), and shows them while you type.

Needs fontTools:  python3 -m pip install fonttools
Run from the project folder:  python3 scripts/fonts/build_library.py
"""
import io
import json
import os
import re
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
OUT = os.path.join(ROOT, "public", "fonts", "library")
GOOGLE = "https://raw.githubusercontent.com/google/fonts/main"

# Google Fonts folders (the family's name without spaces, lowercased).
FAMILIES = [
    # Sans serif
    "roboto", "opensans", "montserrat", "poppins", "lato", "inter", "oswald", "raleway", "notosans",
    "nunito", "nunitosans", "rubik", "ubuntu", "worksans", "ptsans", "dmsans", "mulish", "quicksand",
    "firasans", "barlow", "manrope", "ibmplexsans", "titilliumweb", "karla", "sourcesans3", "josefinsans",
    "librefranklin", "cabin", "jost", "figtree", "outfit", "plusjakartasans", "lexend", "archivo",
    "robotocondensed", "spacegrotesk", "questrial",
    # Serif
    "playfairdisplay", "merriweather", "lora", "robotoslab", "librebaskerville", "notoserif", "ebgaramond",
    "sourceserif4", "crimsonpro", "ptserif", "bitter", "cormorantgaramond", "gelasio", "arvo", "zillaslab",
    "dmserifdisplay",
    # Monospace
    "robotomono", "sourcecodepro", "ibmplexmono", "inconsolata", "jetbrainsmono", "spacemono",
    # Display and handwriting
    "bebasneue", "abrilfatface", "anton", "dancingscript", "pacifico", "caveat", "greatvibes", "comicneue", "lobster",
]
WEIGHTS = [300, 400, 600, 700]
STYLE = {100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black"}
CATEGORY = {"SANS_SERIF": "sans-serif", "SERIF": "serif", "MONOSPACE": "monospace", "DISPLAY": "display", "HANDWRITING": "handwriting"}
# Basic Latin to Latin Extended-B, IPA bits, spacing modifiers, combining marks, Greek, Cyrillic,
# Latin Extended Additional (Vietnamese), punctuation, currency, letterlike symbols, arrows,
# math operators, shapes (bullets), and the fi/fl ligatures.
UNICODES = [*range(0x20, 0x250), 0x259, *range(0x2B0, 0x370), *range(0x370, 0x400), *range(0x400, 0x530),
            *range(0x1E00, 0x1F00), *range(0x2000, 0x2070), *range(0x20A0, 0x20D0), *range(0x2100, 0x2150),
            *range(0x2190, 0x2200), *range(0x2200, 0x2300), *range(0x25A0, 0x2600), *range(0xFB00, 0xFB07)]


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def metadata(folder):
    """The family's METADATA.pb, parsed just enough: name, category, license folder, fonts and axes."""
    for lic in ("ofl", "apache", "ufl"):
        try:
            text = fetch(f"{GOOGLE}/{lic}/{folder}/METADATA.pb").decode()
        except Exception:
            continue
        fonts = [dict(re.findall(r'(\w+): "?([^"\n]+)"?', block)) for block in re.findall(r"fonts \{(.*?)\n\}", text, re.S)]
        axes = {m[0]: (float(m[1]), float(m[2])) for m in re.findall(r'axes \{\s*tag: "(\w+)"\s*min_value: ([\d.]+)\s*max_value: ([\d.]+)', text)}
        name = re.search(r'^name: "([^"]+)"', text, re.M).group(1)
        category = re.search(r'^category: "(\w+)"', text, re.M).group(1)
        return {"name": name, "category": CATEGORY.get(category, "sans-serif"), "lic": lic, "fonts": fonts, "axes": axes}
    raise RuntimeError(f"No Google Fonts family in folder {folder}")


def finish(font, family, weight, italic, path):
    """Cuts a static font down to the library's characters, names it, and saves it."""
    opts = subset.Options()
    opts.layout_features = []  # Text is drawn glyph by glyph: no ligatures or kerning to account for.
    opts.hinting = False
    opts.desubroutinize = True
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    style = STYLE[weight] if not italic else ("Italic" if weight == 400 else STYLE[weight] + "Italic")
    ps = re.sub(r"[^A-Za-z0-9]", "", family) + "-" + style
    names = font["name"]
    names.removeNames(nameID=16)
    names.removeNames(nameID=17)
    names.removeNames(nameID=25)
    for nid, value in ((1, f"{family} {STYLE[weight]}" if weight not in (400, 700) else family), (2, ("Bold " if weight == 700 else "") + ("Italic" if italic else "Regular") if weight in (400, 700) else ("Italic" if italic else "Regular")),
                       (4, f"{family} {style}"), (6, ps), (16, family), (17, style)):
        names.setName(value, nid, 3, 1, 0x409)
    if "OS/2" in font:
        font["OS/2"].usWeightClass = weight
        sel = font["OS/2"].fsSelection & ~0b1100001
        font["OS/2"].fsSelection = sel | (1 if italic else 0) | (0b100000 if weight == 700 else 0) | (0b1000000 if weight == 400 and not italic else 0)
    font["head"].macStyle = (2 if italic else 0) | (1 if weight == 700 else 0)
    if "STAT" in font:
        del font["STAT"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    font.save(path)


def build(folder):
    meta = metadata(folder)
    family = meta["name"]
    slug = re.sub(r"[^A-Za-z0-9]", "", family)
    faces = []
    sources = {}
    for f in meta["fonts"]:
        sources.setdefault((f.get("style") == "italic", int(f.get("weight", 400))), f["filename"])
    cache = {}

    def source(name):
        if name not in cache:
            cache[name] = fetch(f"{GOOGLE}/{meta['lic']}/{folder}/{name}")
        return cache[name]

    variable = "wght" in meta["axes"]
    for italic in (False, True):
        files = {w: n for (i, w), n in sources.items() if i == italic}
        if not files:
            continue
        if variable:
            lo, hi = meta["axes"]["wght"]
            wanted = sorted({min(max(w, int(lo)), int(hi)) for w in WEIGHTS})
        else:
            # Static families: the faces they have that are nearest to the library's weights.
            wanted = sorted({min(files, key=lambda a: (abs(a - w), a)) for w in WEIGHTS})
        for w in wanted:
            out = f"{slug}/{slug}-{w}{'i' if italic else ''}.ttf"
            if variable:
                font = TTFont(io.BytesIO(source(next(iter(files.values())))))
                axes = {a.axisTag: a.defaultValue for a in font["fvar"].axes}
                axes["wght"] = w
                font = instancer.instantiateVariableFont(font, axes)
            else:
                font = TTFont(io.BytesIO(source(files[w])))
            finish(font, family, w, italic, os.path.join(OUT, out))
            faces.append({"weight": w, "italic": italic, "file": f"fonts/library/{out}"})
    license_file = {"ofl": "OFL.txt", "apache": "LICENSE.txt", "ufl": "UFL.txt"}[meta["lic"]]
    with open(os.path.join(OUT, slug, license_file), "wb") as fh:
        fh.write(fetch(f"{GOOGLE}/{meta['lic']}/{folder}/{license_file}"))
    return {"family": family, "category": meta["category"], "faces": faces, "license": f"fonts/library/{slug}/{license_file}"}


def main():
    only = sys.argv[1:]
    index_path = os.path.join(OUT, "index.json")
    index = {f["family"]: f for f in json.load(open(index_path))} if os.path.exists(index_path) else {}
    for folder in (only or FAMILIES):
        try:
            entry = build(folder)
            index[entry["family"]] = entry
            print(f"{entry['family']}: {len(entry['faces'])} faces", flush=True)
        except Exception as e:  # Keep going: one family failing shouldn't stop the rest.
            print(f"{folder}: FAILED {e}", file=sys.stderr, flush=True)
    families = sorted(index.values(), key=lambda f: f["family"])
    with open(index_path, "w") as fh:
        json.dump(families, fh, indent=1)
    print(f"{len(families)} families in {index_path}")


if __name__ == "__main__":
    main()
