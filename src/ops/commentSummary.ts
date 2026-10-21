import { PDFDocument, StandardFonts, rgb, type PDFFont } from "../lib/pdflib";
import { getDoc, toast, withBusy } from "../state/store";
import { getRuntime } from "../state/runtime";
import { annotLabel, isCommentKind, type Annotation } from "../annotations/types";
import { renderPageToCanvas } from "../lib/pdfjs";
import { canvasToBlob, formatDateTime, baseName } from "../lib/util";
import { hexToPdf } from "../lib/colors";
import { openGenerated } from "../core/document";
import { selectionRect } from "../annotations/geometry";

/** WinAnsi-safe text for the standard fonts. */
function safe(s: string, font: PDFFont): string {
  let out = "";
  for (const ch of s.replace(/\r/g, "")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === "\n" ? "\n" : "?";
    }
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(t, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = t;
    }
    lines.push(line);
  }
  return lines;
}

/** "Summarize comments": a report with each page's thumbnail and its numbered comments. */
export async function summarizeComments(docId: string) {
  const doc = getDoc(docId);
  const rt = getRuntime(docId);
  if (!doc || !rt) return;
  const comments = doc.annotations.filter(isCommentKind);
  if (!comments.length) {
    toast("There are no comments to summarize", "info");
    return;
  }
  await withBusy("Summarizing comments…", async (progress) => {
    const out = await PDFDocument.create();
    out.setTitle(`Comments on ${doc.name}`);
    const font = await out.embedFont(StandardFonts.Helvetica);
    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    const W = 612,
      H = 792,
      M = 48;
    let page = out.addPage([W, H]);
    let y = H - M;
    page.drawText(safe(`Summary of comments on ${doc.name}`, bold), { x: M, y: y - 16, size: 16, font: bold });
    y -= 36;
    page.drawText(`${comments.length} comments · generated ${formatDateTime(new Date())}`, { x: M, y, size: 9, font, color: rgb(0.4, 0.4, 0.45) });
    y -= 24;
    const pageIndex = new Map(doc.pages.map((p, i) => [p.id, i]));
    const byPage = new Map<number, Annotation[]>();
    for (const a of comments) {
      const i = pageIndex.get(a.pageId) ?? 0;
      byPage.set(i, [...(byPage.get(i) ?? []), a]);
    }
    const pages = [...byPage.keys()].sort((a, b) => a - b);
    let n = 0;
    for (const pi of pages) {
      progress(n / pages.length, `Page ${pi + 1}`);
      n++;
      const list = byPage.get(pi)!.sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
      // Thumbnail with numbered markers.
      const pdfPage = await rt.pdf.getPage(pi + 1);
      const thumbW = 180;
      const vp1 = pdfPage.getViewport({ scale: 1 });
      const scale = (thumbW * 2) / vp1.width;
      const canvas = await renderPageToCanvas(pdfPage, { scale });
      const g = canvas.getContext("2d")!;
      const vp = pdfPage.getViewport({ scale });
      list.forEach((a, k) => {
        const r = selectionRect(a);
        const [x, yy] = vp.convertToViewportPoint(r[0], r[3]);
        g.fillStyle = "#e5383b";
        g.beginPath();
        g.arc(x, yy, 13, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#fff";
        g.font = "bold 15px sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(String(k + 1), x, yy + 1);
      });
      const img = await out.embedJpg(new Uint8Array(await (await canvasToBlob(canvas, "image/jpeg", 0.85)).arrayBuffer()));
      const thumbH = (thumbW * canvas.height) / canvas.width;
      if (y - thumbH < M) {
        page = out.addPage([W, H]);
        y = H - M;
      }
      page.drawText(`Page ${doc.pages[pi].label ?? pi + 1}`, { x: M, y: y - 12, size: 12, font: bold });
      y -= 22;
      page.drawImage(img, { x: M, y: y - thumbH, width: thumbW, height: thumbH });
      page.drawRectangle({ x: M, y: y - thumbH, width: thumbW, height: thumbH, borderColor: rgb(0.8, 0.82, 0.86), borderWidth: 0.5 });
      let ty = y;
      const tx = M + thumbW + 18;
      const tw = W - M - tx;
      list.forEach((a, k) => {
        const [cr, cg, cb] = hexToPdf(a.kind === "freetext" ? a.textColor : a.color);
        const head = safe(`${k + 1}. ${annotLabel(a)} — ${a.author}, ${formatDateTime(a.modifiedAt)}${a.status !== "None" ? ` [${a.status}]` : ""}`, bold);
        const bodyText = [("markedText" in a && a.markedText ? `“${a.markedText}”` : ""), a.kind === "freetext" ? a.text : a.contents].filter(Boolean).join("\n");
        const body = wrap(safe(bodyText, font), font, 9.5, tw - 8);
        const replyLines = a.replies.flatMap((r) => wrap(safe(`Reply from ${r.author}: ${r.contents}`, font), font, 9, tw - 16));
        const needed = 14 + body.length * 12 + replyLines.length * 11 + 8;
        if (ty - needed < M) {
          page = out.addPage([W, H]);
          ty = H - M;
          y = ty + thumbH + 22; // continue list on the new page without the thumbnail
        }
        page.drawRectangle({ x: tx, y: ty - 10, width: 4, height: 10, color: rgb(cr, cg, cb) });
        page.drawText(head, { x: tx + 8, y: ty - 9, size: 9.5, font: bold, color: rgb(0.12, 0.14, 0.2) });
        ty -= 15;
        for (const l of body) {
          page.drawText(l, { x: tx + 8, y: ty - 9, size: 9.5, font, color: rgb(0.2, 0.22, 0.28) });
          ty -= 12;
        }
        for (const l of replyLines) {
          page.drawText(l, { x: tx + 16, y: ty - 9, size: 9, font, color: rgb(0.35, 0.37, 0.45) });
          ty -= 11;
        }
        ty -= 8;
      });
      y = Math.min(y - thumbH, ty) - 20;
    }
    const bytes = await out.save();
    await openGenerated(bytes, `${baseName(doc.name)} - comment summary.pdf`);
  });
}
