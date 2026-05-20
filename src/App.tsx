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

      {/* Main editing area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: transcript — primary editing surface */}
        <main className="flex-1 overflow-hidden border-r border-border">
          <TranscriptEditor />
        </main>

        {/* Right: video preview + playback controls */}
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-black">
          <VideoPreview />
        </aside>
      </div>

      {/* Bottom: full-width waveform / timeline */}
      <div className="h-[88px] shrink-0 border-t border-border bg-background">
        <Waveform />
      </div>

      <Toaster />
    </div>
  );
}
