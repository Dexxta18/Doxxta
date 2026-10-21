import { useState } from "react";
import { createPortal } from "react-dom";
import { Crosshair, Link2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, ColorButton, Field, NumberInput, Segmented, Select, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, openDialog, toast, useApp } from "../../state/store";
import { addAnnotations, updateAnnotation } from "../../state/annotActions";
import { createLink } from "../../annotations/factory";
import type { LinkAnnot, LinkHighlight, LinkTarget } from "../../annotations/types";
import type { PdfRect, Quad } from "../../lib/geometry";
import { normalizeUrl } from "../../ops/links";
import { currentDestination } from "../../core/outline";

type LinkProps = {
  docId?: string;
  /** Editing an existing link. */
  editId?: string;
  /** Creating a link over this area. */
  pageId?: string;
  rect?: PdfRect;
  rotation?: number;
  quads?: Quad[];
};

type Appearance = Pick<LinkAnnot, "showBorder" | "borderStyle" | "borderWidth" | "color" | "highlight">;

const DEFAULT_APPEARANCE: Appearance = { showBorder: false, borderStyle: "solid", borderWidth: 1, color: "#2f5bea", highlight: "invert" };

/** Creates or updates the link described by `props`. */
function commitLink(props: LinkProps, docId: string, target: LinkTarget, appearance: Appearance) {
  if (props.editId) {
    updateAnnotation(docId, props.editId, { target, ...appearance }, "Edit link");
    return;
  }
  if (!props.pageId || !props.rect) return;
  addAnnotations(docId, [createLink(props.pageId, props.rect, props.rotation ?? 0, target, { quads: props.quads, ...appearance })], "Add link");
}

export default function LinkDialog({ props, close }: DialogProps<LinkProps>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const existing = props.editId ? (doc?.annotations.find((a) => a.id === props.editId && a.kind === "link") as LinkAnnot | undefined) : undefined;
  const t = existing?.target;
  const initialPage = t?.type === "page" ? Math.max(0, doc?.pages.findIndex((p) => p.id === t.pageId) ?? 0) : Math.min(doc?.pages.length ?? 1, doc?.view.page ?? 1) - 1;
  const [kind, setKind] = useState<"page" | "url" | "email">(t?.type === "url" ? (/^mailto:/i.test(t.url) ? "email" : "url") : props.editId ? "page" : "url");
  const [page, setPage] = useState(initialPage + 1);
  const [keepView, setKeepView] = useState(t?.type === "page" && t.top !== null && t.top !== undefined);
  const [url, setUrl] = useState(t?.type === "url" && !/^mailto:/i.test(t.url) ? t.url : "");
  const [email, setEmail] = useState(t?.type === "url" && /^mailto:/i.test(t.url) ? t.url.replace(/^mailto:/i, "") : "");
  const [appearance, setAppearance] = useState<Appearance>(existing ? { showBorder: existing.showBorder, borderStyle: existing.borderStyle ?? "solid", borderWidth: existing.borderWidth ?? 1, color: existing.color, highlight: existing.highlight ?? "invert" } : DEFAULT_APPEARANCE);
  if (!doc) return null;
  const count = doc.pages.length;
  const label = doc.pages[page - 1]?.label;

  const target = (): LinkTarget | null => {
    if (kind === "page") {
      const p = doc.pages[page - 1];
      if (!p) return null;
      if (keepView && t?.type === "page" && t.pageId === p.id) return t;
      return { type: "page", pageId: p.id };
    }
    if (kind === "email") {
      const e = email.trim();
      return /^[^\s@]+@[^\s@]+$/.test(e) ? { type: "url", url: `mailto:${e}` } : null;
    }
    const u = normalizeUrl(url);
    return u ? { type: "url", url: u } : null;
  };

  const save = () => {
    const tg = target();
    if (!tg) return toast(kind === "email" ? "Enter a valid email address" : kind === "url" ? "Enter a web address" : "Choose a page", "warning");
    commitLink(props, doc.id, tg, appearance);
    close();
  };

  const pickView = () => {
    close();
    openDialog("link-view", { ...props, docId: doc.id, appearance });
  };

  const set = (patch: Partial<Appearance>) => setAppearance({ ...appearance, ...patch });

  return (
    <Dialog
      title={props.editId ? "Edit link" : "Create link"}
      icon={<Link2 size={18} />}
      onClose={close}
      width={520}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            {props.editId ? "Save" : "Create link"}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="dialog-section">
          <div className="dialog-section-title">Link action</div>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "url", label: "Open a web page" },
              { value: "page", label: "Go to a page" },
              { value: "email", label: "Send an email" },
            ]}
          />
          {kind === "url" && (
            <Field label="Web address" hint="For example https://example.com">
              <TextInput value={url} autoFocus placeholder="https://" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
            </Field>
          )}
          {kind === "email" && (
            <Field label="Email address">
              <TextInput value={email} autoFocus placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
            </Field>
          )}
          {kind === "page" && (
            <>
              <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
                <Field label="Page" hint={label && label !== String(page) ? `Page label “${label}”` : undefined}>
                  <NumberInput value={page} min={1} max={count} suffix={`of ${count}`} onChange={(v) => setPage(Math.min(count, Math.max(1, Math.round(v))))} />
                </Field>
                <Button icon={<Crosshair size={15} />} onClick={pickView} style={{ marginBottom: label && label !== String(page) ? 22 : 0 }}>
                  Choose a view…
                </Button>
              </div>
              {t?.type === "page" && t.top !== null && t.top !== undefined && doc.pages[page - 1]?.id === t.pageId && (
                <Checkbox checked={keepView} onChange={setKeepView} label="Keep the link's position on that page" />
              )}
            </>
          )}
        </div>

        <div className="dialog-section">
          <div className="dialog-section-title">Appearance</div>
          <div className="grid-2">
            <Field label="Link type">
              <Select
                value={appearance.showBorder ? "visible" : "invisible"}
                onChange={(e) => set({ showBorder: e.target.value === "visible" })}
                options={[
                  { value: "invisible", label: "Invisible rectangle" },
                  { value: "visible", label: "Visible rectangle" },
                ]}
              />
            </Field>
            <Field label="Highlight when clicked">
              <Select
                value={appearance.highlight ?? "invert"}
                onChange={(e) => set({ highlight: e.target.value as LinkHighlight })}
                options={[
                  { value: "none", label: "None" },
                  { value: "invert", label: "Invert" },
                  { value: "outline", label: "Outline" },
                  { value: "push", label: "Inset" },
                ]}
              />
            </Field>
            {appearance.showBorder && (
              <>
                <Field label="Line style">
                  <Select
                    value={appearance.borderStyle ?? "solid"}
                    onChange={(e) => set({ borderStyle: e.target.value as Appearance["borderStyle"] })}
                    options={[
                      { value: "solid", label: "Solid" },
                      { value: "dashed", label: "Dashed" },
                      { value: "underline", label: "Underline" },
                    ]}
                  />
                </Field>
                <Field label="Line thickness">
                  <div className="row" style={{ gap: 8 }}>
                    <Select
                      style={{ flex: 1 }}
                      value={String(appearance.borderWidth ?? 1)}
                      onChange={(e) => set({ borderWidth: Number(e.target.value) })}
                      options={[
                        { value: "1", label: "Thin" },
                        { value: "2", label: "Medium" },
                        { value: "3", label: "Thick" },
                      ]}
                    />
                    <ColorButton label="Line color" value={appearance.color} onChange={(c) => c && set({ color: c })} />
                  </div>
                </Field>
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Non-modal bar shown while the user scrolls to the page view a link should
 * open (Acrobat's "Create Go to View").
 */
export function LinkViewPicker({ props, close }: DialogProps<LinkProps & { appearance?: Appearance }>) {
  const docId = props.docId ?? useApp.getState().activeId ?? "";
  const pageNumber = useApp((s) => s.docs[docId]?.view.page ?? 1);
  const set = () => {
    const dest = currentDestination(docId);
    if (!dest) return;
    commitLink(props, docId, { type: "page", pageId: dest.pageId, top: dest.top }, props.appearance ?? DEFAULT_APPEARANCE);
    close();
    toast(`Link set to page ${pageNumber}`, "success");
  };
  return createPortal(
    <div className="floating-bar" role="dialog" aria-label="Choose the link's view">
      <Crosshair size={16} />
      <span>Scroll to the page and position the link should open, then click Set link.</span>
      <Button
        size="sm"
        onClick={() => {
          close();
          openDialog("link", props);
        }}
      >
        Back
      </Button>
      <Button size="sm" onClick={close}>
        Cancel
      </Button>
      <Button size="sm" variant="primary" onClick={set}>
        Set link
      </Button>
    </div>,
    document.body,
  );
}
