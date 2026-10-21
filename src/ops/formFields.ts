import {
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  degrees,
  rgb,
  pdfText,
  type FontCache,
  type PDFDocument,
  type PDFPage,
  type PDFForm,
} from "../lib/pdflib";
import type { FieldAnnot } from "../annotations/types";
import { hexToPdf } from "../lib/colors";

const c = (hex: string | null | undefined) => {
  if (!hex) return undefined;
  const [r, g, b] = hexToPdf(hex);
  return rgb(r, g, b);
};

function uniqueName(form: PDFForm, name: string): string {
  const taken = new Set(form.getFields().map((f) => f.getName()));
  if (!taken.has(name)) return name;
  let i = 2;
  while (taken.has(`${name}_${i}`)) i++;
  return `${name}_${i}`;
}

function widgetOptions(f: FieldAnnot, page: PDFPage) {
  const [x1, y1, x2, y2] = f.rect;
  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    borderColor: c(f.borderColor),
    backgroundColor: c(f.fillColor),
    textColor: c(f.textColor),
    borderWidth: f.borderColor ? 1 : 0,
    rotate: degrees(page.getRotation().angle),
  };
}

/** Sets an additional-action JavaScript on the field's (single) widget/field dict. */
function setFieldJs(doc: PDFDocument, fieldDict: PDFDict, trigger: "F" | "K" | "V", js: string) {
  const ctx = doc.context;
  let aa = fieldDict.lookupMaybe(PDFName.of("AA"), PDFDict);
  if (!aa) {
    aa = ctx.obj({});
    fieldDict.set(PDFName.of("AA"), aa);
  }
  aa.set(PDFName.of(trigger), ctx.obj({ S: "JavaScript", JS: pdfText(js) }));
}

/** Creates the AcroForm fields designed in "Prepare form". */
export async function writeFormFields(doc: PDFDocument, fields: FieldAnnot[], pageIds: string[], fonts: FontCache) {
  const form = doc.getForm();
  const pages = doc.getPages();
  const pageIndex = new Map(pageIds.map((id, i) => [id, i]));
  const helv = fonts.get("Helvetica");
  const radios = new Map<string, ReturnType<PDFForm["createRadioGroup"]>>();

  for (const f of fields) {
    const pi = pageIndex.get(f.pageId);
    if (pi === undefined) continue;
    const page = pages[pi];
    const opts = widgetOptions(f, page);
    try {
      switch (f.fieldType) {
        case "text":
        case "date": {
          const tf = form.createTextField(uniqueName(form, f.name));
          if (f.multiline) tf.enableMultiline();
          if (f.maxLength > 0) tf.setMaxLength(f.maxLength);
          if (f.defaultValue) tf.setText(f.defaultValue);
          tf.addToPage(page, { ...opts, font: helv });
          if (f.fontSize > 0) tf.setFontSize(f.fontSize);
          applyFlags(tf, f);
          if (f.fieldType === "date") {
            setFieldJs(doc, tf.acroField.dict, "F", `AFDate_FormatEx("${f.dateFormat}");`);
            setFieldJs(doc, tf.acroField.dict, "K", `AFDate_KeystrokeEx("${f.dateFormat}");`);
          }
          if (f.tooltip) tf.acroField.dict.set(PDFName.of("TU"), pdfText(f.tooltip));
          break;
        }
        case "checkbox": {
          const cb = form.createCheckBox(uniqueName(form, f.name));
          cb.addToPage(page, opts);
          if (f.defaultValue === "true" || f.defaultValue === "Yes") cb.check();
          applyFlags(cb, f);
          if (f.tooltip) cb.acroField.dict.set(PDFName.of("TU"), pdfText(f.tooltip));
          break;
        }
        case "radio": {
          let group = radios.get(f.name);
          if (!group) {
            group = form.createRadioGroup(uniqueName(form, f.name));
            radios.set(f.name, group);
            if (f.tooltip) group.acroField.dict.set(PDFName.of("TU"), pdfText(f.tooltip));
          }
          group.addOptionToPage(f.exportValue || `Choice${group.getOptions().length + 1}`, page, opts);
          applyFlags(group, f);
          break;
        }
        case "dropdown": {
          const dd = form.createDropdown(uniqueName(form, f.name));
          dd.addOptions(f.options.filter(Boolean));
          if (f.defaultValue && f.options.includes(f.defaultValue)) dd.select(f.defaultValue);
          dd.addToPage(page, { ...opts, font: helv });
          if (f.fontSize > 0) dd.setFontSize(f.fontSize);
          applyFlags(dd, f);
          if (f.tooltip) dd.acroField.dict.set(PDFName.of("TU"), pdfText(f.tooltip));
          break;
        }
        case "listbox": {
          const ol = form.createOptionList(uniqueName(form, f.name));
          ol.addOptions(f.options.filter(Boolean));
          if (f.defaultValue && f.options.includes(f.defaultValue)) ol.select(f.defaultValue);
          ol.addToPage(page, { ...opts, font: helv });
          if (f.fontSize > 0) ol.setFontSize(f.fontSize);
          applyFlags(ol, f);
          if (f.tooltip) ol.acroField.dict.set(PDFName.of("TU"), pdfText(f.tooltip));
          break;
        }
        case "button": {
          const btn = form.createButton(uniqueName(form, f.name));
          btn.addToPage(f.caption || "Button", page, { ...opts, font: helv, backgroundColor: c(f.fillColor ?? "#e8ecf5") });
          const widgets = btn.acroField.getWidgets();
          const widgetDict = widgets[0]?.dict;
          if (widgetDict) {
            let action: Record<string, unknown> | null = null;
            if (f.action === "reset") action = { S: "ResetForm" };
            else if (f.action === "print") action = { S: "JavaScript", JS: pdfText("this.print({bUI: true});") };
            else if (f.action === "url" && f.actionUrl) action = { S: "URI", URI: pdfText(f.actionUrl) };
            if (action) widgetDict.set(PDFName.of("A"), doc.context.obj(action as never));
          }
          if (f.tooltip) btn.acroField.dict.set(PDFName.of("TU"), pdfText(f.tooltip));
          break;
        }
        case "signature":
          addSignatureField(doc, page, f, uniqueName(form, f.name));
          break;
      }
    } catch (e) {
      console.warn(`Could not create field ${f.name}`, e);
    }
  }
}

function applyFlags(field: { enableRequired(): void; enableReadOnly(): void }, f: FieldAnnot) {
  if (f.required) field.enableRequired();
  if (f.readOnly) field.enableReadOnly();
}

/** pdf-lib has no signature-field API; build the field + widget by hand. */
function addSignatureField(doc: PDFDocument, page: PDFPage, f: FieldAnnot, name: string) {
  const ctx = doc.context;
  const form = doc.getForm();
  const [x1, y1, x2, y2] = f.rect;
  const ap = ctx.register(
    ctx.flateStream(`0.95 0.96 1 rg 0 0 ${x2 - x1} ${y2 - y1} re f 0.6 0.65 0.75 RG 0.75 w 0.5 0.5 ${x2 - x1 - 1} ${y2 - y1 - 1} re S`, {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, x2 - x1, y2 - y1],
    } as never),
  );
  const widget = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    T: pdfText(name),
    Rect: [x1, y1, x2, y2],
    F: 4,
    P: page.ref,
    AP: { N: ap },
    ...(f.tooltip ? { TU: pdfText(f.tooltip) } : {}),
    ...(f.required ? { Ff: 2 } : {}),
  } as never) as unknown as PDFDict;
  const ref = ctx.register(widget);
  let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) {
    annots = ctx.obj([]);
    page.node.set(PDFName.of("Annots"), annots);
  }
  annots.push(ref);
  const acro = form.acroForm.dict;
  let fieldsArr = acro.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fieldsArr) {
    fieldsArr = ctx.obj([]);
    acro.set(PDFName.of("Fields"), fieldsArr);
  }
  fieldsArr.push(ref as PDFRef);
  acro.set(PDFName.of("SigFlags"), ctx.obj(1));
}
