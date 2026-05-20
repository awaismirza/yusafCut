import { useEffect } from "react";
import { Toolbar } from "@/components/Toolbar/Toolbar";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { VideoPreview } from "@/components/VideoPreview/VideoPreview";
import { Waveform } from "@/components/Waveform/Waveform";
import { Toaster } from "@/components/ui/toaster";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useTranscribeProgress } from "@/hooks/useTranscribeProgress";

export default function App() {
  useKeyboardShortcuts();
  useAutoSave();
  useTranscribeProgress();

  // Follow system dark mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Toolbar />
      <main className="grid flex-1 grid-cols-[1fr_420px] grid-rows-[1fr_120px] gap-0 overflow-hidden">
        <section className="row-span-2 overflow-y-auto border-r border-border">
          <TranscriptEditor />
        </section>
        <section className="overflow-hidden border-b border-border">
          <VideoPreview />
        </section>
        <section className="overflow-hidden">
          <Waveform />
        </section>
      </main>
      <Toaster />
    </div>
  );
}
