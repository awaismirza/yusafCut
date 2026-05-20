/**
 * Single <video> element driven by an EDL.
 *
 * Phase 4 Option A from the spec: monitor timeupdate, jump over deleted ranges.
 * The video loads the *first* media in the project for now; multi-clip support
 * is phase 5+. We translate between output-time (player store) and source-time
 * via the EDL helpers.
 */

import { useEffect, useRef } from "react";
import { computeTimeline, nextSurvivingSegment, type Project } from "@/lib/edl";
import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";

function firstMediaPath(project: Project): string | null {
  const ids = Object.keys(project.media);
  if (ids.length === 0) return null;
  return project.media[ids[0]!]!.path;
}

export function VideoPreview() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const project = useProjectStore((s) => s.project);
  const playing = usePlayerStore((s) => s.playing);
  const muted = usePlayerStore((s) => s.muted);
  const rate = usePlayerStore((s) => s.rate);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const toggleMuted = usePlayerStore((s) => s.toggleMuted);

  const mediaPath = firstMediaPath(project);
  const src = mediaPath ? convertFileSrc(mediaPath) : null;

  // Drive play/pause from store
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (playing) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [playing, setPlaying]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  // Imperative seek from outside (e.g. transcript click)
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ start: number }>;
      const el = videoRef.current;
      if (!el) return;
      el.currentTime = ce.detail.start;
    };
    window.addEventListener("scribe:seek-source", handler);
    return () => window.removeEventListener("scribe:seek-source", handler);
  }, []);

  // Time update: convert source-time on <video> to output-time, skip deleted ranges.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    function onTimeUpdate() {
      if (!el) return;
      const ids = Object.keys(project.media);
      if (ids.length === 0) return;
      const mediaId = ids[0]!;
      const srcTime = el.currentTime;
      const timeline = computeTimeline(project);

      // Find the timeline entry whose source range brackets the current src time
      const entry = timeline.find(
        (e) => e.mediaId === mediaId && srcTime >= e.sourceIn && srcTime < e.sourceOut,
      );

      if (entry) {
        // We're inside a kept segment. Update output time.
        const outputTime = entry.outputStart + (srcTime - entry.sourceIn);
        setCurrentTime(outputTime);
        return;
      }

      // We're in a deleted range — jump to next surviving segment for this media.
      const next = nextSurvivingSegment(project, mediaId, srcTime);
      if (next) {
        el.currentTime = next.sourceIn;
      } else {
        // Past the end of any surviving segment — pause.
        el.pause();
        setPlaying(false);
      }
    }
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("play", () => setPlaying(true));
    el.addEventListener("pause", () => setPlaying(false));
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [project, setCurrentTime, setPlaying]);

  if (!src) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-black/90 p-4 text-muted-foreground">
        <div className="text-sm">No media loaded</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-black">
      <video
        ref={videoRef}
        src={src}
        className="min-h-0 flex-1 object-contain"
        controls={false}
        playsInline
      />
      <div className="flex items-center gap-2 bg-background/80 p-2 backdrop-blur">
        <Button size="icon" variant="ghost" onClick={() => setPlaying(!playing)}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={toggleMuted}>
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
