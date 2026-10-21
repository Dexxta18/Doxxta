import { useRef, useState } from "react";
import { Lock, MessageSquare, MoreHorizontal, Trash2, Type, Bold, Italic, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import type { Annotation } from "../annotations/types";
import type { StageBox } from "../annotations/render";
import { ColorButton, Slider } from "../components/ui/Fields";
import { IconButton } from "../components/ui/Button";
import { Popover } from "../components/ui/Popover";
import { updateAnnotations } from "../state/annotActions";
import { getDoc, useApp } from "../state/store";
import { useSettings } from "../state/settings";
import { deleteSelected } from "../core/annotOps";
import { openAnnotContextMenu } from "./annotMenu";
import { HIGHLIGHT_COLORS } from "../lib/colors";
import { computeRect } from "../annotations/geometry";

const hasStroke = (a: Annotation) => ["ink", "rect", "ellipse", "line", "polygon", "polyline", "symbol"].includes(a.kind);
const hasFill = (a: Annotation) => a.kind === "rect" || a.kind === "ellipse" || a.kind === "polygon" || a.kind === "freetext" || (a.kind === "line" && false);

export function AnnotToolbar({ docId, a, box, scale, count }: { docId: string; a: Annotation; box: StageBox; scale: number; count: number }) {
  const widthRef = useRef<HTMLButtonElement>(null);
  const opRef = useRef<HTMLButtonElement>(null);
  const [pop, setPop] = useState<"width" | "opacity" | null>(null);

  const apply = (patch: Partial<Annotation> | ((x: Annotation) => Partial<Annotation>), key: string) => {
    const doc = getDoc(docId);
    if (!doc) return;
    const ids = new Set(doc.selection);
    updateAnnotations(
      docId,
      (x) => {
        if (!ids.has(x.id) || x.locked) return null;
        const p = typeof patch === "function" ? patch(x) : patch;
        const next = { ...x, ...p } as Annotation;
        return { ...next, rect: computeRect(next) } as Annotation;
      },
      "Change style",
      `style-${key}-${[...ids].join()}`,
    );
  };

  const left = box.x * scale + (box.w * scale) / 2;
  let top = box.y * scale - 46;
  const below = top < 4;
  if (below) top = (box.y + box.h) * scale + 10;

  if (a.locked) {
    return (
      <div className="annot-toolbar" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
        <span className="annot-toolbar-note">
          <Lock size={13} /> Locked
        </span>
        <IconButton size="sm" icon={<MoreHorizontal size={16} />} label="More" onClick={(e) => openAnnotContextMenu(docId, e.clientX, e.clientY)} />
      </div>
    );
  }

  const isText = a.kind === "freetext";
  const colorValue = isText ? a.textColor : a.color;
  const markup = a.kind === "highlight";

  return (
    <div className="annot-toolbar" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {a.kind !== "image" && a.kind !== "redact" && a.kind !== "link" && a.kind !== "field" && a.kind !== "textedit" && (
        <ColorButton
          label={isText ? "Text color" : "Color"}
          value={colorValue}
          colors={markup ? HIGHLIGHT_COLORS : undefined}
          onChange={(c) => c && apply(isText ? { textColor: c } as never : { color: c }, "color")}
        />
      )}
      {isText && (
        <ColorButton label="Border color" allowNone value={a.borderColor} onChange={(c) => apply({ borderColor: c, borderWidth: c ? Math.max(1, a.borderWidth) : 0 } as never, "border")} />
      )}
      {hasFill(a) && <ColorButton label="Fill color" allowNone value={"fillColor" in a ? (a.fillColor as string | null) : null} onChange={(c) => apply({ fillColor: c } as never, "fill")} />}
      {isText && (
        <>
          <span className="annot-toolbar-sep" />
          <select
            className="annot-toolbar-select"
            value={a.fontSize}
            data-tip="Font size"
            onChange={(e) => apply({ fontSize: Number(e.target.value) } as never, "fontsize")}
          >
            {[6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72].map((s) => (
              <option key={s} value={s}>
                {s} pt
              </option>
            ))}
          </select>
          <select className="annot-toolbar-select" value={a.fontFamily} data-tip="Font" onChange={(e) => apply({ fontFamily: e.target.value } as never, "font")}>
            <option value="Helvetica">Sans</option>
            <option value="Times">Serif</option>
            <option value="Courier">Mono</option>
          </select>
          <IconButton size="sm" icon={<Bold size={15} />} label="Bold" active={a.bold} onClick={() => apply({ bold: !a.bold } as never, "bold")} />
          <IconButton size="sm" icon={<Italic size={15} />} label="Italic" active={a.italic} onClick={() => apply({ italic: !a.italic } as never, "italic")} />
          <IconButton
            size="sm"
            icon={a.align === "center" ? <AlignCenter size={15} /> : a.align === "right" ? <AlignRight size={15} /> : <AlignLeft size={15} />}
            label="Alignment"
            onClick={() => apply({ align: a.align === "left" ? "center" : a.align === "center" ? "right" : "left" } as never, "align")}
          />
        </>
      )}
      {hasStroke(a) && (
        <>
          <button ref={widthRef} className="annot-toolbar-chip" data-tip="Line thickness" onClick={() => setPop(pop === "width" ? null : "width")}>
            <span className="stroke-sample" style={{ height: Math.min(8, Math.max(1, (a as { strokeWidth: number }).strokeWidth)) }} />
            {(a as { strokeWidth: number }).strokeWidth}pt
          </button>
          <Popover open={pop === "width"} anchor={widthRef} onClose={() => setPop(null)} ignoreRefs={[widthRef]} className="popover-pad" placement="bottom">
            <div className="popover-title">Thickness</div>
            <div style={{ width: 200 }}>
              <Slider value={(a as { strokeWidth: number }).strokeWidth} min={0.5} max={a.kind === "ink" ? 30 : 12} step={0.5} format={(v) => `${v} pt`} onChange={(v) => apply({ strokeWidth: v } as never, "width")} />
            </div>
          </Popover>
        </>
      )}
      {a.kind !== "redact" && a.kind !== "link" && a.kind !== "field" && a.kind !== "textedit" && (
        <>
          <button ref={opRef} className="annot-toolbar-chip" data-tip="Opacity" onClick={() => setPop(pop === "opacity" ? null : "opacity")}>
            {Math.round(a.opacity * 100)}%
          </button>
          <Popover open={pop === "opacity"} anchor={opRef} onClose={() => setPop(null)} ignoreRefs={[opRef]} className="popover-pad" placement="bottom">
            <div className="popover-title">Opacity</div>
            <div style={{ width: 200 }}>
              <Slider value={Math.round(a.opacity * 100)} min={5} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => apply({ opacity: v / 100 }, "opacity")} />
            </div>
          </Popover>
        </>
      )}
      <span className="annot-toolbar-sep" />
      {isText && count === 1 && <IconButton size="sm" icon={<Type size={15} />} label="Edit text" onClick={() => useApp.setState({ editingId: a.id })} />}
      {a.kind !== "field" && a.kind !== "link" && count === 1 && (
        <IconButton
          size="sm"
          icon={<MessageSquare size={15} />}
          label="Comment"
          onClick={() => {
            useSettings.getState().set({ rightPanel: "comments" });
            useApp.setState({ focusCommentId: a.id });
          }}
        />
      )}
      <IconButton size="sm" icon={<Trash2 size={15} />} label="Delete" shortcut="Del" onClick={() => deleteSelected(docId)} />
      <IconButton size="sm" icon={<MoreHorizontal size={16} />} label="More" onClick={(e) => openAnnotContextMenu(docId, e.clientX, e.clientY)} />
    </div>
  );
}
