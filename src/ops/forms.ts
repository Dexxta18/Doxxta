import {
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  PDFName,
  loadPdfLib,
  decodeText,
  type PDFForm,
} from "../lib/pdflib";
import { applyDocumentChange } from "../core/document";
import { getRuntime } from "../state/runtime";
import { getDoc, toast, withBusy } from "../state/store";
import { downloadBlob, escapeXml, withExt } from "../lib/util";

export type FormValue = string | string[] | boolean;

interface FieldObject {
  id: string;
  type: string;
  value: unknown;
  exportValues?: string;
  buttonValue?: string;
  defaultValue?: unknown;
}

/** Current form values, including edits made in the viewer (pdf.js annotation storage). */
export async function getFormValues(docId: string): Promise<Record<string, FormValue>> {
  const rt = getRuntime(docId);
  if (!rt) return {};
  const objs = (await rt.pdf.getFieldObjects()) as Map<string, FieldObject[]> | null;
  const storage = rt.pdf.annotationStorage as unknown as { getValue(id: string, def: object): Record<string, unknown> };
  const out: Record<string, FormValue> = {};
  for (const [name, all] of objs ?? []) {
    // Field nodes without a type are parents or non-widget entries; values live on the widgets.
    const widgets = all.filter((w) => w.type && w.id);
    const w0 = widgets[0];
    if (!w0) continue;
    switch (w0.type) {
      case "checkbox": {
        const checked = widgets.some((w) => {
          const v = storage.getValue(w.id, { value: w.value && w.value !== "Off" }).value;
          return v === true || (typeof v === "string" && v !== "Off" && v !== "");
        });
        out[name] = checked ? (w0.exportValues ?? "Yes") : "Off";
        break;
      }
      case "radiobutton": {
        let value = "Off";
        for (const w of widgets) {
          const v = storage.getValue(w.id, { value: w.value === w.buttonValue }).value;
          if (v === true) value = w.buttonValue ?? value;
        }
        out[name] = value;
        break;
      }
      case "button":
      case "signature":
        break;
      default: {
        let v: unknown = w0.value;
        for (const w of widgets) {
          const stored = storage.getValue(w.id, {}).value;
          if (stored !== undefined) {
            v = stored;
            break;
          }
        }
        out[name] = Array.isArray(v) ? (v as string[]) : v === undefined || v === null ? "" : String(v);
      }
    }
  }
  return out;
}

function toCsv(values: Record<string, FormValue>) {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const keys = Object.keys(values);
  const vals = keys.map((k) => {
    const v = values[k];
    return esc(Array.isArray(v) ? v.join("; ") : String(v));
  });
  return `${keys.map(esc).join(",")}\n${vals.join(",")}\n`;
}

function toXfdf(values: Record<string, FormValue>, file: string) {
  const fields = Object.entries(values)
    .map(([k, v]) => `<field name="${escapeXml(k)}">${(Array.isArray(v) ? v : [String(v)]).map((x) => `<value>${escapeXml(x)}</value>`).join("")}</field>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n<f href="${escapeXml(file)}"/>\n<fields>\n${fields}\n</fields>\n</xfdf>\n`;
}

function fdfString(s: string) {
  return `(${s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r?\n/g, "\\r")})`;
}

function toFdf(values: Record<string, FormValue>, file: string) {
  const fields = Object.entries(values)
    .map(([k, v]) => {
      const val = Array.isArray(v) ? `[${v.map(fdfString).join(" ")}]` : v === "Off" || v === "Yes" ? `/${v}` : fdfString(String(v));
      return `<< /T ${fdfString(k)} /V ${val} >>`;
    })
    .join("\n");
  return `%FDF-1.2\n1 0 obj\n<< /FDF << /F ${fdfString(file)} /Fields [\n${fields}\n] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
}

export async function exportFormData(docId: string, format: "json" | "csv" | "xfdf" | "fdf") {
  const doc = getDoc(docId);
  if (!doc) return;
  const values = await getFormValues(docId);
  if (!Object.keys(values).length) {
    toast("This document has no fillable fields", "info");
    return;
  }
  const body =
    format === "json" ? JSON.stringify(values, null, 2) : format === "csv" ? toCsv(values) : format === "xfdf" ? toXfdf(values, doc.name) : toFdf(values, doc.name);
  const mime = { json: "application/json", csv: "text/csv", xfdf: "application/vnd.adobe.xfdf", fdf: "application/vnd.fdf" }[format];
  downloadBlob(new Blob([body], { type: mime }), withExt(doc.name, format));
}

/** Parses JSON, CSV (header + first row), XFDF or FDF form data. */
export function parseFormData(text: string, fileName: string): Record<string, FormValue> {
  const t = text.trim();
  if (/\.json$/i.test(fileName) || t.startsWith("{")) return JSON.parse(t);
  if (t.startsWith("<")) {
    const dom = new DOMParser().parseFromString(t, "application/xml");
    const out: Record<string, FormValue> = {};
    const walk = (el: Element, prefix: string) => {
      for (const f of Array.from(el.children).filter((c) => c.tagName === "field")) {
        const name = prefix ? `${prefix}.${f.getAttribute("name")}` : (f.getAttribute("name") ?? "");
        const vals = Array.from(f.children).filter((c) => c.tagName === "value").map((v) => v.textContent ?? "");
        if (vals.length) out[name] = vals.length > 1 ? vals : vals[0];
        walk(f, name);
      }
    };
    const fields = dom.getElementsByTagName("fields")[0];
    if (fields) walk(fields, "");
    return out;
  }
  if (t.startsWith("%FDF")) {
    const out: Record<string, FormValue> = {};
    const re = /\/T\s*\(((?:\\.|[^\\)])*)\)\s*\/V\s*(\((?:\\.|[^\\)])*\)|\/\w+|\[[^\]]*\])/g;
    const unesc = (s: string) => s.replace(/\\r/g, "\n").replace(/\\([()\\])/g, "$1");
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const v = m[2];
      out[unesc(m[1])] = v.startsWith("(") ? unesc(v.slice(1, -1)) : v.startsWith("/") ? v.slice(1) : (v.match(/\((?:\\.|[^\\)])*\)/g) ?? []).map((x) => unesc(x.slice(1, -1)));
    }
    return out;
  }
  // CSV: first line names, second line values.
  const rows = t.split(/\r?\n/).map(parseCsvLine);
  const out: Record<string, FormValue> = {};
  rows[0]?.forEach((k, i) => (out[k] = rows[1]?.[i] ?? ""));
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function setValue(form: PDFForm, name: string, v: FormValue): boolean {
  let field;
  try {
    field = form.getField(name);
  } catch {
    return false;
  }
  try {
    if (field instanceof PDFTextField) field.setText(Array.isArray(v) ? v.join(", ") : String(v));
    else if (field instanceof PDFCheckBox) {
      if (v === true || (typeof v === "string" && v !== "Off" && v !== "" && v.toLowerCase() !== "false")) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup) {
      if (v === "Off" || v === "") field.clear();
      else field.select(String(v));
    } else if (field instanceof PDFDropdown) {
      if (v === "") field.clear();
      else field.select(Array.isArray(v) ? v : String(v));
    } else if (field instanceof PDFOptionList) {
      if (v === "") field.clear();
      else field.select(Array.isArray(v) ? v : [String(v)]);
    } else return false;
    return true;
  } catch (e) {
    console.warn(`Could not set ${name}`, e);
    return false;
  }
}

export async function importFormData(docId: string, values: Record<string, FormValue>) {
  let applied = 0;
  await withBusy("Importing form data…", async () => {
    await applyDocumentChange(docId, "Import form data", async ({ bytes, pageIds }) => {
      const pdfDoc = await loadPdfLib(bytes);
      const form = pdfDoc.getForm();
      for (const [k, v] of Object.entries(values)) if (setValue(form, k, v)) applied++;
      return { bytes: await pdfDoc.save(), pageIds };
    });
  });
  toast(applied ? `Filled ${applied} field${applied === 1 ? "" : "s"}` : "No matching fields were found", applied ? "success" : "warning");
}

/** Clears every field back to its default value (or empty). */
export async function resetForm(docId: string) {
  const doc = getDoc(docId);
  if (!doc?.hasForms) {
    toast("This document has no fillable fields", "info");
    return;
  }
  await withBusy("Clearing form…", async () => {
    await applyDocumentChange(docId, "Clear form", async ({ bytes, pageIds }) => {
      const pdfDoc = await loadPdfLib(bytes);
      const form = pdfDoc.getForm();
      for (const f of form.getFields()) {
        const dv = f.acroField.dict.get(PDFName.of("DV"));
        const def = dv ? decodeText(dv as never) : "";
        try {
          if (f instanceof PDFTextField) f.setText(def);
          else if (f instanceof PDFCheckBox) f.uncheck();
          else if (f instanceof PDFRadioGroup) f.clear();
          else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
            if (def) f.select(def);
            else f.clear();
          }
        } catch {
          /* read-only or odd field */
        }
      }
      return { bytes: await pdfDoc.save(), pageIds };
    });
  });
  toast("Form cleared", "success");
}
