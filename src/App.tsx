import { useEffect, useRef, useState } from "react";
import { Toolbar } from "@/components/Toolbar/Toolbar";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { VideoPreview } from "@/components/VideoPreview/VideoPreview";
import { Waveform } from "@/components/Waveform/Waveform";
import { StatusBar } from "@/components/StatusBar/StatusBar";
import { Toolbox } from "@/components/Toolbox/Toolbox";
import { Toaster } from "@/components/ui/toaster";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useTranscribeProgress } from "@/hooks/useTranscribeProgress";
import { useProjectStore } from "@/stores/projectStore";

// Resizable side-panel constraints — measured in CSS pixels.
const MIN_VIDEO_WIDTH = 360;
const MAX_VIDEO_WIDTH = 1100;
const DEFAULT_VIDEO_WIDTH = 560;
const STORAGE_KEY = "scribe.videoPanelWidth";

export default function App() {
  useKeyboardShortcuts();
  useAutoSave();
  useTranscribeProgress();

  // True once there are actual transcribed words (not just an empty placeholder segment).
  const hasTranscript = useProjectStore((s) =>
    s.project.segments.some((seg) => seg.words.length > 0),
  );
  const hasMedia = useProjectStore((s) => Object.keys(s.project.media).length > 0);

  const [videoWidth, setVideoWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_VIDEO_WIDTH;
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) && parsed >= MIN_VIDEO_WIDTH && parsed <= MAX_VIDEO_WIDTH
      ? parsed
      : DEFAULT_VIDEO_WIDTH;
  });
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Scribe is an editing surface; keep the chrome consistently dark like an NLE.
  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);

  // Persist the chosen panel width.
  useEffect(() => {
    try {
      window.localStorage?.setItem(STORAGE_KEY, String(videoWidth));
    } catch {
      /* ignore */
    }
  }, [videoWidth]);

  // ── Resizable splitter wiring ────────────────────────────────────────────
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - e.clientX;
      const next = Math.max(
        MIN_VIDEO_WIDTH,
        Math.min(MAX_VIDEO_WIDTH, dragRef.current.startWidth + delta),
      );
      setVideoWidth(next);
    }
    function onUp() {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function startDrag(e: React.MouseEvent) {
    dragRef.current = { startX: e.clientX, startWidth: videoWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Toolbar />

      {hasMedia && <Toolbox />}

      {/*
       * IMPORTANT: keep a single VideoPreview instance across both layouts.
       * Switching between two different DOM trees here would unmount the
       * <video> element, dropping the loaded source and decoded buffers —
       * which is what was breaking play-after-transcribe. We render the
       * VideoPreview at exactly one position in the tree and toggle the
       * surrounding wrapper classes instead.
       */}
      <div
        className={
          hasTranscript
            ? "flex flex-1 overflow-hidden"
            : "flex flex-1 flex-col items-center justify-center overflow-hidden gap-5 px-8"
        }
      >
        {hasTranscript && (
          <>
            <main className="relative flex min-w-0 flex-1 overflow-hidden border-r border-border">
              <TranscriptEditor />
            </main>

            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={startDrag}
              onDoubleClick={() => setVideoWidth(DEFAULT_VIDEO_WIDTH)}
              className="group relative w-1.5 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40"
              title="Drag to resize · double-click to reset"
            >
              <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
              <div className="absolute inset-y-1/2 left-1/2 h-8 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-border/50 group-hover:bg-foreground/30" />
            </div>
          </>
        )}

        {/*
         * The same <aside> element wraps VideoPreview in both states. By
         * always rendering this element (just toggling classes/inline style),
         * we keep the underlying <video> mounted across the
         * pre-transcript → post-transcript transition.
         */}
        <aside
          className={
            hasTranscript
              ? "flex h-full shrink-0 flex-col overflow-hidden bg-black"
              : "flex w-full max-w-[900px] flex-col overflow-hidden rounded-2xl bg-black shadow-[0_8px_48px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.07]"
          }
          style={
            hasTranscript
              ? { width: videoWidth }
              : { height: "min(560px, 65vh)" }
          }
        >
          <VideoPreview />
        </aside>

        {!hasTranscript && (
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
        )}
      </div>

      {/* Full-width waveform — only when media is loaded */}
      {hasMedia && (
        <div className="h-[154px] shrink-0 border-t border-border bg-background">
          <Waveform />
        </div>
      )}

      <StatusBar />

      <Toaster />
    </div>
  );
}
