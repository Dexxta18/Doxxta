import { create } from "zustand";
import { getActiveDoc, getDoc, toast, useApp } from "../state/store";
import { getRuntime, getViewer } from "../state/runtime";
import { analyzePage, layoutText } from "../lib/textLayout";

/** Read Out Loud with the browser's speech synthesis, sentence by sentence. */

interface SpeechState {
  active: boolean;
  paused: boolean;
  /** Sentence being read. */
  text: string;
  /** 0-based page being read (document reading), or null for a selection. */
  page: number | null;
  rate: number;
  voice: string | null;
}

export const useSpeech = create<SpeechState>(() => ({ active: false, paused: false, text: "", page: null, rate: 1, voice: null }));

const synth = () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);

let sentences: string[] = [];
let index = 0;
/** Bumped on every start/stop so callbacks of cancelled utterances are ignored. */
let run = 0;
let source: { docId: string; page: number } | null = null;

function split(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const parts = Seg ? [...new Seg(undefined, { granularity: "sentence" }).segment(clean)].map((s) => s.segment.trim()) : clean.split(/(?<=[.!?])\s+/);
  // Long sentences are cut at commas or spaces: some engines stop after ~15 seconds of speech.
  const out: string[] = [];
  for (const p of parts.filter(Boolean)) {
    let rest = p;
    while (rest.length > 220) {
      const cut = Math.max(rest.lastIndexOf(", ", 220), rest.lastIndexOf(" ", 220));
      const at = cut > 80 ? cut + 1 : 220;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

export function voices(): SpeechSynthesisVoice[] {
  return synth()?.getVoices() ?? [];
}

function speakNext(my: number) {
  const s = synth();
  if (!s || my !== run) return;
  if (index >= sentences.length) {
    if (source) {
      void loadPage(source.docId, source.page + 1, my);
      return;
    }
    stopReading();
    return;
  }
  const text = sentences[index];
  const u = new SpeechSynthesisUtterance(text);
  const { rate, voice } = useSpeech.getState();
  u.rate = rate;
  const v = voice ? voices().find((x) => x.voiceURI === voice) : undefined;
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  }
  u.onend = () => {
    if (my !== run) return;
    index++;
    speakNext(my);
  };
  u.onerror = (e) => {
    if (my !== run || e.error === "interrupted" || e.error === "canceled") return;
    if (e.error !== "text-too-long" && e.error !== "invalid-argument") {
      // The speech engine itself failed (no voices, audio blocked…): stop instead of skipping through the document.
      stopReading();
      toast(e.error === "not-allowed" ? "The browser blocked speech. Click Read out loud again to start it." : "Read aloud isn't available — no speech voice could be used on this device.", "warning");
      return;
    }
    index++;
    speakNext(my);
  };
  useSpeech.setState({ text });
  s.speak(u);
}

async function loadPage(docId: string, page: number, my: number) {
  const rt = getRuntime(docId);
  const doc = getDoc(docId);
  if (!rt || !doc || page >= doc.pages.length) {
    stopReading();
    return;
  }
  source = { docId, page };
  useSpeech.setState({ page, text: "" });
  getViewer(docId)?.goToPage(page + 1);
  const text = layoutText(await analyzePage(rt.pdf, page));
  if (my !== run) return;
  sentences = split(text);
  index = 0;
  // Skip empty pages.
  if (!sentences.length) return loadPage(docId, page + 1, my);
  speakNext(my);
}

function begin(): number | null {
  const s = synth();
  if (!s) {
    toast("Read aloud isn't supported in this browser", "warning");
    return null;
  }
  s.cancel();
  run++;
  useSpeech.setState({ active: true, paused: false });
  useApp.setState({ speaking: true });
  return run;
}

/** Reads the active document aloud from its current page. */
export function readDocument(docId = getActiveDoc()?.id, page?: number) {
  const doc = getDoc(docId);
  if (!doc) return;
  const my = begin();
  if (my === null) return;
  void loadPage(doc.id, page ?? doc.view.page - 1, my);
}

/** Reads a piece of text (e.g. the current selection). */
export function speakText(text: string) {
  const my = begin();
  if (my === null) return;
  source = null;
  sentences = split(text);
  index = 0;
  useSpeech.setState({ page: null });
  speakNext(my);
}

export function toggleReadAloud() {
  if (useSpeech.getState().active) stopReading();
  else readDocument();
}

export function stopReading() {
  run++;
  synth()?.cancel();
  source = null;
  sentences = [];
  useSpeech.setState({ active: false, paused: false, text: "", page: null });
  useApp.setState({ speaking: false });
}

export function togglePause() {
  const s = synth();
  if (!s) return;
  const { paused } = useSpeech.getState();
  if (paused) s.resume();
  else s.pause();
  useSpeech.setState({ paused: !paused });
}

/** Jumps by whole sentences (or to the next/previous page at the edges). */
export function skip(delta: number) {
  const s = synth();
  if (!s || !useSpeech.getState().active) return;
  run++;
  const my = run;
  s.cancel();
  useSpeech.setState({ paused: false });
  const next = index + delta;
  if (next < 0 && source && source.page > 0) return void loadPage(source.docId, source.page - 1, my);
  index = Math.max(0, next);
  speakNext(my);
}

/** Applies a new rate or voice from the next sentence on. */
export function setSpeechOptions(patch: Partial<Pick<SpeechState, "rate" | "voice">>) {
  useSpeech.setState(patch);
  if (useSpeech.getState().active && !useSpeech.getState().paused) skip(0);
}
