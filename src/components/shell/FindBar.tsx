import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X, CaseSensitive, WholeWord, Highlighter, ListTree } from "lucide-react";
import { setFind, useApp } from "../../state/store";
import { getViewer } from "../../state/runtime";
import { useSettings } from "../../state/settings";
import type { FindState } from "../../state/types";

/** Dispatches a find request to pdf.js' find controller. */
export function dispatchFind(docId: string, type: "" | "again" | "casesensitivitychange" | "entirewordchange" | "highlightallchange" | "diacriticmatchchange", findPrevious = false) {
  const v = getViewer(docId);
  const f = useApp.getState().docs[docId]?.find;
  if (!v || !f) return;
  v.eventBus.dispatch("find", {
    source: null,
    type,
    query: f.query,
    caseSensitive: f.caseSensitive,
    entireWord: f.entireWord,
    highlightAll: f.highlightAll,
    findPrevious,
    matchDiacritics: f.matchDiacritics,
  });
}

export function FindBar({ docId }: { docId: string }) {
  const open = useApp((s) => s.findBarOpen);
  const find = useApp((s) => s.docs[docId]?.find);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.select(), 0);
  }, [open]);

  if (!open || !find) return null;

  const update = (patch: Partial<FindState>, type: Parameters<typeof dispatchFind>[1]) => {
    setFind(docId, patch);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => dispatchFind(docId, type), type === "" ? 120 : 0);
  };

  const close = () => {
    useApp.setState({ findBarOpen: false });
    const v = getViewer(docId);
    v?.eventBus.dispatch("findbarclose", { source: null });
  };

  const statusText =
    !find.query
      ? ""
      : find.status === "pending"
        ? "Searching…"
        : find.total === 0 && find.status !== "idle"
          ? "No matches"
          : find.total > 0
            ? `${find.current} of ${find.total}${find.status === "wrapped" ? " ↻" : ""}`
            : "";

  return (
    <div className="findbar" role="search" onKeyDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className={`input findbar-input${find.query && find.total === 0 && find.status === "notfound" ? " is-notfound" : ""}`}
        placeholder="Find in document"
        value={find.query}
        onChange={(e) => update({ query: e.target.value }, "")}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            dispatchFind(docId, "again", e.shiftKey);
          }
          if (e.key === "Escape") close();
        }}
      />
      <span className="findbar-status">{statusText}</span>
      <button className="icon-btn icon-btn-sm" aria-label="Previous match" data-tip="Previous (Shift+Enter)" onClick={() => dispatchFind(docId, "again", true)}>
        <ChevronUp size={16} />
      </button>
      <button className="icon-btn icon-btn-sm" aria-label="Next match" data-tip="Next (Enter)" onClick={() => dispatchFind(docId, "again", false)}>
        <ChevronDown size={16} />
      </button>
      <span className="toolbar-sep" />
      <button className={`icon-btn icon-btn-sm${find.caseSensitive ? " is-active" : ""}`} aria-pressed={find.caseSensitive} data-tip="Match case" onClick={() => update({ caseSensitive: !find.caseSensitive }, "casesensitivitychange")}>
        <CaseSensitive size={17} />
      </button>
      <button className={`icon-btn icon-btn-sm${find.entireWord ? " is-active" : ""}`} aria-pressed={find.entireWord} data-tip="Whole words" onClick={() => update({ entireWord: !find.entireWord }, "entirewordchange")}>
        <WholeWord size={17} />
      </button>
      <button className={`icon-btn icon-btn-sm${find.highlightAll ? " is-active" : ""}`} aria-pressed={find.highlightAll} data-tip="Highlight all" onClick={() => update({ highlightAll: !find.highlightAll }, "highlightallchange")}>
        <Highlighter size={16} />
      </button>
      <button className="icon-btn icon-btn-sm" data-tip="Show all results" onClick={() => useSettings.getState().set({ rightPanel: "search" })}>
        <ListTree size={16} />
      </button>
      <button className="icon-btn icon-btn-sm" aria-label="Close find" onClick={close}>
        <X size={16} />
      </button>
    </div>
  );
}
