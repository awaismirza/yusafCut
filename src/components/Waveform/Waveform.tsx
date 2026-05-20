/**
 * Tiny WaveSurfer-backed audio waveform. Loads the audio from the first media
 * file and mirrors playhead position from the player store.
 *
 * Phase 1: simple waveform of the *source* audio. Phase 5+: render the EDL
 * directly (gaps for deleted ranges).
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
      waveColor: "rgb(150 150 150)",
      progressColor: "rgb(80 80 80)",
      cursorColor: "rgb(255 100 100)",
      height: 80,
      barWidth: 2,
      barRadius: 1,
      interact: false,
      media: undefined,
    });
    void ws.load(convertFileSrc(firstMedia.path));
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [firstMedia]);

  // Move the cursor with the playhead
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
        Waveform will appear here once media is loaded.
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
