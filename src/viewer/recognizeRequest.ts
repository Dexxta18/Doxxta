/**
 * Asks Edit text to recognize the text in a page's pictures (the "Recognize text" command): the
 * page's Edit text layer takes the request now, or when it opens.
 */
let pending: { docId: string; pageIndex: number } | null = null;
const listeners = new Set<() => void>();

export function requestRecognition(docId: string, pageIndex: number) {
  pending = { docId, pageIndex };
  for (const l of listeners) l();
}

/** Whether recognition was asked for this page (the request is then taken). */
export function takeRecognition(docId: string, pageIndex: number): boolean {
  if (pending?.docId !== docId || pending.pageIndex !== pageIndex) return false;
  pending = null;
  return true;
}

export function onRecognitionRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
