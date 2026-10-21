import { useState } from "react";
import { KeyRound, Link2, Keyboard, Info, AlertTriangle, ExternalLink } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { shortcutList } from "../../core/shortcuts";
import { shortcutLabel } from "../../lib/util";
import { getDoc, toast, withBusy } from "../../state/store";
import { getViewer } from "../../state/runtime";
import { openBytes } from "../../core/document";
import { Logo } from "../shell/TopBar";

export function PasswordDialog({ props, close }: DialogProps<{ fileName: string; reason: "need" | "incorrect"; resolve: (pw: string | null) => void }>) {
  const [pw, setPw] = useState("");
  const done = (v: string | null) => {
    props.resolve(v);
    close();
  };
  return (
    <Dialog
      title="Password required"
      icon={<KeyRound size={18} />}
      subtitle={`“${props.fileName}” is protected. Enter the password to open it.`}
      onClose={() => done(null)}
      dismissable={false}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => done(pw)}>
            Open
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          done(pw);
        }}
      >
        <Field label="Password" error={props.reason === "incorrect" ? "Incorrect password, try again." : null}>
          <TextInput type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" />
        </Field>
      </form>
    </Dialog>
  );
}

export function ConfirmCloseDialog({ props, close }: DialogProps<{ name: string; resolve: (c: "save" | "discard" | "cancel") => void }>) {
  const done = (v: "save" | "discard" | "cancel") => {
    props.resolve(v);
    close();
  };
  return (
    <Dialog
      title="Save changes?"
      icon={<AlertTriangle size={18} />}
      subtitle={`“${props.name}” has unsaved changes.`}
      onClose={() => done("cancel")}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => done("discard")}>
            Don’t save
          </Button>
          <Button onClick={() => done("cancel")}>Cancel</Button>
          <Button variant="primary" onClick={() => done("save")} data-autofocus>
            Save
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        If you close without saving, your comments and edits will be lost.
      </p>
    </Dialog>
  );
}

export function ConfirmDialog({ props, close }: DialogProps<{ title: string; message: string; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }>) {
  const done = (v: boolean) => {
    props.resolve(v);
    close();
  };
  return (
    <Dialog
      title={props.title}
      icon={<AlertTriangle size={18} />}
      onClose={() => done(false)}
      width={440}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant={props.danger ? "danger" : "primary"} onClick={() => done(true)} data-autofocus>
            {props.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
        {props.message}
      </p>
    </Dialog>
  );
}

export function OpenUrlDialog({ close }: DialogProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      setError("Enter a full URL, e.g. https://example.com/file.pdf");
      return;
    }
    close();
    await withBusy("Downloading…", async () => {
      const res = await fetch(u.href);
      if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = decodeURIComponent(u.pathname.split("/").pop() || "document.pdf");
      await openBytes(bytes, /\.pdf$/i.test(name) ? name : `${name}.pdf`, { transient: false });
    }).catch(() => {});
  };
  return (
    <Dialog
      title="Open from URL"
      icon={<Link2 size={18} />}
      onClose={close}
      width={500}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go} disabled={!url.trim()}>
            Open
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <Field label="PDF address" error={error} hint="The server must allow cross-origin downloads (CORS).">
          <TextInput autoFocus placeholder="https://…/document.pdf" value={url} onChange={(e) => (setUrl(e.target.value), setError(null))} />
        </Field>
      </form>
    </Dialog>
  );
}

export function GoToPageDialog({ props, close }: DialogProps<{ docId: string }>) {
  const doc = getDoc(props.docId);
  const [value, setValue] = useState(String(doc?.view.page ?? 1));
  const count = doc?.pages.length ?? 1;
  const go = () => {
    const byLabel = doc?.pages.findIndex((p) => p.label === value.trim()) ?? -1;
    const n = byLabel >= 0 ? byLabel + 1 : parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1 || n > count) {
      toast(`Enter a page between 1 and ${count}`, "warning");
      return;
    }
    getViewer(props.docId)?.goToPage(n);
    close();
  };
  return (
    <Dialog
      title="Go to page"
      onClose={close}
      width={340}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go}>
            Go
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <Field label={`Page (1–${count})`}>
          <TextInput autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        </Field>
      </form>
    </Dialog>
  );
}

export function ShortcutsDialog({ close }: DialogProps) {
  const list = shortcutList();
  const extra = [
    { label: "Nudge selected annotation", shortcut: "Arrow keys (Shift = 10 pt)" },
    { label: "Delete selected annotation", shortcut: "Delete" },
    { label: "Cancel / deselect / back to Select tool", shortcut: "Escape" },
    { label: "Zoom with mouse wheel", shortcut: "Mod+Wheel" },
    { label: "Pan", shortcut: "Middle mouse drag" },
    { label: "Finish polygon / polyline", shortcut: "Enter or double-click" },
    { label: "Save text box edits", shortcut: "Mod+Enter" },
  ];
  return (
    <Dialog title="Keyboard shortcuts" icon={<Keyboard size={18} />} onClose={close} width={620}>
      <div className="shortcut-grid">
        {[...list, ...extra].map((s) => (
          <div key={s.label + s.shortcut} className="shortcut-row">
            <span>{s.label}</span>
            <kbd>{shortcutLabel(s.shortcut)}</kbd>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function AboutDialog({ close }: DialogProps) {
  return (
    <Dialog title="About Quillmark" icon={<Info size={18} />} onClose={close} width={460} footer={<Button onClick={close}>Close</Button>}>
      <div className="row" style={{ gap: 12 }}>
        <Logo />
        <div className="col" style={{ gap: 2 }}>
          <strong>Quillmark</strong>
          <span className="muted">Version 0.1.0</span>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        A full-featured PDF reader and editor that runs entirely in your browser. Documents are processed locally and never uploaded.
      </p>
      <div className="callout">
        <ExternalLink size={15} />
        <span>
          Built on PDF.js (Apache-2.0), pdf-lib (MIT), Tesseract.js (Apache-2.0), docx (MIT), PptxGenJS (MIT), React (MIT) and Lucide icons (ISC).
        </span>
      </div>
    </Dialog>
  );
}
