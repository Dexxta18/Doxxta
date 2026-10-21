import { createPortal } from "react-dom";
import { Copy, EyeOff, Highlighter, MessageSquarePlus, Strikethrough, Underline, Volume2, Waves, Search } from "lucide-react";
import { markupFromSelection, useTextSelectionMenu } from "../../viewer/interactions";
import { setFind, toast, useApp } from "../../state/store";
import { useSettings } from "../../state/settings";
import { dispatchFind } from "./FindBar";

export function SelectionMenu() {
  const state = useTextSelectionMenu();
  if (!state.docId || !("selections" in state)) return null;
  const { docId, selections, x, y } = state;
  const close = () => useTextSelectionMenu.setState({ docId: null });
  const text = selections.map((s) => s.text).join("\n");
  const style = useSettings.getState().toolStyles.highlight;

  const act = (kind: "highlight" | "underline" | "strikeout" | "squiggly" | "redact") => {
    markupFromSelection(docId, kind, selections);
    close();
  };

  const left = Math.min(Math.max(8, x - 140), window.innerWidth - 300);
  const top = Math.min(y, window.innerHeight - 60);

  return createPortal(
    <div className="selection-menu" style={{ left, top }} onPointerDown={(e) => e.preventDefault()}>
      <button data-tip="Highlight" onClick={() => act("highlight")}>
        <Highlighter size={16} style={{ color: style?.color ?? "#e8b400" }} />
      </button>
      <button data-tip="Underline" onClick={() => act("underline")}>
        <Underline size={16} />
      </button>
      <button data-tip="Strikethrough" onClick={() => act("strikeout")}>
        <Strikethrough size={16} />
      </button>
      <button data-tip="Squiggly" onClick={() => act("squiggly")}>
        <Waves size={16} />
      </button>
      <span className="toolbar-sep" />
      <button
        data-tip="Highlight and comment"
        onClick={() => {
          const ids = markupFromSelection(docId, "highlight", selections);
          close();
          if (ids[0]) {
            useSettings.getState().set({ rightPanel: "comments" });
            useApp.setState({ focusCommentId: ids[0] });
          }
        }}
      >
        <MessageSquarePlus size={16} />
      </button>
      <button
        data-tip="Copy text"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast("Copied", "success");
          } catch {
            document.execCommand("copy");
          }
          close();
        }}
      >
        <Copy size={16} />
      </button>
      <button
        data-tip="Find in document"
        onClick={() => {
          setFind(docId, { query: text.slice(0, 200) });
          useApp.setState({ findBarOpen: true });
          setTimeout(() => dispatchFind(docId, ""), 50);
          close();
        }}
      >
        <Search size={16} />
      </button>
      <button
        data-tip="Read aloud"
        onClick={async () => {
          (await import("../../ops/speech")).speakText(text);
          close();
        }}
      >
        <Volume2 size={16} />
      </button>
      <span className="toolbar-sep" />
      <button data-tip="Mark for redaction" onClick={() => act("redact")}>
        <EyeOff size={16} />
      </button>
    </div>,
    document.body,
  );
}
