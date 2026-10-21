// Desktop app tasks (run `npm run build` first; the npm scripts do):
//   node scripts/desktop.mjs start            run the desktop app
//   node scripts/desktop.mjs stage            only prepare .desktop-app/ (used by the desktop tests)
//   node scripts/desktop.mjs dist --win|--mac|--linux   build installers into release/
// Both stage the web build and the Electron files into .desktop-app/, the folder that gets packaged.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, ".desktop-app");
const require = createRequire(import.meta.url);

function stageApp() {
  if (!existsSync(join(root, "dist", "index.html"))) {
    console.error("No web build found. Run `npm run build` first.");
    process.exit(1);
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  for (const f of ["main.cjs", "preload.cjs"]) cpSync(join(root, "desktop", f), join(stage, f));
  cpSync(join(root, "desktop", "build", "icon.png"), join(stage, "icon.png"));
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pkg = { name: "quillmark", productName: "Quillmark", desktopName: "quillmark.desktop", version, description: "PDF reader and editor", author: "Quillmark", main: "main.cjs" };
  writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2));
}

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

const [task, ...rest] = process.argv.slice(2);
if (task === "stage") {
  stageApp();
} else if (task === "start") {
  stageApp();
  process.exit(run(require("electron"), [stage, ...rest]));
} else if (task === "dist") {
  stageApp();
  // Run through Node, so it works the same on Windows (which can't spawn .cmd shims directly).
  const builder = require.resolve("electron-builder/cli.js");
  const env = { CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false" };
  process.exit(run(process.execPath, [builder, "--config", "electron-builder.config.cjs", "--publish", "never", ...rest], env));
} else {
  console.error("Usage: node scripts/desktop.mjs start | dist --win|--mac|--linux");
  process.exit(2);
}
