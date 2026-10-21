/**
 * Parses human page-range strings like "1-3, 5, 8-", "odd", "even", "last",
 * "all" into sorted zero-based page indices. Throws on malformed input so
 * dialogs can show a validation message.
 */
export function parsePageRanges(input: string, pageCount: number, { allowEmpty = false } = {}): number[] {
  const text = input.trim().toLowerCase();
  if (!text || text === "all" || text === "*") {
    if (!text && allowEmpty) return [];
    return Array.from({ length: pageCount }, (_, i) => i);
  }
  const out = new Set<number>();
  for (const raw of text.split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    if (part === "odd" || part === "even") {
      for (let i = part === "odd" ? 0 : 1; i < pageCount; i += 2) out.add(i);
      continue;
    }
    const m = part.match(/^(\d+|last|end)?\s*(?:(-|–|to)\s*(\d+|last|end)?)?$/);
    if (!m || (!m[1] && !m[3])) throw new Error(`Invalid page range "${part}"`);
    const num = (s: string | undefined, fallback: number) =>
      s === undefined ? fallback : s === "last" || s === "end" ? pageCount : parseInt(s, 10);
    const start = num(m[1], 1);
    const end = m[2] ? num(m[3], pageCount) : start;
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new Error(`Page ${Math.max(start, end)} is out of range (1–${pageCount})`);
    }
    const [a, b] = start <= end ? [start, end] : [end, start];
    for (let p = a; p <= b; p++) out.add(p - 1);
  }
  if (!out.size && !allowEmpty) throw new Error("No pages selected");
  return [...out].sort((a, b) => a - b);
}

/** Formats zero-based indices into a compact human range string ("1-3, 5"). */
export function formatPageRanges(indices: number[]): string {
  const s = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i] + 1}-${s[j] + 1}` : `${s[i] + 1}`);
    i = j + 1;
  }
  return parts.join(", ");
}

export function validatePageRanges(input: string, pageCount: number): string | null {
  try {
    parsePageRanges(input, pageCount);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
