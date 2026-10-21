import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Annotation } from "../annotations/types";
import type { StageBox } from "../annotations/render";
import { updateAnnotation } from "../state/annotActions";
import { useApp } from "../state/store";
import { formatDateTime } from "../lib/util";

export function NotePopup({ docId, a, box, scale }: { docId: string; a: Annotation; box: StageBox; scale: number }) {
  const [text, setText] = useState(a.contents);
  const ref = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(text.length, text.length);
    // Save on unmount (e.g. clicking elsewhere closes the popup).
    return () => {
      if (textRef.current !== a.contents) updateAnnotation(docId, a.id, { contents: textRef.current }, "Edit note");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id]);

  const close = () => useApp.setState({ editingId: null });

  return (
    <div
      className="note-popup"
      style={{ left: (box.x + box.w) * scale + 10, top: box.y * scale }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") close();
      }}
    >
      <div className="note-popup-head" style={{ borderColor: a.color }}>
        <span className="note-popup-dot" style={{ background: a.color }} />
        <div className="col" style={{ gap: 0, minWidth: 0, flex: 1 }}>
          <strong className="ellipsis">{a.author}</strong>
          <span className="faint" style={{ fontSize: 11 }}>
            {formatDateTime(a.modifiedAt)}
          </span>
        </div>
        <button className="icon-btn icon-btn-sm" aria-label="Close note" onClick={close}>
          <X size={14} />
        </button>
      </div>
      <textarea ref={ref} className="note-popup-text" placeholder="Add a comment…" value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  );
}
