// Fill a form, Fill & Sign additions, Prepare Form, save, reset and import data.
export const title = "Forms, fill & sign, prepare form";

export default async function run({ page, check, st, open, shot, build }) {
  const values = () => st(async () => (await import("/src/ops/forms.ts")).getFormValues(window.__quillmark.useApp.getState().activeId));

  await open("form.pdf");
  await page.waitForSelector(".annotationLayer input", { timeout: 15000 });
  const inputs = page.locator(".annotationLayer input[type=text], .annotationLayer input:not([type])");
  await inputs.nth(0).fill("Ada Lovelace");
  await inputs.nth(1).fill("ada@example.com");
  await page.locator(".annotationLayer input[type=checkbox]").first().check();
  await page.waitForTimeout(500);
  const filled = await values();
  check(filled["applicant.name"] === "Ada Lovelace", "typed text field value is read back");
  check(filled.subscribe === true || filled.subscribe === "Yes" || filled.subscribe === "On", "checkbox value is read back");
  await shot("form-filled");

  // Fill & Sign: a text box and a signature image.
  await page.evaluate(() => window.__quillmark.runCommand("mode.fillsign"));
  await st(async () => {
    const s = window.__quillmark.useApp.getState();
    const d = s.docs[s.activeId];
    const { createFreeText, createImage } = await import("/src/annotations/factory.ts");
    const { addAnnotations } = await import("/src/state/annotActions.ts");
    const text = createFreeText("fs-text", d.pages[0].id, [180, 300, 380, 320], 0, "Signed in London");
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 90;
    const g = c.getContext("2d");
    g.font = "48px cursive";
    g.fillText("Ada L.", 10, 60);
    const sig = createImage(d.pages[0].id, { x: 300, y: 250 }, 0, c.toDataURL("image/png"), 300, 90, "signature", 160);
    addAnnotations(d.id, [text, sig], "Fill & sign");
  });

  // Prepare Form: add a text field.
  await page.evaluate(() => window.__quillmark.runCommand("mode.forms"));
  await st(async () => {
    const s = window.__quillmark.useApp.getState();
    const d = s.docs[s.activeId];
    const { createField } = await import("/src/annotations/factory.ts");
    const { addAnnotations } = await import("/src/state/annotActions.ts");
    const names = d.annotations.filter((a) => a.kind === "field").map((a) => a.name);
    const f = createField("text", d.pages[0].id, [180, 200, 400, 222], { x: 180, y: 200 }, 0, names);
    f.name = "reference.number";
    addAnnotations(d.id, [f], "Add field");
  });
  await page.waitForTimeout(400);
  await shot("prepare-form");

  // Save and read the file back with pdf-lib.
  const bytes = await build();
  const saved = await st(async (arr) => {
    const { PDFDocument } = await import("/src/lib/pdflib.ts");
    const doc = await PDFDocument.load(new Uint8Array(arr));
    const form = doc.getForm();
    return {
      fields: form.getFields().map((f) => f.getName()),
      name: form.getTextField("applicant.name").getText(),
      subscribe: form.getCheckBox("subscribe").isChecked(),
    };
  }, bytes);
  check(saved.name === "Ada Lovelace", "filled value is saved in the PDF");
  check(saved.subscribe === true, "checkbox state is saved");
  check(saved.fields.includes("reference.number"), "field added in Prepare Form is saved");

  // Reset, then import data.
  await st(async () => (await import("/src/ops/forms.ts")).resetForm(window.__quillmark.useApp.getState().activeId));
  await page.waitForTimeout(800);
  check(!(await values())["applicant.name"], "reset form clears the text field");
  await st(async () => (await import("/src/ops/forms.ts")).importFormData(window.__quillmark.useApp.getState().activeId, { "applicant.name": "Grace Hopper" }));
  await page.waitForTimeout(800);
  check((await values())["applicant.name"] === "Grace Hopper", "importing form data sets the field");
}
