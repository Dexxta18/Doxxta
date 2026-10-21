/**
 * The desktop app (Electron) exposes native file dialogs and files opened from
 * the operating system through its preload script (desktop/preload.cjs). They
 * are presented to the rest of the app as the File System Access API, which
 * the web version already uses to open files and save them in place.
 */

interface DesktopFile {
  path: string;
  name: string;
  data: Uint8Array;
}

export type DesktopDownload =
  | { ok: true; data: Uint8Array; url: string; disposition: string | null }
  | { ok: false; status?: number; reason?: "invalid" | "too-large" | "network" };

interface DesktopBridge {
  platform: string;
  openFiles(): Promise<DesktopFile[]>;
  saveDialog(suggestedName: string): Promise<string | null>;
  readFile(path: string): Promise<DesktopFile | null>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  downloadUrl(address: string): Promise<DesktopDownload>;
  pathForFile(file: File): string | null;
  onOpenFiles(callback: (files: DesktopFile[]) => void): void;
}

/** The desktop bridge, or null in a browser. */
export const desktop: DesktopBridge | null = (window as unknown as { quillmarkDesktop?: DesktopBridge }).quillmarkDesktop ?? null;

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

/** Contents read when the file was opened, used once by getFile(); kept off the handle so recent files don't store it. */
const firstRead = new WeakMap<DesktopFileHandle, Uint8Array>();

/** A file on disk, with the parts of FileSystemFileHandle the app uses. */
class DesktopFileHandle {
  readonly kind = "file";
  readonly desktopPath: string;
  readonly name: string;

  constructor(path: string, name = baseName(path), data?: Uint8Array) {
    this.desktopPath = path;
    this.name = name;
    if (data) firstRead.set(this, data);
  }

  async getFile(): Promise<File> {
    let data = firstRead.get(this);
    firstRead.delete(this);
    data ??= (await desktop!.readFile(this.desktopPath))?.data;
    if (!data) throw new DOMException(`“${this.name}” can't be read. It may have been moved or deleted.`, "NotFoundError");
    return new File([data as BlobPart], this.name, { type: "application/pdf" });
  }

  async createWritable() {
    const parts: Uint8Array[] = [];
    return {
      write: async (chunk: Uint8Array | ArrayBuffer | Blob) => {
        parts.push(chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
      },
      close: async () => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.length;
        }
        await desktop!.writeFile(this.desktopPath, out);
      },
      abort: async () => {
        parts.length = 0;
      },
    };
  }

  async queryPermission() {
    return "granted" as const;
  }

  async requestPermission() {
    return "granted" as const;
  }

  async isSameEntry(other: unknown) {
    return other instanceof DesktopFileHandle && other.desktopPath === this.desktopPath;
  }
}

const asHandle = (h: DesktopFileHandle) => h as unknown as FileSystemFileHandle;

/** Installs the native Open and Save dialogs, and opens files sent from the OS. Does nothing in a browser. */
export function installDesktop() {
  if (!desktop) return;
  const w = window as unknown as Record<string, unknown>;
  w.showOpenFilePicker = async () => {
    const files = await desktop.openFiles();
    if (!files.length) throw new DOMException("No file was chosen.", "AbortError");
    return files.map((f) => asHandle(new DesktopFileHandle(f.path, f.name, f.data)));
  };
  w.showSaveFilePicker = async (opts?: { suggestedName?: string }) => {
    const path = await desktop.saveDialog(opts?.suggestedName ?? "document.pdf");
    if (!path) throw new DOMException("Saving was cancelled.", "AbortError");
    return asHandle(new DesktopFileHandle(path));
  };
  desktop.onOpenFiles(async (files) => {
    const { openBytes } = await import("../core/document");
    for (const f of files) await openBytes(f.data, f.name, { fileHandle: asHandle(new DesktopFileHandle(f.path, f.name)) });
  });
}

/** For a file dropped on the window: a handle to its place on disk, so Save writes back to it. */
export function desktopHandleFor(file: File): FileSystemFileHandle | null {
  const path = desktop?.pathForFile(file);
  return path ? asHandle(new DesktopFileHandle(path, file.name)) : null;
}

/** Recent files keep their handle in IndexedDB, where a desktop handle is stored as plain data; this restores it. */
export function reviveFileHandle(stored: unknown): FileSystemFileHandle | null {
  if (stored && typeof stored === "object" && "desktopPath" in stored) {
    const { desktopPath, name } = stored as { desktopPath: string; name: string };
    return desktop ? asHandle(new DesktopFileHandle(desktopPath, name)) : null;
  }
  return (stored as FileSystemFileHandle | null) ?? null;
}
