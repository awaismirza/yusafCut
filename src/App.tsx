import { useEffect } from "react";
import { Toolbar } from "@/components/Toolbar/Toolbar";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { VideoPreview } from "@/components/VideoPreview/VideoPreview";
import { Waveform } from "@/components/Waveform/Waveform";
import { Toaster } from "@/components/ui/toaster";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useTranscribeProgress } from "@/hooks/useTranscribeProgress";
import { useProjectStore } from "@/stores/projectStore";

export default function App() {
  useKeyboardShortcuts();
  useAutoSave();
  useTranscribeProgress();

  // True once there are actual transcribed words (not just an empty placeholder segment).
  const hasTranscript = useProjectStore((s) =>
    s.project.segments.some((seg) => seg.words.length > 0),
  );
  const hasMedia = useProjectStore((s) => Object.keys(s.project.media).length > 0);

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

      {hasTranscript ? (
        // ── Editor layout: transcript + video side-by-side ──────────────────
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-hidden border-r border-border">
            <TranscriptEditor />
          </main>
          <aside className="flex h-full w-[360px] shrink-0 flex-col bg-black">
            <VideoPreview />
          </aside>
        </div>
      ) : (
        // ── Pre-transcript: video centred, large ─────────────────────────────
        <main className="flex flex-1 flex-col items-center justify-center overflow-hidden gap-4 px-8">
          <div
            className="w-full max-w-[760px] overflow-hidden rounded-xl shadow-[0_8px_48px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.07]"
            style={{ height: "min(500px, 62vh)" }}
          >
            <VideoPreview />
          </div>

          <p className="text-sm text-muted-foreground/70">
            {hasMedia ? (
              <>
                Click{" "}
                <span className="font-semibold text-foreground/80">Transcribe</span>{" "}
                in the toolbar to generate a transcript and start editing
              </>
            ) : (
              "Open a video file using the toolbar above to get started"
            )}
          </p>
        </main>
      )}

      {/* Full-width waveform — only when media is loaded */}
      {hasMedia && (
        <div className="h-[88px] shrink-0 border-t border-border bg-background">
          <Waveform />
        </div>
      )}

      <Toaster />
    </div>
  );
}
