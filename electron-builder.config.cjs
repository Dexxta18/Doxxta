// Desktop installers, built by `npm run dist:win`, `dist:mac` or `dist:linux` (see README).
const { version: electronVersion } = require("electron/package.json");

/** PDFs open with Quillmark ("Open with", or as the default app if the user picks it). */
const pdf = { ext: "pdf", description: "PDF document", mimeType: "application/pdf", role: "Editor" };

// With an Apple Developer ID (CSC_LINK or CSC_NAME) the Mac app is signed with it; otherwise it is
// ad-hoc signed, which Apple Silicon Macs need to run it at all.
const appleId = !!(process.env.CSC_LINK || process.env.CSC_NAME);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "app.quillmark.desktop",
  productName: "Quillmark",
  copyright: "Copyright © 2026 Quillmark",
  electronVersion,
  directories: { app: ".desktop-app", output: "release", buildResources: "desktop/build" },
  asar: true,
  // Vite bundles everything into dist/: there are no node_modules to install, rebuild or package.
  beforeBuild: async () => false,
  // No update server: don't write auto-update files.
  publish: null,
  // On Windows the name is the registry's file type id, so it's unique to Quillmark.
  win: { target: ["nsis"], fileAssociations: [{ ...pdf, name: "Quillmark.PDF" }] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Quillmark",
    artifactName: "Quillmark-Setup-${version}.${ext}",
  },
  mac: {
    target: ["dmg"],
    ...(appleId ? {} : { identity: "-", hardenedRuntime: false }),
    category: "public.app-category.productivity",
    fileAssociations: [{ ...pdf, name: "PDF Document" }],
    artifactName: "Quillmark-${version}-${arch}.${ext}",
    extendInfo: { NSCameraUsageDescription: "Quillmark uses the camera to turn photos of documents into PDFs." },
  },
  linux: {
    target: ["AppImage"],
    category: "Office",
    fileAssociations: [{ ...pdf, name: "PDF Document" }],
    synopsis: "PDF reader and editor",
    syncDesktopName: true,
    artifactName: "Quillmark-${version}-${arch}.${ext}",
  },
};
