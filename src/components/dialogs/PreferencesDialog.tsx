import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Checkbox, Field, Segmented, Select, Slider, Tabs, TextInput } from "../ui/Fields";
import type { DialogProps } from "./DialogHost";
import { useSettings, type AppTheme, type PageTheme } from "../../state/settings";
import { clearRecent } from "../../lib/recent";
import { toast } from "../../state/store";

type Tab = "general" | "comments" | "accessibility";

export default function PreferencesDialog({ close }: DialogProps) {
  const s = useSettings();
  const [tab, setTab] = useState<Tab>("general");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  return (
    <Dialog title="Preferences" icon={<Settings size={18} />} onClose={close} width={560} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "general", label: "General" },
          { value: "comments", label: "Commenting" },
          { value: "accessibility", label: "Accessibility" },
        ]}
      />
      {tab === "general" && (
        <>
          <Field label="App theme">
            <Segmented<AppTheme>
              value={s.theme}
              onChange={(v) => s.set({ theme: v })}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "System" },
              ]}
            />
          </Field>
          <Field label="Default zoom for new documents">
            <Select
              value={s.defaultZoom}
              onChange={(e) => s.set({ defaultZoom: e.target.value })}
              options={[
                { value: "auto", label: "Automatic" },
                { value: "page-fit", label: "Fit page" },
                { value: "page-width", label: "Fit width" },
                { value: "page-actual", label: "Actual size" },
                { value: "0.75", label: "75%" },
                { value: "1", label: "100%" },
                { value: "1.25", label: "125%" },
                { value: "1.5", label: "150%" },
              ]}
            />
          </Field>
          <Checkbox checked={s.restoreLastView} onChange={(v) => s.set({ restoreLastView: v })} label="Reopen documents at the last viewed page" />
          <Checkbox checked={s.showTextSelectionMenu} onChange={(v) => s.set({ showTextSelectionMenu: v })} label="Show quick actions when text is selected" />
          <div className="row">
            <Button
              variant="ghost"
              onClick={async () => {
                await clearRecent();
                toast("Recent files cleared", "success");
              }}
            >
              Clear recent files
            </Button>
          </div>
        </>
      )}
      {tab === "comments" && (
        <>
          <Field label="Author name" hint="Shown on your comments, replies and dynamic stamps.">
            <TextInput value={s.author} placeholder="Your name" onChange={(e) => s.set({ author: e.target.value })} />
          </Field>
          <Checkbox checked={s.smoothInk} onChange={(v) => s.set({ smoothInk: v })} label="Smooth freehand drawings" />
          <Checkbox checked={s.dynamicStampUser} onChange={(v) => s.set({ dynamicStampUser: v })} label="Include my name on dynamic stamps" />
          <div className="row">
            <Button variant="ghost" onClick={() => s.set({ toolStyles: {} })}>
              Reset tool colors and styles
            </Button>
          </div>
        </>
      )}
      {tab === "accessibility" && (
        <>
          <Field label="Page colors">
            <Segmented<PageTheme>
              value={s.pageTheme}
              onChange={(v) => s.set({ pageTheme: v })}
              options={[
                { value: "normal", label: "Original" },
                { value: "night", label: "Night" },
                { value: "sepia", label: "Sepia" },
                { value: "contrast", label: "High contrast" },
              ]}
            />
          </Field>
          <Field label="Read out loud voice">
            <Select
              value={s.speechVoice}
              onChange={(e) => s.set({ speechVoice: e.target.value })}
              options={[{ value: "", label: "System default" }, ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))]}
            />
          </Field>
          <Field label="Speaking rate">
            <Slider value={s.speechRate} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => s.set({ speechRate: v })} />
          </Field>
        </>
      )}
    </Dialog>
  );
}
