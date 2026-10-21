import { CipherTransformFactory, PDF17, PDF20, encodeRevision6Password } from "pdf-lib-crypto";
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, type PDFObject } from "./pdflib";

/**
 * Standard security handler helpers that pdf-lib lacks: encrypting strings,
 * keeping a document's original encryption (so its owner password keeps
 * working) and checking a permissions (owner) password.
 */

/** Padding string of the standard security handler (ISO 32000-1, 7.6.3.3). */
const PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
const numOf = (o: PDFObject | undefined, fallback = 0) => (o instanceof PDFNumber ? o.asNumber() : fallback);
const bytesOf = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.asBytes() : new Uint8Array());

interface ParsedEncryption {
  dict: PDFDict;
  id0: Uint8Array;
  id1: Uint8Array;
  V: number;
  R: number;
  keyBits: number;
}

/** Reads the encryption dictionary and file ID of an encrypted file without decrypting it. */
async function parseEncryption(bytes: Uint8Array): Promise<ParsedEncryption | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return null;
  }
  const ctx = doc.context;
  const enc = ctx.lookup(ctx.trailerInfo.Encrypt);
  const ids = ctx.lookup(ctx.trailerInfo.ID);
  if (!(enc instanceof PDFDict)) return null;
  // Resolve indirect values so the dictionary can be copied into another document.
  const resolve = (o: PDFObject): PDFObject => {
    const v = o instanceof PDFRef ? ctx.lookup(o) : o;
    if (v instanceof PDFDict) {
      const d = PDFDict.withContext(ctx);
      for (const [k, x] of v.entries()) d.set(k, resolve(x));
      return d;
    }
    if (v instanceof PDFArray) {
      const a = PDFArray.withContext(ctx);
      for (let i = 0; i < v.size(); i++) a.push(resolve(v.get(i)));
      return a;
    }
    return v ?? PDFName.of("Null");
  };
  const dict = resolve(enc) as PDFDict;
  const idArr = ids instanceof PDFArray ? ids : null;
  const id0 = bytesOf(idArr ? ctx.lookup(idArr.get(0)) : undefined);
  const V = numOf(dict.get(PDFName.of("V")));
  const R = numOf(dict.get(PDFName.of("R")));
  const keyBits = V === 5 ? 256 : numOf(dict.get(PDFName.of("Length")), V === 1 ? 40 : 128);
  return { dict, id0, id1: bytesOf(idArr ? ctx.lookup(idArr.get(1)) : undefined), V, R, keyBits };
}

/** Whether pdf-lib's writer can reproduce this encryption exactly. */
function canReproduce(e: ParsedEncryption): boolean {
  const d = e.dict;
  if (d.get(PDFName.of("Filter")) !== PDFName.of("Standard")) return false;
  if (![1, 2, 4, 5].includes(e.V)) return false;
  const em = d.get(PDFName.of("EncryptMetadata"));
  if (em instanceof PDFBool && !em.asBoolean()) return false;
  if (e.V >= 4) {
    const cf = d.get(PDFName.of("CF"));
    const std = cf instanceof PDFDict ? cf.get(PDFName.of("StdCF")) : undefined;
    const cfm = std instanceof PDFDict ? std.get(PDFName.of("CFM")) : undefined;
    if (cfm !== PDFName.of(e.V === 5 ? "AESV3" : "AESV2")) return false;
    for (const k of ["StmF", "StrF"]) if (d.get(PDFName.of(k)) !== PDFName.of("StdCF")) return false;
    const eff = d.get(PDFName.of("EFF"));
    if (eff && eff !== PDFName.of("StdCF")) return false;
  }
  return e.id0.length > 0;
}

/**
 * Encrypts `doc` with the encryption of `originalBytes` (same file key, owner
 * and user passwords, permissions). Returns false when that isn't possible —
 * then the caller encrypts afresh.
 */
export async function keepOriginalEncryption(doc: PDFDocument, originalBytes: Uint8Array, password: string): Promise<boolean> {
  const e = await parseEncryption(originalBytes);
  if (!e || !canReproduce(e)) return false;
  let key: Uint8Array;
  try {
    // (pdf-lib's typings come from its CommonJS build; the objects are the same at runtime.)
    key = new CipherTransformFactory(e.dict as never, e.id0, password).encryptionKey;
  } catch {
    return false;
  }
  // Let pdf-lib set up its security handler, then swap in the original key and dictionary.
  doc.encrypt({ userPassword: "x", ownerPassword: "y", algorithm: e.V === 5 ? "AES-256" : e.V === 4 ? "AES-128" : "RC4-128", allowWeakCryptography: true });
  const sec = doc.context.security as unknown as { encryptionKey: Uint8Array; keyBits: number; encryption: { V: number } };
  sec.encryptionKey = key;
  sec.keyBits = e.keyBits;
  sec.encryption = { ...sec.encryption, V: e.V };
  const ctx = doc.context;
  const generated = ctx.trailerInfo.Encrypt;
  const copy = (o: PDFObject): PDFObject => {
    if (o instanceof PDFDict) {
      const d = ctx.obj({});
      for (const [k, v] of o.entries()) d.set(k, copy(v));
      return d;
    }
    if (o instanceof PDFArray) {
      const a = ctx.obj([]);
      for (let i = 0; i < o.size(); i++) a.push(copy(o.get(i)));
      return a;
    }
    return o;
  };
  ctx.trailerInfo.Encrypt = ctx.register(copy(e.dict));
  if (generated instanceof PDFRef) ctx.delete(generated);
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(hex(e.id0)), PDFHexString.of(hex(e.id1.length ? e.id1 : e.id0))]);
  return true;
}

/** The key-derivation methods of pdf-lib's decryptor, used without a full instance. */
interface KeyHelper {
  defaultPasswordBytes: Uint8Array;
  decodeUserPassword(password: Uint8Array, ownerPassword: Uint8Array, revision: number, keyLength: number): Uint8Array;
  prepareKeyData(fileId: Uint8Array, password: Uint8Array | undefined, ownerPassword: Uint8Array, userPassword: Uint8Array, flags: number, revision: number, keyLength: number, encryptMetadata: boolean): Uint8Array | null;
}

/** Checks whether `password` is the owner (permissions) password of an encrypted file. */
export async function isOwnerPassword(bytes: Uint8Array, password: string): Promise<boolean> {
  if (!password) return false;
  const e = await parseEncryption(bytes);
  if (!e) return false;
  const O = bytesOf(e.dict.get(PDFName.of("O")));
  const U = bytesOf(e.dict.get(PDFName.of("U")));
  if (e.R >= 5) {
    const pw = e.R === 6 ? encodeRevision6Password(password) : latin1(password).subarray(0, 127);
    const algorithm = e.R === 6 ? new PDF20() : new PDF17();
    return algorithm.checkOwnerPassword(pw, O.subarray(32, 40), U.subarray(0, 48), O.subarray(0, 32));
  }
  // Algorithm 7: recover the user password from /O, then validate it (Algorithm 6).
  const helper = Object.create(CipherTransformFactory.prototype) as KeyHelper;
  helper.defaultPasswordBytes = PADDING;
  const em = e.dict.get(PDFName.of("EncryptMetadata"));
  const encryptMetadata = !(em instanceof PDFBool && !em.asBoolean());
  const userPassword = helper.decodeUserPassword(latin1(password), O.subarray(0, 32), e.R, e.keyBits);
  return !!helper.prepareKeyData(e.id0, userPassword, O.subarray(0, 32), U.subarray(0, 32), numOf(e.dict.get(PDFName.of("P"))), e.R, e.keyBits, (e.V === 4 || e.V === 5) && encryptMetadata);
}

/**
 * pdf-lib encrypts stream data only; strings must be encrypted too or other
 * readers show them garbled. Run right before saving without object streams.
 */
export function encryptStrings(doc: PDFDocument) {
  const ctx = doc.context;
  const security = ctx.security;
  if (!security) return;
  const encryptRef = ctx.trailerInfo.Encrypt;
  const objects = ctx.enumerateIndirectObjects().filter(([ref]) => !(encryptRef instanceof PDFRef && ref === encryptRef));

  // A direct dictionary or array shared by two objects would be encrypted with
  // two keys; give each owner its own copy first.
  const owner = new Map<PDFObject, PDFRef>();
  const clone = (o: PDFObject): PDFObject => {
    if (o instanceof PDFDict) {
      const d = ctx.obj({});
      for (const [k, v] of o.entries()) d.set(k, clone(v));
      return d;
    }
    if (o instanceof PDFArray) {
      const a = ctx.obj([]);
      for (let i = 0; i < o.size(); i++) a.push(clone(o.get(i)));
      return a;
    }
    return o;
  };
  const claim = (o: PDFDict | PDFArray, ref: PDFRef) => {
    const visit = (v: PDFObject): PDFObject => {
      if (!(v instanceof PDFDict || v instanceof PDFArray) || v instanceof PDFStream) return v;
      const prev = owner.get(v);
      const mine = prev && prev !== ref ? (clone(v) as PDFDict | PDFArray) : v;
      owner.set(mine, ref);
      if (!prev || prev !== ref) claim(mine, ref);
      return mine;
    };
    if (o instanceof PDFDict) for (const [k, v] of o.entries()) o.set(k, visit(v));
    else for (let i = 0; i < o.size(); i++) o.set(i, visit(o.get(i)));
  };
  for (const [ref, obj] of objects) {
    const root = obj instanceof PDFStream ? obj.dict : obj;
    if (root instanceof PDFDict || root instanceof PDFArray) {
      owner.set(root, ref);
      claim(root, ref);
    }
  }

  for (const [ref, obj] of objects) {
    const fn = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    const enc = (s: PDFString | PDFHexString) => PDFHexString.of(hex(fn(s.asBytes())));
    const walk = (o: PDFDict | PDFArray) => {
      if (o instanceof PDFDict) {
        // Signature values are never encrypted.
        const isSig = o.get(PDFName.of("Type")) === PDFName.of("Sig");
        for (const [k, v] of o.entries()) {
          if (isSig && k === PDFName.of("Contents")) continue;
          if (v instanceof PDFString || v instanceof PDFHexString) o.set(k, enc(v));
          else if (v instanceof PDFDict || v instanceof PDFArray) walk(v);
        }
      } else {
        for (let i = 0; i < o.size(); i++) {
          const v = o.get(i);
          if (v instanceof PDFString || v instanceof PDFHexString) o.set(i, enc(v));
          else if (v instanceof PDFDict || v instanceof PDFArray) walk(v);
        }
      }
    };
    if (obj instanceof PDFStream) walk(obj.dict);
    else if (obj instanceof PDFDict || obj instanceof PDFArray) walk(obj);
    else if (obj instanceof PDFString || obj instanceof PDFHexString) ctx.assign(ref, enc(obj));
  }
}

/** Saves `doc`, finishing encryption when a security handler is set. */
export async function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  if (!doc.context.security) return doc.save({ useObjectStreams: true });
  encryptStrings(doc);
  // Strings inside object streams must not be encrypted separately, so write every object on its own.
  return doc.save({ useObjectStreams: false });
}
