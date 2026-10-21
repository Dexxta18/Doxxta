import { desktop } from "./desktop";
import { isPdfBytes } from "./util";

/** A PDF downloaded from a web address. */
export interface DownloadedPdf {
  name: string;
  bytes: Uint8Array;
}

/**
 * Downloads a PDF from a web address. The desktop app downloads it itself; a
 * browser can only fetch it if the website allows other sites to (CORS).
 * Errors carry messages meant for the user.
 */
export async function downloadPdf(address: string): Promise<DownloadedPdf> {
  const url = parseAddress(address);
  let bytes: Uint8Array;
  let finalUrl = url.href;
  let disposition: string | null = null;
  if (desktop) {
    const res = await desktop.downloadUrl(url.href);
    if (!res.ok) {
      if (res.status) throw new Error(httpProblem(res.status));
      if (res.reason === "too-large") throw new Error("That file is too large to open (over 1 GB).");
      throw new Error(`Couldn't reach ${url.host}. Check the address and your internet connection.`);
    }
    ({ data: bytes, url: finalUrl, disposition } = res);
  } else {
    let res: Response;
    try {
      res = await fetch(url.href);
    } catch {
      throw new Error(
        `${url.host} doesn't let other websites download its files (or can't be reached). Download the PDF in your browser and open it here, or use the Quillmark desktop app, which can open it directly.`,
      );
    }
    if (!res.ok) throw new Error(httpProblem(res.status));
    bytes = new Uint8Array(await res.arrayBuffer());
    finalUrl = res.url || url.href;
    disposition = res.headers.get("content-disposition");
  }
  if (!isPdfBytes(bytes)) {
    throw new Error("That address is a web page, not a PDF file. Open it in your browser and use the address of the PDF itself (for example, from its Download link).");
  }
  return { name: pdfFileName(new URL(finalUrl), disposition), bytes };
}

/** Accepts "example.com/file.pdf" as well as full https:// addresses. */
function parseAddress(address: string): URL {
  let text = address.trim();
  if (text && !/^[a-z][a-z\d+.-]*:/i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Enter a web address, for example https://example.com/file.pdf");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Enter a web address that starts with https://");
  // Browsers accept odd host names (spaces become %20): require a real site name or IP address.
  const host = url.hostname;
  if (!(host === "localhost" || host.startsWith("[") || (/^[a-z\d.-]+$/i.test(host) && host.includes(".")))) {
    throw new Error("Enter a web address, for example https://example.com/file.pdf");
  }
  return url;
}

function httpProblem(status: number): string {
  if (status === 404 || status === 410) return "There's no file at that address (error 404). Check that the address is complete.";
  if (status === 401 || status === 403) {
    return `That website requires you to sign in, or doesn't allow this download (error ${status}). Download the PDF in your browser and open it here.`;
  }
  if (status >= 500) return `The website had a problem (error ${status}). Try again later.`;
  return `The download didn't work (error ${status}).`;
}

/** The server's file name (Content-Disposition), else the end of the address; always ending in .pdf. */
export function pdfFileName(url: URL, disposition: string | null): string {
  let name = "";
  const encoded = disposition?.match(/filename\*\s*=\s*[\w-]*'[^']*'([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
  if (encoded) name = safeDecode(encoded.trim());
  if (!name && plain) name = (plain[1] ?? plain[2] ?? "").trim();
  if (!name) name = safeDecode(url.pathname.split("/").pop() ?? "");
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "document";
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
