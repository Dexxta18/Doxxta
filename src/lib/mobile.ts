import { Capacitor } from "@capacitor/core";

/**
 * The phone apps (Android and iOS, built with Capacitor: see capacitor.config.ts). Files are
 * saved through the phone's share sheet (Save to Files, Drive, mail…), PDFs opened with Doxxta
 * from other apps arrive here, and the Back button closes what's open. Nothing of this runs in a
 * browser or the desktop app.
 */

/** The phone platform, or null in a browser or the desktop app. */
export const mobile = Capacitor.isNativePlatform() ? (Capacitor.getPlatform() as "android" | "ios") : null;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Hands a file to the phone's share sheet, where it can be saved (Files, Drive…), sent or
 * printed. Resolves false when the sheet was dismissed.
 */
export async function shareFile(bytes: Uint8Array, filename: string, title = `Save or send “${filename}”`): Promise<boolean> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
  const safe = filename.replace(/[\\/:*?"<>|]+/g, "_") || "document.pdf";
  const { uri } = await Filesystem.writeFile({ path: `shared/${safe}`, data: toBase64(bytes), directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: safe, files: [uri], dialogTitle: title });
    return true;
  } catch (e) {
    if (/cancel/i.test(String((e as Error)?.message ?? e))) return false;
    throw e;
  }
}

/** Downloads a web address with the phone's own networking, which, unlike a web page, any site allows. */
export async function fetchNative(url: string): Promise<{ status: number; bytes: Uint8Array; url: string; headers: Record<string, string> }> {
  const { CapacitorHttp } = await import("@capacitor/core");
  const res = await CapacitorHttp.get({ url, responseType: "arraybuffer" });
  const data = res.data as unknown;
  const bytes = typeof data === "string" ? fromBase64(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
  return { status: res.status, bytes, url: res.url || url, headers };
}

/** The file name in a file:// or content:// address, if it has one. */
function nameOf(url: string): string {
  const last = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() ?? "");
  return /\.pdf$/i.test(last) ? last : "Document.pdf";
}

/** Opens a PDF another app handed to Doxxta ("Open with", "Open in"). */
async function openSent(url: string) {
  if (!/^(content|file):/i.test(url)) return;
  const [{ Filesystem }, { openBytes }, { toast }] = await Promise.all([import("@capacitor/filesystem"), import("../core/document"), import("../state/store")]);
  try {
    const { data } = await Filesystem.readFile({ path: url });
    const bytes = typeof data === "string" ? fromBase64(data) : new Uint8Array(await data.arrayBuffer());
    await openBytes(bytes, nameOf(url));
  } catch (e) {
    toast(`Couldn't open that file: ${(e as Error)?.message ?? e}`, "error");
  }
}

/** Android's Back button: closes the top dialog, sheet or tool, then the document; on the home screen, leaves the app. */
async function back() {
  const [{ useApp, closeDialog, setMode }, { usePhoneSheet, showSheet }] = await Promise.all([import("../state/store"), import("../state/phone")]);
  const app = useApp.getState();
  const doc = app.activeId ? app.docs[app.activeId] : undefined;
  if (app.dialogs.length) closeDialog();
  else if (usePhoneSheet.getState().sheet) showSheet(null);
  else if (doc && doc.mode !== "view") setMode(doc.id, "view");
  else if (doc) useApp.setState({ activeId: null });
  else (await import("@capacitor/app")).App.minimizeApp();
}

/** Listens for files sent from other apps and the Back button. Does nothing outside the phone apps. */
export function installMobile() {
  if (!mobile) return;
  document.documentElement.classList.add(`is-${mobile}`);
  void import("@capacitor/app").then(({ App }) => {
    void App.addListener("appUrlOpen", ({ url }) => void openSent(url));
    void App.getLaunchUrl().then((launch) => {
      if (launch?.url) void openSent(launch.url);
    });
    void App.addListener("backButton", () => void back());
  });
}
