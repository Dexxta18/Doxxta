// Redaction removes the underlying content, not just covers it.
export const title = "Redaction";

export default async function run({ page, check, st, open, shot, idle, build, readPdf }) {
  await open("sample.pdf");
  await page.evaluate(() => window.__folio.runCommand("mode.redact"));
  await st(() => import("/src/state/store.ts").then((m) => m.openDialog("search-redact")));
  await page.waitForSelector(".dialog-title:has-text('Find text to redact')");
  await page.click('.dialog .segmented button:has-text("Patterns")');
  // Only card numbers (emails, phones and SSNs are picked by default).
  for (const label of ["Email addresses", "Phone numbers", "Social Security numbers", "Credit card numbers"]) await page.click(`.dialog label:has-text('${label}')`);
  await page.click(".dialog-footer .btn-primary");
  await page.waitForSelector(".redact-results, .dialog p:has-text('No matches')", { timeout: 30000 });
  check((await page.locator(".redact-result").count()) === 6, "finds the card number on each of the 6 pages");
  await page.click(".dialog-footer .btn-primary");
  await page.waitForTimeout(400);
  await st(() => import("/src/state/store.ts").then((m) => m.openDialog("apply-redactions")));
  await page.waitForSelector(".dialog-title:has-text('Apply redactions')");
  await page.click(".dialog-footer .btn-danger");
  await idle();
  await page.waitForTimeout(800);
  await shot("redacted");
  const saved = await readPdf(await build());
  const all = saved.text.join("\n");
  check(!/4111\s?1111\s?1111\s?1111/.test(all), "card numbers are removed from the text");
  check(all.includes("SSN 123-45-6789") && all.includes("jane.doe@example.com"), "text around them is kept");

  // Area redaction over a scanned image removes the pixels.
  await open("scanned.pdf");
  const summary = await st(async () => {
    const s = window.__folio.useApp.getState();
    const d = s.docs[s.activeId];
    const { createRedaction } = await import("/src/annotations/factory.ts");
    const { addAnnotations } = await import("/src/state/annotActions.ts");
    const [x0, , , y1] = d.pages[0].view;
    addAnnotations(d.id, [createRedaction(d.pages[0].id, [x0 + 60, y1 - 200, x0 + 360, y1 - 120], 0)], "Mark");
    const { applyRedactions } = await import("/src/ops/redact.ts");
    return applyRedactions(d.id, {});
  });
  check(summary?.images === 1, "the image under the mark is redacted");
}
