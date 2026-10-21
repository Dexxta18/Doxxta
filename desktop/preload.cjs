// The bridge between the page and the desktop: native dialogs and files on disk.
// The page only gets these functions, never Node.js or Electron itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("quillmarkDesktop", {
  platform: process.platform,
  /** Shows the Open dialog; resolves with the chosen PDFs ({ path, name, data }), or [] when cancelled. */
  openFiles: () => ipcRenderer.invoke("quillmark:open-dialog"),
  /** Shows the Save dialog; resolves with the chosen path, or null when cancelled. */
  saveDialog: (suggestedName) => ipcRenderer.invoke("quillmark:save-dialog", suggestedName),
  readFile: (path) => ipcRenderer.invoke("quillmark:read-file", path),
  writeFile: (path, data) => ipcRenderer.invoke("quillmark:write-file", path, data),
  /** Where a dropped file lives on disk, so Save can write back to it. */
  pathForFile: (file) => {
    try {
      const path = webUtils.getPathForFile(file);
      if (path) ipcRenderer.send("quillmark:grant", path);
      return path || null;
    } catch {
      return null;
    }
  },
  /** Files opened with Quillmark from the operating system (also those that arrived before the page loaded). */
  onOpenFiles: (callback) => {
    ipcRenderer.on("quillmark:open-files", (_event, files) => callback(files));
    ipcRenderer.invoke("quillmark:ready").then((files) => files.length && callback(files));
  },
});
