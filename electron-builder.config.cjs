// Desktop installers, built by `npm run dist:win`, `dist:mac` or `dist:linux` (see README).
const { version: electronVersion } = require("electron/package.json");

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "app.quillmark.desktop",
  productName: "Quillmark",
  copyright: "Copyright © 2026 Quillmark",
  electronVersion,
  directories: { app: ".desktop-app", output: "release", buildResources: "desktop/build" },
  asar: true,
  fileAssociations: [{ ext: "pdf", name: "PDF Document", description: "PDF document", mimeType: "application/pdf", role: "Editor" }],
  win: { target: ["nsis"] },
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
    category: "public.app-category.productivity",
    artifactName: "Quillmark-${version}-${arch}.${ext}",
    extendInfo: { NSCameraUsageDescription: "Quillmark uses the camera to turn photos of documents into PDFs." },
  },
  linux: {
    target: ["AppImage"],
    category: "Office",
    synopsis: "PDF reader and editor",
    artifactName: "Quillmark-${version}-${arch}.${ext}",
  },
};
