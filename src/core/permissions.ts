import { pdfjs } from "../lib/pdfjs";
import { getDoc, openDialog, updateDoc } from "../state/store";
import { getRuntime } from "../state/runtime";
import type { Mode } from "../state/types";

/**
 * Document restrictions (the "permissions" of a secured PDF). Like Acrobat,
 * restricted actions ask for the permissions password before they run.
 */
export type Permission = "annotate" | "modify" | "assemble" | "fillForms" | "fillOrAnnotate" | "print" | "copy" | "owner";

const F = (pdfjs as unknown as { PermissionFlag: Record<string, number> }).PermissionFlag;

export const PERMISSION_LABEL: Record<Permission, string> = {
  annotate: "commenting",
  modify: "changes to the document",
  assemble: "inserting, deleting and rotating pages",
  fillForms: "filling in form fields",
  fillOrAnnotate: "filling in forms and signing",
  print: "printing",
  copy: "copying and exporting content",
  owner: "changing its security settings",
};

/** Which permission each workspace needs. */
export const MODE_PERMISSION: Partial<Record<Mode, Permission>> = {
  comment: "annotate",
  measure: "annotate",
  fillsign: "fillOrAnnotate",
  edit: "modify",
  forms: "modify",
  redact: "modify",
  organize: "assemble",
};

export function isAllowed(docId: string, p: Permission): boolean {
  const s = getDoc(docId)?.security;
  if (!s || !s.encrypted || s.unlocked) return true;
  if (p === "owner") return false;
  const allowed = s.permissions;
  if (!allowed) return true;
  const has = (flag: string) => allowed.includes(F[flag]);
  switch (p) {
    case "annotate":
      return has("MODIFY_ANNOTATIONS");
    case "modify":
      return has("MODIFY_CONTENTS");
    case "assemble":
      return has("ASSEMBLE") || has("MODIFY_CONTENTS");
    case "fillForms":
      return has("FILL_INTERACTIVE_FORMS") || has("MODIFY_ANNOTATIONS");
    case "fillOrAnnotate":
      return has("FILL_INTERACTIVE_FORMS") || has("MODIFY_ANNOTATIONS");
    case "print":
      return has("PRINT");
    case "copy":
      return has("COPY");
  }
}

/** Lifts the restrictions for this session once the permissions password is known. */
export function unlock(docId: string, ownerPassword: string) {
  updateDoc(docId, (d) => ({ security: { ...d.security, ownerPassword, unlocked: true } }));
}

/**
 * Runs `then` right away when allowed. Otherwise checks whether the password
 * the file was opened with is its permissions password, and if not asks for it.
 */
export async function withPermission(docId: string, p: Permission, then: () => void) {
  if (isAllowed(docId, p)) return then();
  const s = getDoc(docId)?.security;
  const original = getRuntime(docId)?.originalBytes;
  if (s?.password && original) {
    const { isOwnerPassword } = await import("../lib/security");
    if (await isOwnerPassword(original, s.password)) {
      unlock(docId, s.password);
      return then();
    }
  }
  openDialog("permissions-password", { docId, permission: p, then });
}
