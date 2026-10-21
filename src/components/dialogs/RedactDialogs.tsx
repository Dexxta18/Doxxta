import { useEffect, useRef, useState } from "react";
import { EyeOff, Search, ShieldAlert } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, Segmented, TextArea } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { getActiveDoc, getDoc, openDialog, setMode, toast, withBusy } from "../../state/store";
import { getRuntime, getViewer } from "../../state/runtime";
import { addAnnotations } from "../../state/annotActions";
import { createRedaction } from "../../annotations/factory";
import { quadBounds, unionRects } from "../../lib/geometry";
import { plural } from "../../lib/util";
import { PageScope, scopePages, type Scope } from "./markControls";
import { validatePageRanges } from "../../lib/pageRanges";
import { buildSearchRegex } from "../panels/SearchPanel";
import type { RedactMatch } from "../../ops/redact";
import type { SanitizeOptions } from "../../ops/sanitize";

export default function SearchRedactDialog({ props, close }: DialogProps<{ docId?: string }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [kind, setKind] = useState<"words" | "patterns">("words");
  const [words, setWords] = useState("");
  const [wholeWord, setWholeWord] = useState(true);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [patterns, setPatterns] = useState<Set<string>>(new Set(["email", "phone", "ssn"]));
  const [scope, setScope] = useState<Scope>("all");
  const [range, setRange] = useState("");
  const [matches, setMatches] = useState<RedactMatch[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<number | null>(null);
  const cancelled = useRef(false);
  const mod = useRef<typeof import("../../ops/redact") | null>(null);
  const [labels, setLabels] = useState<{ id: string; label: string; example: string }[]>([]);
  useEffect(() => {
    let live = true;
    import("../../ops/redact").then((m) => {
      mod.current = m;
      if (live) setLabels(m.REDACTION_PATTERNS.map(({ id, label, example }) => ({ id, label, example })));
    });
    return () => {
      live = false;
    };
  }, []);
  if (!doc) return null;
  const err = scope === "range" ? validatePageRanges(range, doc.pages.length) : null;

  const search = async () => {
    const rt = getRuntime(doc.id);
    const m = mod.current ?? (mod.current = await import("../../ops/redact"));
    if (!rt) return;
    const searches =
      kind === "words"
        ? words
            .split(/\n/)
            .map((w) => w.trim())
            .filter(Boolean)
            .map((w) => ({ regex: buildSearchRegex(w, { caseSensitive, wholeWord }) }))
        : m.REDACTION_PATTERNS.filter((p) => patterns.has(p.id)).map((p) => ({ regex: new RegExp(p.regex.source, p.regex.flags), accept: p.accept }));
    if (!searches.length) return toast(kind === "words" ? "Enter at least one word or phrase" : "Choose at least one pattern", "warning");
    cancelled.current = false;
    setProgress(0);
    try {
      const found = await m.findRedactionMatches({ pdf: rt.pdf, bytes: rt.bytes }, searches, scopePages(scope, range, doc.pages.length, doc.view.page), (done, total) => setProgress(done / total), () => cancelled.current);
      setMatches(found);
      setPicked(new Set(found.map((f) => f.id)));
    } finally {
      setProgress(null);
    }
  };

  const mark = () => {
    if (!matches) return;
    const chosen = matches.filter((m) => picked.has(m.id));
    const annots = chosen.map((m) => {
      const page = doc.pages[m.pageIndex];
      return createRedaction(page.id, unionRects(m.quads.map(quadBounds))!, (page.rotate + doc.view.rotation) % 360, m.quads, m.text);
    });
    if (!annots.length) return;
    addAnnotations(doc.id, annots, `Mark ${annots.length} for redaction`, false);
    if (doc.mode !== "redact") setMode(doc.id, "redact");
    close();
    toast(`${plural(annots.length, "area")} marked for redaction`, "success", { action: { label: "Apply now", run: () => openDialog("apply-redactions", { docId: doc.id }) } });
  };

  const show = (m: RedactMatch) => {
    const v = getViewer(doc.id);
    const [x0, , , y1] = unionRects(m.quads.map(quadBounds))!;
    v?.scrollToPoint(m.pageIndex, x0, y1, { center: true });
  };

  const byPage = new Map<number, RedactMatch[]>();
  for (const m of matches ?? []) byPage.set(m.pageIndex, [...(byPage.get(m.pageIndex) ?? []), m]);

  return (
    <Dialog
      title="Find text to redact"
      icon={<Search size={18} />}
      onClose={() => {
        cancelled.current = true;
        close();
      }}
      width={640}
      footer={
        matches ? (
          <>
            <Button variant="ghost" style={{ marginRight: "auto" }} onClick={() => setMatches(null)}>
              New search
            </Button>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" icon={<EyeOff size={15} />} disabled={!picked.size} onClick={mark}>
              Mark {picked.size || ""} for redaction
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" icon={<Search size={15} />} onClick={search} loading={progress !== null} disabled={!!err}>
              Search
            </Button>
          </>
        )
      }
    >
      {!matches ? (
        <div className="col" style={{ gap: 14 }}>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "words", label: "Words or phrases" },
              { value: "patterns", label: "Patterns" },
            ]}
          />
          {kind === "words" ? (
            <>
              <Field label="Find" hint="One word or phrase per line">
                <TextArea rows={4} value={words} autoFocus onChange={(e) => setWords(e.target.value)} placeholder={"Jane Doe\nProject Falcon"} />
              </Field>
              <div className="row" style={{ gap: 18 }}>
                <Checkbox checked={wholeWord} onChange={setWholeWord} label="Whole words only" />
                <Checkbox checked={caseSensitive} onChange={setCaseSensitive} label="Match case" />
              </div>
            </>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {labels.map((p) => (
                <Checkbox
                  key={p.id}
                  checked={patterns.has(p.id)}
                  onChange={(on) => {
                    const next = new Set(patterns);
                    if (on) next.add(p.id);
                    else next.delete(p.id);
                    setPatterns(next);
                  }}
                  label={p.label}
                  hint={`e.g. ${p.example}`}
                />
              ))}
            </div>
          )}
          <PageScope count={doc.pages.length} scope={scope} setScope={setScope} range={range} setRange={setRange} error={err} current={doc.view.page} />
          {progress !== null && (
            <div className="progress">
              <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>
      ) : matches.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No matches found.
        </p>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {plural(matches.length, "match", "matches")} on {plural(byPage.size, "page")}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(matches.map((m) => m.id)))}>
                Select all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                Select none
              </Button>
            </span>
          </div>
          <div className="redact-results">
            {[...byPage].map(([pageIndex, list]) => (
              <div key={pageIndex} className="redact-results-page">
                <div className="redact-results-title">Page {doc.pages[pageIndex]?.label || pageIndex + 1}</div>
                {list.map((m) => (
                  <label key={m.id} className="redact-result">
                    <input
                      type="checkbox"
                      checked={picked.has(m.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(m.id);
                        else next.delete(m.id);
                        setPicked(next);
                      }}
                    />
                    <button type="button" className="redact-result-text" onClick={() => show(m)}>
                      <span className="faint">…{m.before}</span>
                      <mark>{m.text}</mark>
                      <span className="faint">{m.after}…</span>
                    </button>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}

const HIDDEN_DEFAULTS: SanitizeOptions = { metadata: true, attachments: true, comments: false, formFields: false, hiddenText: false, hiddenLayers: true, bookmarks: false, scripts: true, thumbnails: true, privateData: true };

export function ApplyRedactionsDialog({ props, close }: DialogProps<{ docId?: string; ids?: string[] }>) {
  const doc = getDoc(props.docId) ?? getActiveDoc();
  const [hidden, setHidden] = useState(false);
  if (!doc) return null;
  const marks = doc.annotations.filter((a) => a.kind === "redact" && (!props.ids || props.ids.includes(a.id)));
  const pages = new Set(marks.map((m) => m.pageId)).size;

  const apply = async () => {
    close();
    const { applyRedactions } = await import("../../ops/redact");
    const s = await withBusy("Applying redactions…", () => applyRedactions(doc.id, { ids: props.ids, sanitize: hidden ? HIDDEN_DEFAULTS : undefined }));
    if (!s) return;
    const parts = [s.glyphs && plural(s.glyphs, "character"), s.images && plural(s.images, "image"), s.graphics && plural(s.graphics, "graphic"), s.annotations && plural(s.annotations, "comment or field", "comments or fields")].filter(Boolean);
    toast(`Redacted ${plural(s.marks, "area")} on ${plural(s.pages, "page")}${parts.length ? ` — removed ${parts.join(", ")}` : ""}. Save to keep the changes.`, "success", { timeout: 8000 });
    if (s.rasterized.length) toast(`Page${s.rasterized.length > 1 ? "s" : ""} ${s.rasterized.join(", ")} used content that can't be removed piece by piece, so ${s.rasterized.length > 1 ? "they were" : "it was"} converted to an image.`, "warning", { timeout: 10000 });
  };

  if (!marks.length) {
    return (
      <Dialog title="Apply redactions" icon={<EyeOff size={18} />} onClose={close} width={460} footer={<Button variant="primary" onClick={close}>OK</Button>}>
        <p style={{ margin: 0 }}>There are no redaction marks yet. Mark text or areas with the Redact tools first.</p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Apply redactions"
      icon={<ShieldAlert size={18} />}
      onClose={close}
      width={500}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" icon={<EyeOff size={15} />} onClick={apply}>
            Apply {plural(marks.length, "redaction")}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p style={{ margin: 0 }}>
          The text, images and graphics under {plural(marks.length, "mark")} on {plural(pages, "page")} will be permanently removed from the document. Comments and form fields in those areas are removed too.
        </p>
        <div className="callout">You can undo this until you save. After saving, the removed content can't be recovered from the file.</div>
        <Checkbox checked={hidden} onChange={setHidden} label="Also remove hidden information" hint="Metadata, attachments, scripts, hidden layers, thumbnails and private application data." />
      </div>
    </Dialog>
  );
}
