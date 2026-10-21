import { useEffect, useState } from "react";
import { Info, Lock, ShieldCheck, Type } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button, Spinner } from "../ui/Button";
import { Field, Select, Tabs, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, openDialog, updateDoc } from "../../state/store";
import { getRuntime } from "../../state/runtime";
import { formatBytes, formatDateTime } from "../../lib/util";
import { listFonts, type FontInfo } from "../../ops/inspect";
import { pdfjs } from "../../lib/pdfjs";
import type { DocMetadata } from "../../state/types";

type Tab = "description" | "security" | "fonts" | "view";

const PAGE_SIZES: [string, number, number][] = [
  ["Letter", 612, 792],
  ["Legal", 612, 1008],
  ["Tabloid", 792, 1224],
  ["A3", 842, 1191],
  ["A4", 595, 842],
  ["A5", 420, 595],
  ["B5", 499, 709],
  ["Executive", 522, 756],
];

export function describePageSize(w: number, h: number) {
  const inch = (n: number) => (n / 72).toFixed(2);
  const mm = (n: number) => Math.round((n / 72) * 25.4);
  const match = PAGE_SIZES.find(([, a, b]) => (Math.abs(a - w) < 3 && Math.abs(b - h) < 3) || (Math.abs(a - h) < 3 && Math.abs(b - w) < 3));
  return `${inch(w)} × ${inch(h)} in (${mm(w)} × ${mm(h)} mm)${match ? ` · ${match[0]}` : ""}`;
}

export default function PropertiesDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [tab, setTab] = useState<Tab>("description");
  const [meta, setMeta] = useState<DocMetadata | null>(doc?.metadata ?? null);
  const [fonts, setFonts] = useState<FontInfo[] | null>(null);
  const [layout, setLayout] = useState<string>(doc?.metadata?.pageLayout ?? "");
  const [pageMode, setPageMode] = useState<string>(doc?.metadata?.pageMode ?? "");
  const [orig, setOrig] = useState({ layout: layout, pageMode: pageMode });

  useEffect(() => {
    const rt = doc && getRuntime(doc.id);
    if (!rt || doc?.metadata?.pageLayout) return;
    Promise.all([rt.pdf.getPageLayout().catch(() => ""), rt.pdf.getPageMode().catch(() => "")]).then(([l, m]) => {
      setLayout(l || "");
      setPageMode(m || "");
      setOrig({ layout: l || "", pageMode: m || "" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab !== "fonts" || fonts || !doc) return;
    const rt = getRuntime(doc.id);
    if (!rt) return;
    listFonts(rt.bytes)
      .then(setFonts)
      .catch(() => setFonts([]));
  }, [tab, fonts, doc]);

  if (!doc || !meta) return null;
  const page = doc.pages[doc.view.page - 1];
  const w = page ? (page.view[2] - page.view[0]) * page.userUnit : 0;
  const h = page ? (page.view[3] - page.view[1]) * page.userUnit : 0;
  const set = (k: keyof DocMetadata, v: string) => setMeta({ ...meta, [k]: v });
  const changed = JSON.stringify(meta) !== JSON.stringify(doc.metadata) || layout !== orig.layout || pageMode !== orig.pageMode;

  const apply = () => {
    updateDoc(doc.id, { metadata: { ...meta, pageLayout: layout || undefined, pageMode: pageMode || undefined }, metadataDirty: true, dirty: true });
    close();
  };

  const perms = doc.security.permissions;
  const P = (pdfjs as unknown as { PermissionFlag: Record<string, number> }).PermissionFlag;
  const allowed = (flag: string) => !perms || perms.includes(P[flag]);

  return (
    <Dialog
      title="Document properties"
      icon={<Info size={18} />}
      subtitle={doc.name}
      onClose={close}
      width={600}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!changed}>
            Apply
          </Button>
        </>
      }
    >
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "description", label: "Description" },
          { value: "security", label: "Security" },
          { value: "fonts", label: "Fonts" },
          { value: "view", label: "Initial view" },
        ]}
      />
      {tab === "description" && (
        <>
          <div className="grid-2">
            <Field label="Title">
              <TextInput value={meta.title} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <Field label="Author">
              <TextInput value={meta.author} onChange={(e) => set("author", e.target.value)} />
            </Field>
            <Field label="Subject">
              <TextInput value={meta.subject} onChange={(e) => set("subject", e.target.value)} />
            </Field>
            <Field label="Keywords" hint="Separate with commas">
              <TextInput value={meta.keywords} onChange={(e) => set("keywords", e.target.value)} />
            </Field>
          </div>
          <dl className="kv">
            <dt>File</dt>
            <dd>{doc.name}</dd>
            <dt>File size</dt>
            <dd>{formatBytes(doc.fileSize)}</dd>
            <dt>Pages</dt>
            <dd>{doc.pages.length}</dd>
            <dt>Page size</dt>
            <dd>{describePageSize(w, h)}</dd>
            <dt>Created</dt>
            <dd>{formatDateTime(meta.creationDate)}</dd>
            <dt>Modified</dt>
            <dd>{formatDateTime(meta.modDate)}</dd>
            <dt>Application</dt>
            <dd>{meta.creator || "—"}</dd>
            <dt>PDF producer</dt>
            <dd>{meta.producer || "—"}</dd>
            <dt>PDF version</dt>
            <dd>{meta.pdfVersion}</dd>
            <dt>Tagged PDF</dt>
            <dd>{meta.isTagged ? "Yes" : "No"}</dd>
            <dt>Fast web view</dt>
            <dd>{meta.isLinearized ? "Yes" : "No"}</dd>
            <dt>Forms</dt>
            <dd>{meta.isXfa ? "XFA form" : meta.isAcroForm ? "Interactive form" : "None"}</dd>
            <dt>Digital signatures</dt>
            <dd>{meta.isSignatures ? "Yes" : "No"}</dd>
          </dl>
        </>
      )}
      {tab === "security" && (
        <>
          <div className={`callout ${doc.security.encrypted ? "callout-info" : ""}`}>
            {doc.security.encrypted ? <Lock size={16} /> : <ShieldCheck size={16} />}
            <span>
              {doc.security.encrypted ? (
                <>
                  Password security ({doc.security.filter ?? "Standard"}).{" "}
                  {doc.security.pending?.kind === "remove" ? "Will be removed when you save." : "Kept when you save."}
                </>
              ) : doc.security.pending?.kind === "encrypt" ? (
                "A password will be added when you save."
              ) : (
                "No security. Anyone can open, copy and print this document."
              )}
            </span>
          </div>
          <dl className="kv">
            {[
              ["Printing", allowed("PRINT") ? (allowed("PRINT_HIGH_QUALITY") ? "Allowed" : "Low resolution only") : "Not allowed"],
              ["Changing the document", allowed("MODIFY_CONTENTS") ? "Allowed" : "Not allowed"],
              ["Content copying", allowed("COPY") ? "Allowed" : "Not allowed"],
              ["Content copying for accessibility", allowed("COPY_FOR_ACCESSIBILITY") ? "Allowed" : "Not allowed"],
              ["Page extraction / assembly", allowed("ASSEMBLE") ? "Allowed" : "Not allowed"],
              ["Commenting", allowed("MODIFY_ANNOTATIONS") ? "Allowed" : "Not allowed"],
              ["Filling form fields", allowed("FILL_INTERACTIVE_FORMS") ? "Allowed" : "Not allowed"],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="row">
            <Button
              icon={<Lock size={15} />}
              onClick={() => {
                close();
                openDialog("protect", { docId: doc.id });
              }}
            >
              Change security…
            </Button>
            {doc.security.encrypted && (
              <Button
                variant="ghost"
                onClick={() => {
                  close();
                  openDialog("remove-security", { docId: doc.id });
                }}
              >
                Remove security…
              </Button>
            )}
          </div>
        </>
      )}
      {tab === "fonts" &&
        (fonts === null ? (
          <div className="center-fill" style={{ minHeight: 120 }}>
            <Spinner />
          </div>
        ) : fonts.length === 0 ? (
          <p className="muted">No fonts are used (the document may contain only images).</p>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {fonts.map((f, i) => (
              <div key={i} className="file-row">
                <span className="att-icon">
                  <Type size={16} />
                </span>
                <div className="col" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                  <strong className="ellipsis">{f.name}</strong>
                  <span className="faint" style={{ fontSize: 11.5 }}>
                    {f.type} · {f.encoding} · {f.embedded ? (f.subset ? "Embedded subset" : "Embedded") : "Not embedded"} · pages {f.pages.slice(0, 6).map((p) => p + 1).join(", ")}
                    {f.pages.length > 6 ? "…" : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ))}
      {tab === "view" && (
        <div className="grid-2">
          <Field label="Page layout" hint="How pages are shown when the file opens">
            <Select
              value={layout || "SinglePage"}
              onChange={(e) => setLayout(e.target.value)}
              options={[
                { value: "SinglePage", label: "Single page" },
                { value: "OneColumn", label: "Single page continuous" },
                { value: "TwoPageLeft", label: "Two-up" },
                { value: "TwoColumnLeft", label: "Two-up continuous" },
                { value: "TwoPageRight", label: "Two-up (cover page)" },
                { value: "TwoColumnRight", label: "Two-up continuous (cover page)" },
              ]}
            />
          </Field>
          <Field label="Navigation panel">
            <Select
              value={pageMode || "UseNone"}
              onChange={(e) => setPageMode(e.target.value)}
              options={[
                { value: "UseNone", label: "Page only" },
                { value: "UseOutlines", label: "Bookmarks panel and page" },
                { value: "UseThumbs", label: "Pages panel and page" },
                { value: "UseAttachments", label: "Attachments panel and page" },
                { value: "FullScreen", label: "Full screen" },
              ]}
            />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
