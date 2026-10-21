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
import App from "./App";
import { useApp } from "./state/store";
import { useSettings } from "./state/settings";
import { runtimes } from "./state/runtime";
import { runCommand } from "./core/commands";

if (import.meta.env.DEV) {
  // Debug handle for automated browser tests.
  (window as unknown as { __folio: unknown }).__folio = { useApp, useSettings, runtimes, runCommand };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
