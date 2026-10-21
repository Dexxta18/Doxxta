// A local website for the "Open from URL" tests: a PDF with and without permission for other
// sites to download it (CORS), a PDF with a server-chosen file name, a web page, and a missing file.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { FIXTURES } from "./harness.mjs";

export async function startFileServer() {
  const pdf = readFileSync(join(FIXTURES, "sample.pdf"));
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.startsWith("/cors/")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    }
    const file = path.replace(/^\/(cors|nocors)\//, "");
    if (file === "sample.pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf" }).end(pdf);
    } else if (file === "download") {
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Quarterly report.pdf"' }).end(pdf);
    } else if (file === "page.html") {
      res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>A web page</title><p>Not a PDF</p>");
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
