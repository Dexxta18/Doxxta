// Password protection, permissions, and re-saving a file that is already encrypted.
export const title = "Passwords and permissions";

export default async function run({ page, check, st, open, build, readPdf }) {
  const addNote = (text) =>
    st(async (text) => {
      const s = window.__doxxta.useApp.getState();
      const d = s.docs[s.activeId];
      const { createNote } = await import("/src/annotations/factory.ts");
      const { addAnnotations } = await import("/src/state/annotActions.ts");
      const n = createNote(d.pages[0].id, { x: 100, y: 700 }, 0);
      n.contents = text;
      addAnnotations(d.id, [n], "Add note");
    }, text);

  // Protect with an open password and a permissions password that blocks printing.
  await open("sample.pdf");
  await addNote("Secret note é ✓");
  await page.evaluate(() => window.__doxxta.runCommand("tool.protect"));
  await page.waitForSelector(".dialog-title:has-text('Protect with password')");
  const pw = page.locator(".dialog input[type=password]");
  await pw.nth(0).fill("open-Pass1");
  await pw.nth(1).fill("open-Pass1");
  await page.click(".dialog label:has-text('Restrict editing and printing')");
  await pw.nth(2).fill("perm-Pass2");
  await pw.nth(3).fill("perm-Pass2");
  await page.selectOption(".dialog select >> nth=0", "none");
  await page.click(".dialog-footer .btn-primary");
  await page.waitForTimeout(300);
  const bytes = await build();
  check((await readPdf(bytes)).needsPassword, "protected file needs a password to open");
  check((await readPdf(bytes, "wrong")).needsPassword, "a wrong password is refused");
  const opened = await readPdf(bytes, "open-Pass1");
  check(opened.pages === 6 && opened.text[0].includes("Chapter 1"), "the open password decrypts the pages");
  check(opened.notes.includes("Secret note é ✓"), "comment text is encrypted and decrypts intact");
  check(opened.permissions && !opened.permissions.includes(4), "printing is not permitted");

  // Re-save a file that was already encrypted (user "secret", owner "owner", no editing).
  await open("encrypted.pdf", "secret");
  await addNote("Reviewed – ok");
  const again = await build();
  check((await readPdf(again)).needsPassword, "re-saved file is still encrypted");
  const user = await readPdf(again, "secret");
  check(user.notes.includes("Reviewed – ok") && user.text[0].includes("Top secret"), "same open password; content and new comment intact");
  check(!(await readPdf(again, "owner")).needsPassword, "original owner password still works");

  // Restricted actions ask for the permissions password first.
  await page.evaluate(() => window.__doxxta.runCommand("mode.edit"));
  await page.waitForTimeout(500);
  const gate = await st(() => { const s = window.__doxxta.useApp.getState(); return { dialogs: s.dialogs.map((d) => d.id), mode: s.docs[s.activeId].mode }; });
  check(gate.dialogs.includes("permissions-password") && gate.mode !== "edit", "editing a restricted file asks for the permissions password");
  await page.fill(".dialog input[type=password]", "owner");
  await page.click(".dialog-footer .btn-primary");
  check(await page.waitForFunction(() => { const s = window.__doxxta.useApp.getState(); return s.docs[s.activeId].mode === "edit"; }, null, { timeout: 5000 }).then(() => true, () => false), "the owner password unlocks editing");
}
