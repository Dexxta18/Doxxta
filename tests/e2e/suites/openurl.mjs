// Open from URL: downloads, file names, and the messages shown when it can't work.
export const title = "Open from URL";

export default async function run({ page, check, files }) {
  await page.click(".menubar-item:has-text('File')");
  await page.click(".menu-item:has-text('Open from URL')");
  await page.waitForSelector(".dialog-title:has-text('Open from URL')");
  /** Tries an address; resolves with the error shown, or null when the dialog closed. */
  const tryAddress = async (address) => {
    await page.fill(".dialog input", address);
    // Typing clears the previous error.
    await page.waitForFunction(() => !document.querySelector(".dialog .field-error"), null, { timeout: 5000 });
    await page.click(".dialog-footer .btn-primary");
    await page.waitForFunction(() => !document.querySelector(".dialog") || document.querySelector(".dialog .field-error"), null, { timeout: 20000 });
    return page.locator(".dialog .field-error").textContent({ timeout: 500 }).catch(() => null);
  };
  const activeName = () => page.locator(".doc-tab.is-active .doc-tab-name").textContent();

  check(/doesn't let other websites download/.test(await tryAddress(`${files}/nocors/sample.pdf`)), "a site that blocks downloads by other sites gets a clear explanation");
  check(/no file at that address/.test(await tryAddress(`${files}/cors/missing.pdf`)), "a wrong address says there's no file there");
  check(/web page, not a PDF/.test(await tryAddress(`${files}/cors/page.html`)), "a web page address says it isn't a PDF");
  check(/Enter a web address/.test(await tryAddress("not an address at all")), "text that isn't an address asks for one");
  check((await tryAddress(`${files}/cors/sample.pdf`)) === null, "a downloadable PDF opens");
  await page.waitForSelector('.pdfViewer .page[data-loaded="true"]', { timeout: 20000 });
  check((await activeName()) === "sample.pdf", "it is named after the address");

  await page.click(".menubar-item:has-text('File')");
  await page.click(".menu-item:has-text('Open from URL')");
  await page.waitForSelector(".dialog-title:has-text('Open from URL')");
  check((await tryAddress(`${files}/cors/download`)) === null, "a download link opens");
  await page.waitForFunction(() => document.querySelector(".doc-tab.is-active .doc-tab-name")?.textContent === "Quarterly report.pdf", null, { timeout: 20000 }).catch(() => {});
  check((await activeName()) === "Quarterly report.pdf", "it gets the file name the website gives it");
}
