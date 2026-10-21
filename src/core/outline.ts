import { getRuntime, getViewer } from "../state/runtime";
import { getDoc, updateDoc } from "../state/store";
import type { OutlineNode } from "../state/types";
import { rgbToHex } from "../lib/colors";
import { uid } from "../lib/util";

interface PdfjsOutlineItem {
  title: string;
  bold: boolean;
  italic: boolean;
  color: Uint8ClampedArray | number[] | null;
  dest: string | unknown[] | null;
  url: string | null;
  unsafeUrl?: string;
  items: PdfjsOutlineItem[];
}

/** Loads the document outline into the editable bookmark model. */
export async function loadOutline(docId: string): Promise<OutlineNode[]> {
  const rt = getRuntime(docId);
  const doc = getDoc(docId);
  if (!rt || !doc) return [];
  const pdf = rt.pdf;
  const raw = ((await pdf.getOutline()) ?? []) as PdfjsOutlineItem[];
  const convert = async (items: PdfjsOutlineItem[]): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    for (const it of items) {
      let pageIndex: number | null = null;
      let top: number | null = null;
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          const ref = dest[0] as { num: number; gen: number } | number | null;
          if (ref && typeof ref === "object") pageIndex = await pdf.getPageIndex(ref as never);
          else if (typeof ref === "number") pageIndex = ref;
          const kind = (dest[1] as { name?: string } | undefined)?.name;
          if (kind === "XYZ" && typeof dest[3] === "number") top = dest[3] as number;
          else if ((kind === "FitH" || kind === "FitBH") && typeof dest[2] === "number") top = dest[2] as number;
        }
      } catch {
        /* unresolved destination */
      }
      const c = it.color;
      const color = c && c.length === 3 && (c[0] || c[1] || c[2]) ? rgbToHex(c[0], c[1], c[2]) : null;
      out.push({
        id: uid("o"),
        title: it.title,
        pageId: pageIndex !== null ? doc.pages[pageIndex]?.id : undefined,
        top,
        url: it.url ?? it.unsafeUrl ?? undefined,
        bold: it.bold,
        italic: it.italic,
        color,
        children: await convert(it.items ?? []),
      });
    }
    return out;
  };
  const outline = await convert(raw);
  updateDoc(docId, { outline });
  return outline;
}

export function goToOutlineNode(docId: string, node: OutlineNode) {
  const doc = getDoc(docId);
  const v = getViewer(docId);
  if (!doc || !v) return;
  if (node.url && !node.pageId) {
    window.open(node.url, "_blank", "noopener,noreferrer");
    return;
  }
  const index = doc.pages.findIndex((p) => p.id === node.pageId);
  if (index < 0) return;
  if (node.top !== null && node.top !== undefined) {
    v.pdfViewer.scrollPageIntoView({ pageNumber: index + 1, destArray: [null, { name: "XYZ" }, null, node.top, null], allowNegativeOffset: true });
  } else v.goToPage(index + 1);
}

/** Destination for "add bookmark": current page and the top of the visible area. */
export function currentDestination(docId: string): { pageId: string; top: number | null } | null {
  const doc = getDoc(docId);
  const v = getViewer(docId);
  if (!doc || !v) return null;
  const index = doc.view.page - 1;
  const page = doc.pages[index];
  const pv = v.pdfViewer.getPageView(index);
  let top: number | null = null;
  if (pv?.div) {
    const c = v.container.getBoundingClientRect();
    const r = pv.div.getBoundingClientRect();
    const y = Math.max(0, c.top - r.top);
    const pt = pv.viewport.convertToPdfPoint(0, y) as number[];
    top = Math.round(pt[1]);
  }
  return { pageId: page.id, top };
}

// ----- tree helpers -----

export function mapTree(nodes: OutlineNode[], fn: (n: OutlineNode) => OutlineNode | null): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const n of nodes) {
    const m = fn(n);
    if (!m) continue;
    out.push({ ...m, children: mapTree(m.children, fn) });
  }
  return out;
}

export function findNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = findNode(n.children, id);
    if (c) return c;
  }
  return null;
}

export function removeNode(nodes: OutlineNode[], id: string): OutlineNode[] {
  return nodes.filter((n) => n.id !== id).map((n) => ({ ...n, children: removeNode(n.children, id) }));
}

export function insertNode(nodes: OutlineNode[], node: OutlineNode, targetId: string | null, where: "before" | "after" | "inside"): OutlineNode[] {
  if (!targetId) return [...nodes, node];
  const out: OutlineNode[] = [];
  for (const n of nodes) {
    if (n.id === targetId) {
      if (where === "before") out.push(node, n);
      else if (where === "after") out.push(n, node);
      else out.push({ ...n, children: [...n.children, node] });
    } else out.push({ ...n, children: insertNode(n.children, node, targetId, where) });
  }
  return out;
}

export function isDescendant(nodes: OutlineNode[], ancestorId: string, id: string): boolean {
  const a = findNode(nodes, ancestorId);
  return !!a && !!findNode(a.children, id);
}

export function setOutline(docId: string, outline: OutlineNode[]) {
  updateDoc(docId, { outline, outlineDirty: true, dirty: true });
}
