import { useRef, useState } from "react";
import { Search, CaseSensitive, WholeWord } from "lucide-react";
import { getRuntime, getViewer } from "../../state/runtime";
import { getDoc, setFind, useApp } from "../../state/store";
import { getPageText } from "../../lib/pdfjs";
import { EmptyState } from "../ui/Fields";
import { Spinner } from "../ui/Button";
import { dispatchFind } from "../shell/FindBar";

interface Hit {
  pageIndex: number;
  /** Ordinal of the match on its page (for stepping the find controller). */
  ordinal: number;
  before: string;
  match: string;
  after: string;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a regex that tolerates whitespace/line-break differences in the PDF text. */
export function buildSearchRegex(query: string, opts: { caseSensitive: boolean; wholeWord: boolean }) {
  const parts = query.trim().split(/\s+/).map(escapeRe);
  let src = parts.join("\\s+");
  if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}])${src}(?![\\p{L}\\p{N}])`;
  return new RegExp(src, `gu${opts.caseSensitive ? "" : "i"}`);
}

export default function SearchPanel({ docId }: { docId: string }) {
  const [query, setQuery] = useState(() => getDoc(docId)?.find.query ?? "");
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWhole] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const token = useRef(0);
  const pages = useApp((s) => s.docs[docId].pages);

  const run = async () => {
    const rt = getRuntime(docId);
    if (!rt || !query.trim()) return;
    const my = ++token.current;
    setBusy(true);
    setHits([]);
    const re = buildSearchRegex(query, { caseSensitive, wholeWord });
    const all: Hit[] = [];
    for (let i = 0; i < rt.pdf.numPages; i++) {
      if (token.current !== my) return;
      const text = (await getPageText(rt.pdf, i)).replace(/\s+/g, " ");
      let m: RegExpExecArray | null;
      let ordinal = 0;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        all.push({
          pageIndex: i,
          ordinal: ordinal++,
          before: text.slice(Math.max(0, m.index - 40), m.index),
          match: m[0],
          after: text.slice(m.index + m[0].length, m.index + m[0].length + 60),
        });
        if (m[0].length === 0) re.lastIndex++;
      }
      setProgress((i + 1) / rt.pdf.numPages);
      if (i % 10 === 9) setHits([...all]);
    }
    if (token.current !== my) return;
    setHits(all);
    setBusy(false);
  };

  const open = async (h: Hit) => {
    const v = getViewer(docId);
    if (!v) return;
    setFind(docId, { query, caseSensitive, entireWord: wholeWord, highlightAll: true });
    useApp.setState({ findBarOpen: true });
    v.goToPage(h.pageIndex + 1);
    // Start a fresh search from this page, then step to the n-th match on it.
    await new Promise((r) => setTimeout(r, 60));
    dispatchFind(docId, "");
    for (let k = 0; k < h.ordinal; k++) {
      await new Promise((r) => setTimeout(r, 40));
      dispatchFind(docId, "again");
    }
  };

  let last = -1;
  return (
    <div className="search-panel">
      <form
        className="panel-toolbar search-form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="search-input">
          <Search size={14} />
          <input autoFocus placeholder="Search the whole document" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <button type="button" className={`icon-btn icon-btn-sm${caseSensitive ? " is-active" : ""}`} aria-pressed={caseSensitive} data-tip="Match case" onClick={() => setCase(!caseSensitive)}>
          <CaseSensitive size={17} />
        </button>
        <button type="button" className={`icon-btn icon-btn-sm${wholeWord ? " is-active" : ""}`} aria-pressed={wholeWord} data-tip="Whole words" onClick={() => setWhole(!wholeWord)}>
          <WholeWord size={17} />
        </button>
      </form>
      {busy && (
        <div className="search-progress">
          <Spinner size="sm" /> Searching… {Math.round(progress * 100)}%
        </div>
      )}
      {hits === null ? (
        <EmptyState icon={<Search size={22} />} title="Search this document">
          Results show every match with surrounding text. Click one to jump to it.
        </EmptyState>
      ) : hits.length === 0 && !busy ? (
        <EmptyState icon={<Search size={22} />} title="No results">
          Nothing matched “{query}”. If this is a scanned document, run OCR first.
        </EmptyState>
      ) : (
        <div className="search-results scroll-thin">
          <div className="faint comments-count">{hits.length} results</div>
          {hits.map((h, i) => {
            const header = h.pageIndex !== last;
            last = h.pageIndex;
            return (
              <div key={i}>
                {header && <div className="comments-page">Page {pages[h.pageIndex]?.label ?? h.pageIndex + 1}</div>}
                <button className="search-hit" onClick={() => open(h)}>
                  <span className="faint">…{h.before}</span>
                  <mark>{h.match}</mark>
                  <span className="faint">{h.after}…</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
