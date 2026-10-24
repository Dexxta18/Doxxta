// First: adds what pdf.js needs that some browsers lack.
import "./lib/compat";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/viewer.css";
import "./styles/panels.css";
import "./styles/dialogs.css";
import "./styles/modes.css";
import "./styles/phone.css";
import App from "./App";
import { useApp } from "./state/store";
import { useSettings } from "./state/settings";
import { runtimes } from "./state/runtime";
import { runCommand } from "./core/commands";
import { installDesktop } from "./lib/desktop";
import { installMobile } from "./lib/mobile";

if (import.meta.env.DEV || "__doxxtaSelftest" in window) {
  // Debug handle for automated tests: the browser tests, and the iPhone app's test copy.
  (window as unknown as { __doxxta: unknown }).__doxxta = { useApp, useSettings, runtimes, runCommand, textLayout: () => import("./lib/textLayout") };
}

installDesktop();
installMobile();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
