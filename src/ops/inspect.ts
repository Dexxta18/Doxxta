import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, loadPdfLib, nameOf, type PDFObject } from "../lib/pdflib";

export interface FontInfo {
  name: string;
  type: string;
  encoding: string;
  embedded: boolean;
  subset: boolean;
  pages: number[];
}

/** Lists fonts referenced by page (and nested form XObject) resources. */
export async function listFonts(bytes: Uint8Array): Promise<FontInfo[]> {
  const doc = await loadPdfLib(bytes);
  const ctx = doc.context;
  const look = (o: PDFObject | undefined) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const fonts = new Map<string, FontInfo>();
  const visitedRes = new Set<PDFObject>();

  const visitResources = (res: PDFObject | undefined, pageIndex: number) => {
    const r = look(res);
    if (!(r instanceof PDFDict) || visitedRes.has(r)) return;
    visitedRes.add(r);
    const fontDict = look(r.get(PDFName.of("Font")));
    if (fontDict instanceof PDFDict) {
      for (const [, v] of fontDict.entries()) {
        const f = look(v);
        if (!(f instanceof PDFDict)) continue;
        const key = v instanceof PDFRef ? v.tag : String(nameOf(f.get(PDFName.of("BaseFont"))));
        const existing = fonts.get(key);
        if (existing) {
          if (!existing.pages.includes(pageIndex)) existing.pages.push(pageIndex);
          continue;
        }
        const subtype = nameOf(f.get(PDFName.of("Subtype"))) ?? "Unknown";
        const base = nameOf(f.get(PDFName.of("BaseFont"))) ?? "(unnamed)";
        let desc = look(f.get(PDFName.of("FontDescriptor")));
        let type = subtype;
        if (subtype === "Type0") {
          const desc0 = look(f.get(PDFName.of("DescendantFonts")));
          const d0 = desc0 instanceof PDFArray ? look(desc0.get(0)) : undefined;
          if (d0 instanceof PDFDict) {
            desc = look(d0.get(PDFName.of("FontDescriptor")));
            type = `Type0 (${nameOf(d0.get(PDFName.of("Subtype"))) ?? "CID"})`;
          }
        }
        const embedded =
          desc instanceof PDFDict &&
          ["FontFile", "FontFile2", "FontFile3"].some((k) => look((desc as PDFDict).get(PDFName.of(k))) instanceof PDFStream);
        const enc = look(f.get(PDFName.of("Encoding")));
        fonts.set(key, {
          name: base.replace(/^[A-Z]{6}\+/, ""),
          type: type === "Type3" ? "Type 3" : type,
          encoding: enc instanceof PDFName ? enc.decodeText() : enc instanceof PDFDict ? "Custom" : "Built-in",
          embedded: subtype === "Type3" ? true : embedded,
          subset: /^[A-Z]{6}\+/.test(base),
          pages: [pageIndex],
        });
      }
    }
    const xobjects = look(r.get(PDFName.of("XObject")));
    if (xobjects instanceof PDFDict) {
      for (const [, v] of xobjects.entries()) {
        const x = look(v);
        if (x instanceof PDFStream && nameOf(x.dict.get(PDFName.of("Subtype"))) === "Form") visitResources(x.dict.get(PDFName.of("Resources")), pageIndex);
      }
    }
  };

  doc.getPages().forEach((p, i) => visitResources(p.node.Resources(), i));
  return [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name));
}
