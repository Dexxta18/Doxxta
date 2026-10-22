// Doxxta desktop: the web app in a native window, with the operating system's
// file dialogs, "Open with" support, and saving straight back to files on disk.
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** Set to the Vite dev server (e.g. http://127.0.0.1:5173/) to develop with hot reload. */
const DEV_URL = process.env.DOXXTA_DEV_URL || null;
// The app's address inside the desktop app. It keeps the app's former name, Quillmark,
// because the settings, signatures and recent files the window stores belong to it.
const ORIGIN = "app://quillmark";
const DIST = [path.join(__dirname, "dist"), path.join(__dirname, "..", "dist")].find((d) => fs.existsSync(path.join(d, "index.html")));

// The app is served from app://quillmark/ so that modules, workers, WebAssembly
// and fetch() of its own files behave as they do on a web server.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// Scripts only from the app itself; network access for OCR language data and "Open from URL".
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' data: blob: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

let win = null;
let rendererReady = false;
/** Files opened from the operating system before the window could take them. */
const pendingPaths = [];

// ----- Files the window may read and write -----
// The window can only touch files the user chose: in an Open or Save dialog,
// by opening them with Doxxta from the OS, or by dropping them on the window.

const grantsFile = () => path.join(app.getPath("userData"), "granted-files.json");
let granted = new Set();
let lastDir = null;

function loadGrants() {
  try {
    const saved = JSON.parse(fs.readFileSync(grantsFile(), "utf8"));
    granted = new Set(saved.files ?? []);
    lastDir = saved.lastDir ?? null;
  } catch {
    granted = new Set();
  }
}

let grantsTimer = null;
function grant(file) {
  const p = path.resolve(file);
  granted.delete(p);
  granted.add(p);
  lastDir = path.dirname(p);
  clearTimeout(grantsTimer);
  grantsTimer = setTimeout(() => {
    const files = [...granted].slice(-500);
    fs.promises.writeFile(grantsFile(), JSON.stringify({ files, lastDir })).catch(() => {});
  }, 300);
  return p;
}

const isGranted = (file) => typeof file === "string" && granted.has(path.resolve(file));

async function readDesktopFile(file) {
  const data = await fs.promises.readFile(file);
  return { path: file, name: path.basename(file), data };
}

/** Writes through a temporary file, so a failed save can't leave a half-written document. */
async function writeFileSafely(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.doxxta-tmp`);
  try {
    const stat = await fs.promises.stat(file).catch(() => null);
    await fs.promises.writeFile(tmp, data, stat ? { mode: stat.mode } : undefined);
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    // The folder may not allow new files: write in place instead.
    if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EXDEV") await fs.promises.writeFile(file, data);
    else throw e;
  }
}

// ----- Opening files from the OS -----

function pdfPathsFrom(argv) {
  return argv
    .slice(process.defaultApp ? 2 : 1)
    .filter((a) => !a.startsWith("-") && /\.pdf$/i.test(a))
    .map((a) => path.resolve(a))
    .filter((p) => fs.existsSync(p));
}

async function openPaths(paths) {
  if (!paths.length) return;
  if (!win || !rendererReady) {
    pendingPaths.push(...paths);
    return;
  }
  const files = [];
  for (const p of paths) {
    try {
      files.push(await readDesktopFile(grant(p)));
    } catch (e) {
      dialog.showErrorBox("Couldn't open the file", `${p}\n\n${e.message}`);
    }
  }
  if (files.length) win.webContents.send("doxxta:open-files", files);
  if (win.isMinimized()) win.restore();
  win.focus();
}

// ----- Messages from the window -----

function fromApp(event) {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith(`${ORIGIN}/`) || (!!DEV_URL && url.startsWith(DEV_URL));
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error("Not allowed");
    return fn(...args);
  });
}

handle("doxxta:ready", async () => {
  rendererReady = true;
  const paths = pendingPaths.splice(0);
  const files = [];
  for (const p of paths) files.push(await readDesktopFile(grant(p)).catch(() => null));
  return files.filter(Boolean);
});

handle("doxxta:open-dialog", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Open",
    defaultPath: lastDir ?? app.getPath("documents"),
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "PDF documents", extensions: ["pdf"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled) return [];
  return Promise.all(res.filePaths.map((p) => readDesktopFile(grant(p))));
});

handle("doxxta:save-dialog", async (suggestedName) => {
  const name = typeof suggestedName === "string" && suggestedName ? path.basename(suggestedName) : "document.pdf";
  const res = await dialog.showSaveDialog(win, {
    title: "Save as",
    defaultPath: path.join(lastDir ?? app.getPath("documents"), name),
    filters: [{ name: "PDF document", extensions: ["pdf"] }],
  });
  if (res.canceled || !res.filePath) return null;
  return grant(res.filePath);
});

handle("doxxta:read-file", async (file) => {
  if (!isGranted(file)) return null;
  return readDesktopFile(path.resolve(file)).catch(() => null);
});

handle("doxxta:write-file", async (file, data) => {
  if (!isGranted(file)) throw new Error("Doxxta can only save to files you opened or chose.");
  if (!(data instanceof Uint8Array)) throw new Error("Nothing to write");
  await writeFileSafely(path.resolve(file), data);
});

// "Open from URL": the PDF is downloaded here, where websites' cross-origin (CORS) rules don't apply.
const MAX_DOWNLOAD = 1024 * 1024 * 1024;

handle("doxxta:download", async (address) => {
  let url;
  try {
    url = new URL(String(address));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid" };
  try {
    const res = await net.fetch(url.href, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) return { ok: false, status: res.status };
    if (Number(res.headers.get("content-length")) > MAX_DOWNLOAD) return { ok: false, reason: "too-large" };
    const data = new Uint8Array(await res.arrayBuffer());
    return { ok: true, data, url: res.url || url.href, disposition: res.headers.get("content-disposition") };
  } catch {
    return { ok: false, reason: "network" };
  }
});

ipcMain.on("doxxta:grant", (event, file) => {
  if (fromApp(event) && typeof file === "string" && fs.existsSync(file)) grant(file);
});

// ----- Window -----

const boundsFile = () => path.join(app.getPath("userData"), "window.json");

function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width && b.y < area.y + area.height && b.x + b.width > area.x && b.y + b.height > area.y;
    return visible ? b : null;
  } catch {
    return null;
  }
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const saved = savedBounds();
  win = new BrowserWindow({
    width: saved?.width ?? Math.min(1440, Math.round(area.width * 0.9)),
    height: saved?.height ?? Math.min(940, Math.round(area.height * 0.9)),
    x: saved?.x,
    y: saved?.y,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "Doxxta",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17191e" : "#eceef2",
    icon: process.platform === "linux" ? path.join(__dirname, "icon.png") : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (saved?.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    const b = win.isMaximized() ? { ...(savedBounds() ?? win.getNormalBounds()), maximized: true } : { ...win.getBounds(), maximized: false };
    fs.promises.writeFile(boundsFile(), JSON.stringify(b)).catch(() => {});
  };
  win.on("close", remember);

  // Links in documents open in the default browser; the app never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${ORIGIN}/`) || (DEV_URL && url.startsWith(DEV_URL))) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  // Closing with unsaved changes: the page asks (beforeunload); show the question natively.
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Close without saving", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: "Some documents have changes that aren't saved.",
      detail: "If you close Doxxta now, those changes will be lost.",
    });
    if (choice === 0) event.preventDefault();
  });

  win.on("closed", () => {
    win = null;
    rendererReady = false;
  });
  void win.loadURL(DEV_URL ?? `${ORIGIN}/index.html`);
}

function setMenu() {
  if (process.platform !== "darwin") {
    // The app has its own menu bar; a native one would also capture its shortcuts.
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs an app menu, and an Edit menu for copy and paste in text fields.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
}

function serveApp() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (!DIST) return new Response("Not found", { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(DIST, rel);
    if (url.host !== new URL(ORIGIN).host || !file.startsWith(DIST + path.sep)) return new Response("Not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
    if (!res || !res.ok) return new Response("Not found", { status: 404 });
    const headers = new Headers(res.headers);
    if (/\.html$/i.test(file)) headers.set("Content-Security-Policy", CSP);
    if (/\.wasm$/i.test(file)) headers.set("Content-Type", "application/wasm");
    if (/\.m?js$/i.test(file)) headers.set("Content-Type", "text/javascript");
    return new Response(res.body, { status: res.status, headers });
  });
}

function setPermissions() {
  // Camera (create a PDF from a photo), clipboard and full screen; nothing else.
  const allowed = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  // Exports and other downloads: start the Save dialog in the last folder used.
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(lastDir ?? app.getPath("downloads"), item.getFilename()) });
  });
}

// ----- App lifecycle -----

// Doxxta used to be called Quillmark, and the profile folder is named after the app: on
// first run, carry over Quillmark's settings, saved signatures, recent files and grants.
function adoptOldProfile() {
  const profile = app.getPath("userData");
  const old = path.join(app.getPath("appData"), "Quillmark");
  const marker = path.join(profile, ".from-quillmark");
  if (profile === old || !fs.existsSync(old) || fs.existsSync(marker) || fs.existsSync(path.join(profile, "Local Storage"))) return;
  const caches = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "Crashpad"]);
  try {
    fs.cpSync(old, profile, { recursive: true, filter: (src) => !caches.has(path.basename(src)) && !path.basename(src).startsWith("Singleton") });
  } catch {
    // Start with a fresh profile.
  }
  try {
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(marker, "");
  } catch {
    // Read-only profile folder: nothing to remember.
  }
}

adoptOldProfile();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS sends files through this event, possibly before the app is ready.
  app.on("open-file", (event, file) => {
    event.preventDefault();
    if (app.isReady()) {
      if (!win) createWindow();
      void openPaths([file]);
    } else pendingPaths.push(file);
  });
  app.on("second-instance", (_event, argv) => {
    if (!win) createWindow();
    void openPaths(pdfPathsFrom(argv));
  });

  app.whenReady().then(() => {
    if (!DIST && !DEV_URL) {
      dialog.showErrorBox("Doxxta", "The app files are missing. Run `npm run build` first.");
      app.quit();
      return;
    }
    if (process.platform === "win32") app.setAppUserModelId("app.doxxta.desktop");
    loadGrants();
    pendingPaths.push(...pdfPathsFrom(process.argv));
    serveApp();
    setPermissions();
    setMenu();
    createWindow();
    app.on("activate", () => {
      if (!win) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
