// STUB_MODULE
import type { Annotation } from "./types";
export async function importAnnotations(bytes: Uint8Array, _password?: string): Promise<{ bytes: Uint8Array; changed: boolean; annotations: { pageIndex: number; annot: Annotation }[]; skipped: number }> {
  return { bytes, changed: false, annotations: [], skipped: 0 };
}
