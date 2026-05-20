/**
 * Video preview panel with full playback controls.
 *
 * Controls provided:
 *   - Scrubber (output-time progress bar)
 *   - Skip ±5 s
 *   - Play / Pause
 *   - Current time / duration
 *   - Playback rate cycle
 *   - Mute toggle
 *
 * Seeking from the transcript (scribe:seek-source) automatically starts playback.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  computeTimeline,
  nextSurvivingSegment,
  totalDuration,
  type Project,
} from "@/lib/edl";
import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { formatDuration } from "@/lib/timecode";

function firstMediaPath(project: Project): string | null {
  const ids = Object.keys(project.media);
  if (ids.length === 0) return null;
  return project.media[ids[0]!]!.path;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function VideoPreview() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const project = useProjectStore((s) => s.project);
  const playing = usePlayerStore((s) => s.playing);
  const muted = usePlayerStore((s) => s.muted);
  const rate = usePlayerStore((s) => s.rate);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const toggleMuted = usePlayerStore((s) => s.toggleMuted);
  const setRate = usePlayerStore((s) => s.setRate);

  // Track whether the user is actively dragging the scrubber so we don't
  // fight the timeupdate loop while they scrub.
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);

  const mediaPath = firstMediaPath(project);
  const src = mediaPath ? convertFileSrc(mediaPath) : null;
  const outputDuration = totalDuration(project);

  // The displayed progress fraction (0-1000) — while scrubbing, follow the
  // drag; otherwise follow the player store.
  const displayedProgress = scrubbing
    ? scrubValue
    : outputDuration > 0
      ? Math.round((currentTime / outputDuration) * 1000)
      : 0;

  // ── Drive play/pause from store ──────────────────────────────────────────
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

  // ── Seek from transcript / waveform click → also start playing ────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ start: number }>;
      const el = videoRef.current;
      if (!el) return;
      el.currentTime = ce.detail.start;
      // Auto-start playback so the user doesn't have to press play separately.
      setPlaying(true);
    };
    window.addEventListener("scribe:seek-source", handler);
    return () => window.removeEventListener("scribe:seek-source", handler);
  }, [setPlaying]);

  // ── Time update: skip deleted ranges, update store ────────────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    function onTimeUpdate() {
      if (!el || scrubbing) return;
      const ids = Object.keys(project.media);
      if (ids.length === 0) return;
      const mediaId = ids[0]!;
      const srcTime = el.currentTime;
      const timeline = computeTimeline(project);

      const entry = timeline.find(
        (e) => e.mediaId === mediaId && srcTime >= e.sourceIn && srcTime < e.sourceOut,
      );

      if (entry) {
        const outputTime = entry.outputStart + (srcTime - entry.sourceIn);
        setCurrentTime(outputTime);
        return;
      }

      const next = nextSurvivingSegment(project, mediaId, srcTime);
      if (next) {
        el.currentTime = next.sourceIn;
      } else {
        el.pause();
        setPlaying(false);
      }
    }

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [project, setCurrentTime, setPlaying, scrubbing]);

  // ── Seek helpers ─────────────────────────────────────────────────────────
  const seekToOutputTime = useCallback(
    (targetOutput: number) => {
      const el = videoRef.current;
      if (!el) return;
      const clamped = Math.max(0, Math.min(targetOutput, outputDuration));
      const timeline = computeTimeline(project);
      for (const entry of timeline) {
        if (clamped >= entry.outputStart && clamped <= entry.outputEnd) {
          el.currentTime = entry.sourceIn + (clamped - entry.outputStart);
          setCurrentTime(clamped);
          return;
        }
      }
      // Past the last segment — jump to its end
      if (timeline.length > 0) {
        const last = timeline[timeline.length - 1]!;
        el.currentTime = last.sourceOut;
        setCurrentTime(outputDuration);
      }
    },
    [project, outputDuration, setCurrentTime],
  );

  const handleScrubStart = () => {
    setScrubbing(true);
    setScrubValue(displayedProgress);
  };

  const handleScrubMove = (e: React.ChangeEvent<HTMLInputElement>) => {
    setScrubValue(Number(e.target.value));
  };

  const handleScrubEnd = (e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
    const fraction = Number((e.currentTarget as HTMLInputElement).value) / 1000;
    seekToOutputTime(fraction * outputDuration);
    setScrubbing(false);
  };

  const handleSkip = useCallback(
    (delta: number) => {
      seekToOutputTime(currentTime + delta);
    },
    [seekToOutputTime, currentTime],
  );

  const cycleRate = () => {
    const idx = RATES.indexOf(rate as (typeof RATES)[number]);
    const next = RATES[(idx + 1) % RATES.length] ?? 1;
    setRate(next);
  };

  // ── Empty state ──────────────────────────────────────────────────────────
  if (!src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-black text-white/30">
        <Play className="h-10 w-10 opacity-20" />
        <p className="text-sm">No media loaded</p>
        <p className="text-xs opacity-60">Open a video to get started</p>
      </div>
    );
  }

  const pct = (displayedProgress / 1000) * 100;

  return (
    <div className="flex h-full flex-col bg-black">
      {/* ── Video area ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          src={src}
          className="max-h-full max-w-full object-contain"
          controls={false}
          playsInline
        />
      </div>

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5 border-t border-white/10 bg-zinc-950 px-3 pb-3 pt-2">
        {/* Scrubber */}
        <div className="group relative flex items-center">
          <div
            className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-l-full bg-white/80"
            style={{ width: `${pct}%` }}
          />
          <input
            type="range"
            min={0}
            max={1000}
            value={displayedProgress}
            onMouseDown={handleScrubStart}
            onTouchStart={handleScrubStart}
            onChange={handleScrubMove}
            onMouseUp={handleScrubEnd}
            onTouchEnd={handleScrubEnd}
            className="scrubber w-full"
            aria-label="Playback position"
          />
        </div>

        {/* Button row */}
        <div className="flex items-center gap-0.5">
          {/* Skip back */}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white/60 hover:bg-white/10 hover:text-white"
            onClick={() => handleSkip(-5)}
            title="Back 5 s"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </Button>

          {/* Play / Pause */}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-white hover:bg-white/10"
            onClick={() => setPlaying(!playing)}
            title={playing ? "Pause (Space)" : "Play (Space)"}
          >
            {playing ? (
              <Pause className="h-4 w-4 fill-white" />
            ) : (
              <Play className="h-4 w-4 fill-white" />
            )}
          </Button>

          {/* Skip forward */}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white/60 hover:bg-white/10 hover:text-white"
            onClick={() => handleSkip(5)}
            title="Forward 5 s"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </Button>

          {/* Time display */}
          <span className="ml-1.5 select-none text-xs tabular-nums text-white/50">
            {formatDuration(currentTime)}
            <span className="mx-0.5 text-white/25">/</span>
            {formatDuration(outputDuration)}
          </span>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-0.5">
            {/* Rate */}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 min-w-[36px] px-1.5 text-xs tabular-nums text-white/50 hover:bg-white/10 hover:text-white"
              onClick={cycleRate}
              title="Playback speed"
            >
              {rate === 1 ? "1×" : `${rate}×`}
            </Button>

            {/* Mute */}
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-white/60 hover:bg-white/10 hover:text-white"
              onClick={toggleMuted}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
