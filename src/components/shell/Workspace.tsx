import { lazy, Suspense, useEffect } from "react";
import { AlertTriangle, FileWarning, Info, X } from "lucide-react";
import { useApp, setMode, setTool, updateDoc } from "../../state/store";
import { useSettings } from "../../state/settings";
import { PdfViewport } from "../../viewer/PdfViewport";
import { ToolsPanel } from "./ToolsPanel";
import { ContextToolbar } from "./ContextToolbar";
import { StatusBar } from "./StatusBar";
import { RightPanel } from "./RightPanel";
import { FindBar } from "./FindBar";
import { SelectionMenu } from "./SelectionMenu";
import { Button, Spinner } from "../ui/Button";
import { closeDocument } from "../../core/document";
import { consumePendingCommand } from "./HomeScreen";

const OrganizeView = lazy(() => import("../modes/OrganizeView"));

const MODE_HINTS: Partial<Record<string, string>> = {
  "edit-text": "Click a paragraph to edit its text. Format it with the toolbar, or Ctrl+B, Ctrl+I and Ctrl+U as in Word.",
  crop: "Drag a rectangle around the area to keep.",
  link: "Drag a rectangle over the area that should become a link. Double-click a link to change it.",
  "redact-area": "Drag to mark areas for redaction, then click Apply redactions.",
  "redact-text": "Select text to mark it for redaction, then click Apply redactions.",
  "measure-perimeter": "Click to add points, double-click (or Enter) to finish.",
  "measure-area": "Click to add points, double-click (or Enter) to finish.",
  polygon: "Click to add points, double-click or click the first point to finish.",
  polyline: "Click to add points, double-click (or Enter) to finish.",
  cloud: "Click to add points, double-click or click the first point to finish.",
  "marquee-zoom": "Drag to zoom into an area, or click to zoom in.",
  snapshot: "Drag over the area to copy it as an image.",
  eraser: "Drag over drawings to erase them.",
  signature: "Click on the page to place your signature.",
  initials: "Click on the page to place your initials.",
  "image-stamp": "Click on the page to place the stamp.",
};

function ToolHint() {
  const tool = useApp((s) => s.tool);
  const hint = MODE_HINTS[tool];
  if (!hint) return null;
  return (
    <div className="tool-hint" role="status">
      <Info size={14} /> {hint}
    </div>
  );
}

function DocBanner({ docId }: { docId: string }) {
  const locked = useApp((s) => s.docs[docId].lockedAnnotationCount);
  const encrypted = useApp((s) => s.docs[docId].security.encrypted);
  const permissions = useApp((s) => s.docs[docId].security.permissions);
  const dismissed = useApp((s) => s.docs[docId].bannerDismissed);
  if (dismissed) return null;
  let text: string | null = null;
  if (locked === -1) text = "Existing comments in this file couldn't be loaded for editing. They are shown but can't be changed.";
  else if (encrypted && permissions) text = "This document is secured. The author restricted some actions — your saved copy keeps the same protection.";
  if (!text) return null;
  return (
    <div className="doc-banner">
      <AlertTriangle size={15} />
      <span>{text}</span>
      <button className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => updateDoc(docId, { bannerDismissed: true })}>
        <X size={14} />
      </button>
    </div>
  );
}

export function Workspace({ docId }: { docId: string }) {
  const status = useApp((s) => s.docs[docId].status);
  const error = useApp((s) => s.docs[docId].error);
  const loadingMessage = useApp((s) => s.docs[docId].loadingMessage);
  const mode = useApp((s) => s.docs[docId].mode);
  const readMode = useApp((s) => s.readMode);
  const toolsOpen = useSettings((s) => s.toolsPanelOpen);
  void toolsOpen;

  useEffect(() => {
    if (status === "ready") consumePendingCommand();
  }, [status]);

  // The tool belongs to the tab being worked on: start fresh when switching tabs.
  useEffect(() => {
    setTool("select");
  }, [docId]);

  // Existing links become editable when the user starts working with links.
  const tool = useApp((s) => s.tool);
  useEffect(() => {
    if (status === "ready" && (tool === "link" || mode === "edit")) void import("../../ops/links").then((m) => m.liftLinks(docId));
  }, [status, tool, mode, docId]);

  return (
    <div className={`workspace${readMode ? " is-read-mode" : ""}`}>
      {!readMode && <ToolsPanel />}
      <div className="center">
        {!readMode && status === "ready" && mode !== "organize" && <ContextToolbar docId={docId} />}
        <div className="viewer-area">
          {status === "loading" && (
            <div className="center-fill col" style={{ gap: 12 }}>
              <Spinner size="lg" />
              <span className="muted">{loadingMessage ?? "Opening…"}</span>
            </div>
          )}
          {status === "error" && (
            <div className="center-fill">
              <div className="error-card">
                <FileWarning size={34} />
                <h3>Couldn’t open this document</h3>
                <p className="muted">{error}</p>
                <Button onClick={() => closeDocument(docId, true)}>Close tab</Button>
              </div>
            </div>
          )}
          {status === "ready" && (
            <>
              {mode === "organize" ? (
                <Suspense
                  fallback={
                    <div className="center-fill">
                      <Spinner size="lg" />
                    </div>
                  }
                >
                  <OrganizeView docId={docId} onClose={() => setMode(docId, "view")} />
                </Suspense>
              ) : (
                <PdfViewport docId={docId} />
              )}
              <DocBanner docId={docId} />
              <FindBar docId={docId} />
              <ToolHint />
              <SelectionMenu />
            </>
          )}
        </div>
        {!readMode && status === "ready" && mode !== "organize" && <StatusBar docId={docId} />}
      </div>
      {!readMode && status === "ready" && <RightPanel docId={docId} />}
      {readMode && (
        <button className="read-mode-exit btn btn-secondary btn-sm" onClick={() => useApp.setState({ readMode: false })}>
          Exit read mode
        </button>
      )}
    </div>
  );
}
