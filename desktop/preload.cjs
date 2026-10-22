// The bridge between the page and the desktop: native dialogs and files on disk.
// The page only gets these functions, never Node.js or Electron itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("doxxtaDesktop", {
  platform: process.platform,
  /** Shows the Open dialog; resolves with the chosen PDFs ({ path, name, data }), or [] when cancelled. */
  openFiles: () => ipcRenderer.invoke("doxxta:open-dialog"),
  /** Shows the Save dialog; resolves with the chosen path, or null when cancelled. */
  saveDialog: (suggestedName) => ipcRenderer.invoke("doxxta:save-dialog", suggestedName),
  readFile: (path) => ipcRenderer.invoke("doxxta:read-file", path),
  writeFile: (path, data) => ipcRenderer.invoke("doxxta:write-file", path, data),
  /** Downloads a web address in the app itself (no CORS); resolves with { ok, data, url, disposition } or { ok: false, status | reason }. */
  downloadUrl: (address) => ipcRenderer.invoke("doxxta:download", address),
  /** Where a dropped file lives on disk, so Save can write back to it. */
  pathForFile: (file) => {
    try {
      const path = webUtils.getPathForFile(file);
      if (path) ipcRenderer.send("doxxta:grant", path);
      return path || null;
    } catch {
      return null;
    }
  },
  /** Fonts installed on the computer that may be embedded in documents: { id, family, weight, italic, noSubset }. */
  systemFonts: () => ipcRenderer.invoke("doxxta:system-fonts"),
  /** One of those fonts' file. */
  fontFile: (id) => ipcRenderer.invoke("doxxta:font-file", id),
  /** Files opened with Doxxta from the operating system (also those that arrived before the page loaded). */
  onOpenFiles: (callback) => {
    ipcRenderer.on("doxxta:open-files", (_event, files) => callback(files));
    ipcRenderer.invoke("doxxta:ready").then((files) => files.length && callback(files));
  },
});
