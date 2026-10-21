import { lazy, Suspense, useEffect, useState } from "react";
import { FileUp } from "lucide-react";
import { useApp, toast } from "./state/store";
import { useSettings } from "./state/settings";
import { TopBar } from "./components/shell/TopBar";
import { HomeScreen } from "./components/shell/HomeScreen";
import { Workspace } from "./components/shell/Workspace";
import { DialogHost } from "./components/dialogs/DialogHost";
import { BusyOverlay, ContextMenuHost, Toasts, TooltipHost } from "./components/ui/Overlays";
import { useGlobalShortcuts } from "./core/shortcuts";
import { openBytes, openFile } from "./core/document";
import { errorMessage, isImageFile, isPdfFile } from "./lib/util";
import { downloadPdf } from "./lib/download";
import { loadRecent } from "./lib/recent";

const CompareView = lazy(() => import("./components/modes/CompareView"));
const SpeechBar = lazy(() => import("./components/shell/SpeechBar"));
const Presentation = lazy(() => import("./components/modes/Presentation"));

function useTheme() {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);
}

/** Opens dropped PDFs as tabs; dropped images become a new PDF. */
function useFileDrop() {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      // Drops onto the organize grid are handled there.
      if ((e.target as HTMLElement)?.closest?.("[data-drop-zone]")) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      const pdfs = files.filter(isPdfFile);
      const images = files.filter(isImageFile);
      for (const f of pdfs) await openFile(f);
      if (images.length) {
        const { imagesToPdf } = await import("./ops/create");
        const bytes = await imagesToPdf(images, { pageSize: "fit", margin: 0 });
        await openBytes(bytes, images.length === 1 ? images[0].name.replace(/\.[^.]+$/, ".pdf") : "Images.pdf", { transient: true, dirty: true });
      }
      if (!pdfs.length && !images.length) toast("Drop PDF or image files to open them.", "warning");
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  return dragging;
}

function useLaunchFiles() {
  useEffect(() => {
    loadRecent();
    // Installed PWA: files opened with Quillmark from the OS.
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      for (const h of params.files ?? []) await openFile(await h.getFile(), { fileHandle: h });
    });
    // ?url=https://… opens a remote PDF.
    const url = new URLSearchParams(location.search).get("url");
    if (url) {
      downloadPdf(url)
        .then((file) => openBytes(file.bytes, file.name))
        .catch((e) => toast(errorMessage(e), "error"));
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.values(useApp.getState().docs).some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}

/** The window or tab title names the open document, like other editors. */
function useDocumentTitle() {
  const title = useApp((s) => {
    const d = s.activeId ? s.docs[s.activeId] : undefined;
    return d ? `${d.dirty ? "• " : ""}${d.name} — Quillmark` : "Quillmark";
  });
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export default function App() {
  const activeId = useApp((s) => s.activeId);
  const presentation = useApp((s) => s.presentation);
  const compare = useApp((s) => s.compare);
  const speaking = useApp((s) => s.speaking);
  useTheme();
  useGlobalShortcuts();
  useLaunchFiles();
  useDocumentTitle();
  const dragging = useFileDrop();

  return (
    <div className={`app${presentation ? " is-presenting" : ""}`}>
      <TopBar />
      <main className="main">
        {activeId ? <Workspace key={activeId} docId={activeId} /> : <HomeScreen />}
        {compare && (
          <Suspense fallback={null}>
            <CompareView />
          </Suspense>
        )}
      </main>
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">
            <FileUp size={34} />
            <strong>Drop to open</strong>
            <span className="muted">PDFs open in new tabs · images become a new PDF</span>
          </div>
        </div>
      )}
      {speaking && (
        <Suspense fallback={null}>
          <SpeechBar />
        </Suspense>
      )}
      {presentation && (
        <Suspense fallback={null}>
          <Presentation />
        </Suspense>
      )}
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
      <BusyOverlay />
      <TooltipHost />
    </div>
  );
}
