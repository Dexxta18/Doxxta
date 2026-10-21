import { useEffect, useState } from "react";
import { KeyRound, Lock, LockOpen, ShieldCheck } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, Select, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, toast, updateDoc } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import { PERMISSION_LABEL, isAllowed, unlock, type Permission } from "../../core/permissions";
import type { SecurityInfo } from "../../state/types";

type Pending = Extract<NonNullable<SecurityInfo["pending"]>, { kind: "encrypt" }>;

function strength(pw: string): { label: string; level: 0 | 1 | 2 | 3 } {
  if (!pw) return { label: "", level: 0 };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const score = (pw.length >= 8 ? 1 : 0) + (pw.length >= 12 ? 1 : 0) + (classes >= 3 ? 1 : 0);
  return score >= 3 ? { label: "Strong", level: 3 } : score === 2 ? { label: "Medium", level: 2 } : { label: "Weak", level: 1 };
}

function PasswordPair({ label, value, confirm, onChange, onConfirm, autoFocus }: { label: string; value: string; confirm: string; onChange: (v: string) => void; onConfirm: (v: string) => void; autoFocus?: boolean }) {
  const s = strength(value);
  return (
    <div className="grid-2">
      <Field label={label} hint={s.label && <span className={`pw-strength pw-strength-${s.level}`}>{s.label}</span>}>
        <TextInput type="password" autoComplete="new-password" value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
      </Field>
      <Field label="Confirm" error={confirm && confirm !== value ? "Passwords don't match" : null}>
        <TextInput type="password" autoComplete="new-password" value={confirm} onChange={(e) => onConfirm(e.target.value)} />
      </Field>
    </div>
  );
}

const CHANGES = [
  { value: "none", label: "None" },
  { value: "assembly", label: "Inserting, deleting and rotating pages" },
  { value: "forms", label: "Filling in form fields and signing" },
  { value: "comments", label: "Commenting, filling in form fields and signing" },
  { value: "any", label: "Any except extracting pages" },
];

export default function ProtectDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [requireOpen, setRequireOpen] = useState(true);
  const [openPw, setOpenPw] = useState("");
  const [openPw2, setOpenPw2] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [permPw, setPermPw] = useState("");
  const [permPw2, setPermPw2] = useState("");
  const [printing, setPrinting] = useState<"none" | "low" | "high">("high");
  const [changes, setChanges] = useState("comments");
  const [copying, setCopying] = useState(true);
  const [accessibility, setAccessibility] = useState(true);
  const [algorithm, setAlgorithm] = useState("AES-256");
  if (!doc) return null;

  const problems = [
    !requireOpen && !restrict && "Choose an open password, restrictions, or both",
    requireOpen && !openPw && "Enter a password to open the document",
    requireOpen && openPw !== openPw2 && "The open passwords don't match",
    restrict && !permPw && "Enter a permissions password",
    restrict && permPw !== permPw2 && "The permissions passwords don't match",
    requireOpen && restrict && openPw && openPw === permPw && "The open and permissions passwords must be different",
  ].filter(Boolean) as string[];

  const apply = () => {
    if (problems.length) return toast(problems[0], "warning");
    const all = { printing: "highResolution", modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true };
    const permissions: Pending["permissions"] = restrict
      ? {
          printing: printing === "none" ? false : printing === "low" ? "lowResolution" : "highResolution",
          modifying: changes === "any",
          annotating: changes === "comments" || changes === "any",
          fillingForms: changes === "forms" || changes === "comments" || changes === "any",
          documentAssembly: changes === "assembly" || changes === "any",
          copying,
          contentAccessibility: accessibility || copying,
        }
      : all;
    const pending: Pending = { kind: "encrypt", userPassword: requireOpen ? openPw : "", ownerPassword: restrict ? permPw : "", permissions, algorithm };
    updateDoc(doc.id, (d) => ({ security: { ...d.security, pending }, dirty: true }));
    close();
    toast("Protection will be applied when you save the document", "success", { action: { label: "Save now", run: async () => (await import("../../core/save")).saveDocument(doc.id) } });
  };

  return (
    <Dialog
      title="Protect with password"
      icon={<Lock size={18} />}
      onClose={close}
      width={600}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={problems.length > 0}>
            Apply protection
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        {doc.security.encrypted && (
          <div className="callout">This document is already protected. The new settings replace the current ones when you save.</div>
        )}
        <div className="dialog-section">
          <Checkbox checked={requireOpen} onChange={setRequireOpen} label="Require a password to open the document" />
          {requireOpen && <PasswordPair label="Document open password" value={openPw} confirm={openPw2} onChange={setOpenPw} onConfirm={setOpenPw2} autoFocus />}
        </div>
        <div className="dialog-section">
          <Checkbox checked={restrict} onChange={setRestrict} label="Restrict editing and printing" hint="Others need the permissions password to change these settings." />
          {restrict && (
            <>
              <PasswordPair label="Permissions password" value={permPw} confirm={permPw2} onChange={setPermPw} onConfirm={setPermPw2} />
              <div className="grid-2">
                <Field label="Printing allowed">
                  <Select
                    value={printing}
                    onChange={(e) => setPrinting(e.target.value as typeof printing)}
                    options={[
                      { value: "none", label: "None" },
                      { value: "low", label: "Low resolution (150 dpi)" },
                      { value: "high", label: "High resolution" },
                    ]}
                  />
                </Field>
                <Field label="Changes allowed">
                  <Select value={changes} onChange={(e) => setChanges(e.target.value)} options={CHANGES} />
                </Field>
              </div>
              <Checkbox checked={copying} onChange={setCopying} label="Enable copying of text, images and other content" />
              <Checkbox checked={accessibility || copying} onChange={setAccessibility} disabled={copying} label="Enable text access for screen readers" />
            </>
          )}
        </div>
        <Field label="Encryption" hint={algorithm === "AES-256" ? "Recommended. Opens in Acrobat X and later and all current viewers." : algorithm === "AES-128" ? "Compatible with Acrobat 7 and later." : "Weak — only for very old readers (Acrobat 5)."}>
          <Select
            value={algorithm}
            onChange={(e) => setAlgorithm(e.target.value)}
            options={[
              { value: "AES-256", label: "256-bit AES" },
              { value: "AES-128", label: "128-bit AES" },
              { value: "RC4-128", label: "128-bit RC4 (legacy)" },
            ]}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** Asks for the permissions password and verifies it against the file. */
function usePermissionsPassword(docId: string) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const verify = async (): Promise<boolean> => {
    const original = getRuntime(docId)?.originalBytes;
    if (!original || !pw) return false;
    setChecking(true);
    try {
      const { isOwnerPassword } = await import("../../lib/security");
      if (await isOwnerPassword(original, pw)) {
        unlock(docId, pw);
        return true;
      }
      setError("That isn't the permissions password");
      return false;
    } finally {
      setChecking(false);
    }
  };
  return { pw, setPw: (v: string) => (setPw(v), setError(null)), error, checking, verify };
}

export function RemoveSecurityDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const ownerCheck = usePermissionsPassword(doc?.id ?? "");
  const [owner, setOwner] = useState<boolean | null>(null);
  useEffect(() => {
    if (!doc) return;
    if (!doc.security.encrypted || isAllowed(doc.id, "owner")) return setOwner(true);
    // The open password may also be the permissions password.
    const original = getRuntime(doc.id)?.originalBytes;
    if (!doc.security.password || !original) return setOwner(false);
    import("../../lib/security").then(async ({ isOwnerPassword }) => {
      const ok = await isOwnerPassword(original, doc.security.password!);
      if (ok) unlock(doc.id, doc.security.password!);
      setOwner(ok);
    });
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!doc) return null;
  const sec = doc.security;
  const pendingEncrypt = sec.pending?.kind === "encrypt";

  const remove = async () => {
    if (!pendingEncrypt && owner === false && !(await ownerCheck.verify())) return;
    if (pendingEncrypt && !sec.encrypted) updateDoc(doc.id, (d) => ({ security: { ...d.security, pending: undefined } }));
    else updateDoc(doc.id, (d) => ({ security: { ...d.security, pending: { kind: "remove" } }, dirty: true }));
    close();
    toast(pendingEncrypt && !sec.encrypted ? "The protection you added was discarded" : "Security will be removed when you save", "success");
  };

  if (!sec.encrypted && !pendingEncrypt) {
    return (
      <Dialog title="Remove security" icon={<LockOpen size={18} />} onClose={close} width={440} footer={<Button variant="primary" onClick={close}>OK</Button>}>
        <p style={{ margin: 0 }}>This document has no password protection.</p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Remove security"
      icon={<LockOpen size={18} />}
      onClose={close}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={remove} loading={ownerCheck.checking} disabled={owner === null || (!pendingEncrypt && owner === false && !ownerCheck.pw)}>
            Remove security
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {pendingEncrypt && !sec.encrypted ? (
          <p style={{ margin: 0 }}>Discard the password protection you set up but haven't saved yet?</p>
        ) : owner === false ? (
          <>
            <p style={{ margin: 0 }}>This document has a permissions password. Enter it to remove the security.</p>
            <Field label="Permissions password" error={ownerCheck.error}>
              <TextInput type="password" autoFocus value={ownerCheck.pw} onChange={(e) => ownerCheck.setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && remove()} />
            </Field>
          </>
        ) : (
          <p style={{ margin: 0 }}>Remove the password and restrictions from this document? The change takes effect when you save.</p>
        )}
      </div>
    </Dialog>
  );
}

export function PermissionsPasswordDialog({ props, close }: DialogProps<{ docId: string; permission: Permission; then?: () => void }>) {
  const check = usePermissionsPassword(props.docId);
  const doc = getDoc(props.docId);
  if (!doc) return null;
  const submit = async () => {
    if (!(await check.verify())) return;
    close();
    toast("Restrictions lifted for this session", "success");
    props.then?.();
  };
  return (
    <Dialog
      title="Secured document"
      icon={<ShieldCheck size={18} />}
      onClose={close}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" icon={<KeyRound size={15} />} onClick={submit} loading={check.checking} disabled={!check.pw}>
            Unlock
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p style={{ margin: 0 }}>
          The author of <strong>{doc.name}</strong> doesn't allow {PERMISSION_LABEL[props.permission]}. Enter the permissions password to continue.
        </p>
        <Field label="Permissions password" error={check.error}>
          <TextInput type="password" autoFocus value={check.pw} onChange={(e) => check.setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
      </div>
    </Dialog>
  );
}
