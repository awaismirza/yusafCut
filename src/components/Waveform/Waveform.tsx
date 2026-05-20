/**
 * Full-width waveform timeline.
 *
 * Clicking anywhere on the waveform seeks the video to that source position
 * and starts playback. The playhead cursor tracks the current time.
 */

import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";

export function Waveform() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const project = useProjectStore((s) => s.project);
  const currentTime = usePlayerStore((s) => s.currentTime);

  const firstMedia = Object.values(project.media)[0];

  useEffect(() => {
    if (!containerRef.current || !firstMedia) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "rgba(120, 120, 180, 0.5)",
      progressColor: "rgba(160, 160, 255, 0.85)",
      cursorColor: "rgba(255, 80, 80, 0.9)",
      cursorWidth: 2,
      height: 68,
      barWidth: 2,
      barRadius: 2,
      barGap: 1,
      interact: true,
    });

    void ws.load(convertFileSrc(firstMedia.path));

    // Seek the video (and start playback) when the user clicks the waveform.
    // WaveSurfer v7 fires "interaction" with the new source time in seconds.
    ws.on("interaction", (newTime: number) => {
      window.dispatchEvent(
        new CustomEvent("scribe:seek-source", { detail: { start: newTime } }),
      );
      // Start playing — same behaviour as clicking a word in the transcript.
      usePlayerStore.getState().setPlaying(true);
    });

    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [firstMedia]);

  // Move the cursor with the playhead.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !firstMedia) return;
    const dur = ws.getDuration();
    if (dur > 0) {
      ws.setTime(Math.min(currentTime, dur));
    }
  }, [currentTime, firstMedia]);

  if (!firstMedia) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Waveform will appear here once media is loaded
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
