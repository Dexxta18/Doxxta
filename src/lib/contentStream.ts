/**
 * Parser and writer for PDF content streams (ISO 32000-1, 7.8.2): a flat list
 * of operators with their operands. Inline images are kept as raw bytes.
 */

export class PName {
  constructor(public readonly name: string) {}
}

export class PString {
  constructor(public readonly bytes: Uint8Array) {}
}

export class PDict {
  constructor(public readonly map: Map<string, Operand>) {}
  get(key: string): Operand | undefined {
    return this.map.get(key);
  }
}

export type Operand = number | boolean | null | PName | PString | PDict | Operand[];

export interface Op {
  op: string;
  args: Operand[];
  /** For "BI": the image dictionary and its raw data. */
  inline?: { dict: PDict; data: Uint8Array };
}

const WS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;

const isRegular = (c: number) => !WS[c] && !DELIM[c];

class Lexer {
  pos = 0;
  constructor(private readonly s: Uint8Array) {}

  skipSpace() {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (WS[c]) this.pos++;
      else if (c === 0x25 /* % */) {
        while (this.pos < s.length && s[this.pos] !== 0x0a && s[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  /** Next token: an operand, an operator name (string), or a structural marker. */
  next(): { kind: "operand"; value: Operand } | { kind: "op"; value: string } | { kind: "open" | "close" | "dictOpen" | "dictClose" } | null {
    this.skipSpace();
    const s = this.s;
    if (this.pos >= s.length) return null;
    const c = s[this.pos];
    if (c === 0x2f /* / */) return { kind: "operand", value: this.name() };
    if (c === 0x28 /* ( */) return { kind: "operand", value: this.literal() };
    if (c === 0x3c /* < */) {
      if (s[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { kind: "dictOpen" };
      }
      return { kind: "operand", value: this.hex() };
    }
    if (c === 0x3e /* > */) {
      this.pos += s[this.pos + 1] === 0x3e ? 2 : 1;
      return { kind: "dictClose" };
    }
    if (c === 0x5b /* [ */) {
      this.pos++;
      return { kind: "open" };
    }
    if (c === 0x5d /* ] */) {
      this.pos++;
      return { kind: "close" };
    }
    if (c === 0x7b || c === 0x7d || c === 0x29) {
      // Stray braces or parentheses: skip them.
      this.pos++;
      return this.next();
    }
    const start = this.pos;
    while (this.pos < s.length && isRegular(s[this.pos])) this.pos++;
    const word = latin1(s, start, this.pos);
    if (/^[+\-.\d]+$/.test(word) && /\d/.test(word)) {
      // Lenient like other readers: "--5" is -5, "1.2.3" is 1.2.
      const m = /[+-]?(\d+\.?\d*|\.\d+)/.exec(word.replace(/^[+-]+(?=[+-])/, ""));
      const n = m ? parseFloat(m[0]) : 0;
      return { kind: "operand", value: Number.isFinite(n) ? n : 0 };
    }
    if (word === "true") return { kind: "operand", value: true };
    if (word === "false") return { kind: "operand", value: false };
    if (word === "null") return { kind: "operand", value: null };
    return { kind: "op", value: word };
  }

  private name(): PName {
    const s = this.s;
    this.pos++;
    const out: number[] = [];
    while (this.pos < s.length && isRegular(s[this.pos])) {
      const c = s[this.pos];
      if (c === 0x23 /* # */ && this.pos + 2 < s.length) {
        const h = parseInt(latin1(s, this.pos + 1, this.pos + 3), 16);
        if (!Number.isNaN(h)) {
          out.push(h);
          this.pos += 3;
          continue;
        }
      }
      out.push(c);
      this.pos++;
    }
    return new PName(String.fromCharCode(...out));
  }

  private literal(): PString {
    const s = this.s;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < s.length) {
      const c = s[this.pos++];
      if (c === 0x5c /* \ */) {
        const e = s[this.pos++];
        switch (e) {
          case 0x6e:
            out.push(0x0a);
            break;
          case 0x72:
            out.push(0x0d);
            break;
          case 0x74:
            out.push(0x09);
            break;
          case 0x62:
            out.push(0x08);
            break;
          case 0x66:
            out.push(0x0c);
            break;
          case 0x0d:
            if (s[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a:
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30;
              for (let k = 0; k < 2 && s[this.pos] >= 0x30 && s[this.pos] <= 0x37; k++) v = v * 8 + (s[this.pos++] - 0x30);
              out.push(v & 0xff);
            } else if (e !== undefined) out.push(e);
        }
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return new PString(Uint8Array.from(out));
  }

  private hex(): PString {
    const s = this.s;
    this.pos++;
    const digits: number[] = [];
    while (this.pos < s.length && s[this.pos] !== 0x3e) {
      const c = s[this.pos++];
      const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
      if (v >= 0) digits.push(v);
    }
    this.pos++;
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
    return new PString(out);
  }

  /** Raw data of an inline image, right after the ID operator. */
  inlineData(dict: PDict): Uint8Array {
    const s = this.s;
    // A single white-space character follows ID.
    if (WS[s[this.pos]]) this.pos++;
    const start = this.pos;
    const len = dict.get("L") ?? dict.get("Length");
    if (typeof len === "number" && len >= 0 && start + len <= s.length) {
      this.pos = start + len;
      this.skipEI();
      return s.subarray(start, start + len);
    }
    // Find "EI" between white space (or the end of the stream).
    for (let i = start; i < s.length - 1; i++) {
      if (s[i] === 0x45 && s[i + 1] === 0x49 && (i === start || WS[s[i - 1]]) && (i + 2 >= s.length || WS[s[i + 2]] || DELIM[s[i + 2]])) {
        let end = i;
        if (end > start && WS[s[end - 1]]) end--;
        this.pos = i + 2;
        return s.subarray(start, end);
      }
    }
    this.pos = s.length;
    return s.subarray(start);
  }

  private skipEI() {
    this.skipSpace();
    if (this.s[this.pos] === 0x45 && this.s[this.pos + 1] === 0x49) this.pos += 2;
  }
}

function latin1(s: Uint8Array, a: number, b: number): string {
  let out = "";
  for (let i = a; i < b; i++) out += String.fromCharCode(s[i]);
  return out;
}

/** Parses a (decoded) content stream into operators. */
export function parseContent(bytes: Uint8Array): Op[] {
  const lx = new Lexer(bytes);
  const ops: Op[] = [];
  let args: Operand[] = [];
  const stack: (Operand[] | { dict: Operand[] })[] = [];
  const push = (v: Operand) => {
    const top = stack[stack.length - 1];
    if (!top) args.push(v);
    else if (Array.isArray(top)) top.push(v);
    else top.dict.push(v);
  };
  const toDict = (items: Operand[]) => {
    const map = new Map<string, Operand>();
    for (let i = 0; i + 1 < items.length; i += 2) {
      const k = items[i];
      if (k instanceof PName) map.set(k.name, items[i + 1]);
    }
    return new PDict(map);
  };
  for (;;) {
    const t = lx.next();
    if (!t) break;
    switch (t.kind) {
      case "operand":
        push(t.value);
        break;
      case "open":
        stack.push([]);
        break;
      case "close": {
        const top = stack.pop();
        if (Array.isArray(top)) push(top);
        break;
      }
      case "dictOpen":
        stack.push({ dict: [] });
        break;
      case "dictClose": {
        const top = stack.pop();
        if (top && !Array.isArray(top)) push(toDict(top.dict));
        break;
      }
      case "op": {
        if (stack.length) {
          // An operator inside an array: malformed; close the open containers.
          while (stack.length) {
            const top = stack.pop()!;
            push(Array.isArray(top) ? top : toDict(top.dict));
          }
        }
        if (t.value === "BI") {
          // Key/value pairs up to ID, then binary data up to EI.
          const items: Operand[] = [];
          for (;;) {
            const k = lx.next();
            if (!k || (k.kind === "op" && k.value === "ID")) break;
            if (k.kind === "operand") items.push(k.value);
            else if (k.kind === "open") {
              const arr: Operand[] = [];
              for (let a = lx.next(); a && a.kind !== "close"; a = lx.next()) if (a.kind === "operand") arr.push(a.value);
              items.push(arr);
            } else if (k.kind === "op") items.push(new PName(k.value));
          }
          const dict = toDict(items);
          ops.push({ op: "BI", args: [], inline: { dict, data: lx.inlineData(dict) } });
        } else {
          ops.push({ op: t.value, args });
        }
        args = [];
        break;
      }
    }
  }
  return ops;
}

// ---------------- Writing ----------------

const HEX = "0123456789abcdef";

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function writeName(n: string): string {
  let out = "/";
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    out += c < 0x21 || c > 0x7e || c === 0x23 || DELIM[c] ? `#${HEX[c >> 4]}${HEX[c & 15]}` : n[i];
  }
  return out;
}

function writeOperand(v: Operand): string {
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null) return "null";
  if (v instanceof PName) return writeName(v.name);
  if (v instanceof PString) {
    let h = "<";
    for (const b of v.bytes) h += HEX[b >> 4] + HEX[b & 15];
    return h + ">";
  }
  if (v instanceof PDict) {
    let out = "<<";
    for (const [k, x] of v.map) out += `${writeName(k)} ${writeOperand(x)} `;
    return out + ">>";
  }
  return `[${v.map(writeOperand).join(" ")}]`;
}

/** Serializes operators back into content stream bytes. */
export function serializeContent(ops: Op[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let text = "";
  const flush = () => {
    if (text) chunks.push(Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff));
    text = "";
  };
  for (const o of ops) {
    if (o.op === "BI" && o.inline) {
      text += "BI";
      for (const [k, x] of o.inline.dict.map) text += ` ${writeName(k)} ${writeOperand(x)}`;
      text += " ID ";
      flush();
      chunks.push(o.inline.data);
      text += "\nEI\n";
      continue;
    }
    for (const a of o.args) text += writeOperand(a) + " ";
    text += o.op + "\n";
    if (text.length > 1 << 16) flush();
  }
  flush();
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
