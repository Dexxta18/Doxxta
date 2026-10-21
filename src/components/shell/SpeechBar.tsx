import { useEffect, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, Square, Volume2 } from "lucide-react";
import { setSpeechOptions, skip, stopReading, togglePause, useSpeech, voices } from "../../ops/speech";

/** Floating controls while a document or selection is read aloud. */
export default function SpeechBar() {
  const { active, paused, text, page, rate, voice } = useSpeech();
  const [list, setList] = useState<SpeechSynthesisVoice[]>(() => voices());
  useEffect(() => {
    const update = () => setList(voices());
    window.speechSynthesis?.addEventListener?.("voiceschanged", update);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", update);
  }, []);
  if (!active) return null;
  return (
    <div className="speech-bar" role="region" aria-label="Read aloud">
      <Volume2 size={15} className="faint" />
      <span className="speech-text" title={text}>
        {page !== null && <span className="faint">p. {page + 1} · </span>}
        {text || "…"}
      </span>
      <button className="icon-btn icon-btn-sm" aria-label="Previous sentence" data-tip="Previous sentence" onClick={() => skip(-1)}>
        <SkipBack size={15} />
      </button>
      <button className="icon-btn icon-btn-sm" aria-label={paused ? "Resume" : "Pause"} data-tip={paused ? "Resume" : "Pause"} onClick={togglePause}>
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </button>
      <button className="icon-btn icon-btn-sm" aria-label="Next sentence" data-tip="Next sentence" onClick={() => skip(1)}>
        <SkipForward size={15} />
      </button>
      <select className="input select speech-select" aria-label="Speed" value={rate} onChange={(e) => setSpeechOptions({ rate: Number(e.target.value) })}>
        {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
      {list.length > 1 && (
        <select className="input select speech-select speech-voice" aria-label="Voice" value={voice ?? ""} onChange={(e) => setSpeechOptions({ voice: e.target.value || null })}>
          <option value="">Default voice</option>
          {list.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      <button className="icon-btn icon-btn-sm" aria-label="Stop" data-tip="Stop" onClick={stopReading}>
        <Square size={14} />
      </button>
    </div>
  );
}
