import { textWidth } from "../lib/fontMetrics";

export interface StampDef {
  name: string;
  label: string;
  color: string;
  group: "Standard" | "Sign Here" | "Dynamic";
  dynamic?: boolean;
}

export const STAMPS: StampDef[] = [
  { name: "Approved", label: "APPROVED", color: "#1e8a4c", group: "Standard" },
  { name: "NotApproved", label: "NOT APPROVED", color: "#c62828", group: "Standard" },
  { name: "Draft", label: "DRAFT", color: "#2f5bea", group: "Standard" },
  { name: "Final", label: "FINAL", color: "#1e8a4c", group: "Standard" },
  { name: "Completed", label: "COMPLETED", color: "#1e8a4c", group: "Standard" },
  { name: "Confidential", label: "CONFIDENTIAL", color: "#c62828", group: "Standard" },
  { name: "ForPublicRelease", label: "FOR PUBLIC RELEASE", color: "#1e8a4c", group: "Standard" },
  { name: "NotForPublicRelease", label: "NOT FOR PUBLIC RELEASE", color: "#c62828", group: "Standard" },
  { name: "ForComment", label: "FOR COMMENT", color: "#2f5bea", group: "Standard" },
  { name: "Void", label: "VOID", color: "#c62828", group: "Standard" },
  { name: "PreliminaryResults", label: "PRELIMINARY RESULTS", color: "#2f5bea", group: "Standard" },
  { name: "InformationOnly", label: "INFORMATION ONLY", color: "#2f5bea", group: "Standard" },
  { name: "Expired", label: "EXPIRED", color: "#c62828", group: "Standard" },
  { name: "SignHere", label: "SIGN HERE", color: "#d35400", group: "Sign Here" },
  { name: "InitialHere", label: "INITIAL HERE", color: "#d35400", group: "Sign Here" },
  { name: "Witness", label: "WITNESS", color: "#d35400", group: "Sign Here" },
  { name: "Accepted", label: "ACCEPTED", color: "#1e8a4c", group: "Sign Here" },
  { name: "Rejected", label: "REJECTED", color: "#c62828", group: "Sign Here" },
  { name: "DApproved", label: "APPROVED", color: "#1e8a4c", group: "Dynamic", dynamic: true },
  { name: "DReviewed", label: "REVIEWED", color: "#2f5bea", group: "Dynamic", dynamic: true },
  { name: "DReceived", label: "RECEIVED", color: "#2f5bea", group: "Dynamic", dynamic: true },
  { name: "DRevised", label: "REVISED", color: "#d35400", group: "Dynamic", dynamic: true },
  { name: "DConfidential", label: "CONFIDENTIAL", color: "#c62828", group: "Dynamic", dynamic: true },
];

export const stampByName = (name: string) => STAMPS.find((s) => s.name === name);

export const STAMP_FONT = "Helvetica-Bold";
export const STAMP_SUB_FONT = "Helvetica-Bold";

/**
 * Natural layout of a stamp in points: the label is set at `size`, the
 * optional sublabel at 40% of that. Shared by the SVG and PDF renderers.
 */
export function stampLayout(label: string, sublabel: string | undefined, size = 22) {
  const pad = size * 0.45;
  const subSize = size * 0.4;
  const labelW = textWidth(label, STAMP_FONT, size);
  const subW = sublabel ? textWidth(sublabel, STAMP_SUB_FONT, subSize) : 0;
  const width = Math.max(labelW, subW) + pad * 2;
  const height = size * 0.95 + (sublabel ? subSize * 1.35 : 0) + pad * 1.3;
  return { width, height, size, subSize, pad, labelW, subW };
}

export function dynamicSublabel(author: string, date = new Date()): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return author ? `By ${author} at ${time}, ${day}` : `${time}, ${day}`;
}
