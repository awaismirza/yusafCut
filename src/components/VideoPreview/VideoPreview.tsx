/**
 * Video preview panel with full playback controls.
 *
 * Key behaviours:
 *  - When there are no transcribed words yet the video plays freely (no EDL constraints).
 *  - Seeking from transcript/waveform (scribe:seek-source) calls el.play() directly to
 *    avoid the React-state → effect cycle race condition.
 *  - Scrubber shows output-time progress; skip ±5 s; playback rate cycle; mute toggle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  computeTimeline,
  nextSurvivingSegment,
  outputTimeToSource,
  sourceTimeToOutput,
  totalDuration,
  wordIdToOutputTime,
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
import { formatTimecode } from "@/lib/timecode";

function firstMediaPath(project: Project): string | null {
  const ids = Object.keys(project.media);
  if (ids.length === 0) return null;
  return project.media[ids[0]!]!.path;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** True when the project has at least one segment with transcribed words. */
function hasWords(project: Project) {
  return project.segments.some((s) => s.words.length > 0);
}

export function VideoPreview() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const project = useProjectStore((s) => s.project);
  const playing = usePlayerStore((s) => s.playing);
  const muted = usePlayerStore((s) => s.muted);
  const rate = usePlayerStore((s) => s.rate);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const selectedWordIds = usePlayerStore((s) => s.selectedWordIds);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const toggleMuted = usePlayerStore((s) => s.toggleMuted);
  const setRate = usePlayerStore((s) => s.setRate);

  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);

  const mediaPath = firstMediaPath(project);
  const src = mediaPath ? convertFileSrc(mediaPath) : null;
  const outputDuration = totalDuration(project);
  const hasTranscriptWords = hasWords(project);

  // While scrubbing, follow the drag; otherwise follow the player store.
  const displayedProgress = scrubbing
    ? scrubValue
    : outputDuration > 0
      ? Math.round((currentTime / outputDuration) * 1000)
      : 0;

  // Tracks the latest user intent so we can ignore stale Promise rejections
  // from interrupted el.play() calls — e.g. when a click-on-word seek races
  // the play/pause effect. Without this guard, an AbortError from the first
  // play() flips `playing` back to false and pauses the video immediately.
  const playIntentRef = useRef(false);

  // ── Drive play/pause state from store ────────────────────────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    playIntentRef.current = playing;
    if (playing) {
      // Don't await — fire-and-forget. Only flip state back if the call
      // actually failed AND we still intend to be playing (i.e. the failure
      // wasn't because another seek/play call superseded us).
      el.play().catch((err: DOMException) => {
        if (err.name === "AbortError") return; // interrupted by another play() — ignore
        if (playIntentRef.current) setPlaying(false);
      });
    } else {
      el.pause();
    }
  }, [playing, setPlaying]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  // ── Seek from transcript / waveform → start playing ─────────────────────
  // We only set currentTime here and flip the store flag. The play/pause
  // effect above is the single source of truth for el.play()/el.pause() —
  // keeping that invariant prevents the AbortError race we used to hit when
  // both this handler and the effect called play() in quick succession.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ start: number }>;
      const el = videoRef.current;
      if (!el) return;
      el.currentTime = ce.detail.start;
      const firstMediaId = Object.keys(project.media)[0];
      if (firstMediaId && hasWords(project)) {
        const mapped = sourceTimeToOutput(project, firstMediaId, ce.detail.start);
        setCurrentTime(mapped?.outputTime ?? 0);
      } else {
        setCurrentTime(ce.detail.start);
      }
      setPlaying(true);
    };
    window.addEventListener("scribe:seek-source", handler);
    return () => window.removeEventListener("scribe:seek-source", handler);
  }, [project, setCurrentTime, setPlaying]);

  // ── Time update: skip deleted ranges, update store ────────────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    function onTimeUpdate() {
      if (!el || scrubbing) return;
      const ids = Object.keys(project.media);
      if (ids.length === 0) return;

      // ── Free-play mode: no EDL constraints when there are no transcribed words ──
      // This handles both the "no transcript yet" state and the case where all
      // words have been deleted.
      if (!hasWords(project)) {
        setCurrentTime(el.currentTime);
        return;
      }

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

      // In a deleted range → jump to next surviving segment.
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

  // ── Output-time seek helpers ──────────────────────────────────────────────
  const seekToOutputTime = useCallback(
    (targetOutput: number) => {
      const el = videoRef.current;
      if (!el) return;
      const clamped = Math.max(0, Math.min(targetOutput, outputDuration || el.duration || 0));

      // Free-play mode: output time === source time.
      if (!hasWords(project)) {
        el.currentTime = clamped;
        setCurrentTime(clamped);
        return;
      }

      const mapped = outputTimeToSource(project, clamped);
      if (mapped) {
        el.currentTime = mapped.sourceTime;
        setCurrentTime(clamped);
        return;
      }
      const timeline = computeTimeline(project);
      if (timeline.length > 0) {
        const last = timeline[timeline.length - 1]!;
        el.currentTime = last.sourceOut;
        setCurrentTime(outputDuration);
      }
    },
    [project, outputDuration, setCurrentTime],
  );

  const seekToSelectedWord = useCallback(() => {
    const el = videoRef.current;
    if (!el || selectedWordIds.size === 0 || !hasWords(project)) return false;
    let best: ReturnType<typeof wordIdToOutputTime> = null;
    for (const id of selectedWordIds) {
      const mapped = wordIdToOutputTime(project, id);
      if (!mapped) continue;
      if (!best || mapped.outputTime < best.outputTime) best = mapped;
    }
    if (!best) return false;
    el.currentTime = best.sourceTime;
    setCurrentTime(best.outputTime);
    return true;
  }, [project, selectedWordIds, setCurrentTime]);

  const handleScrubStart = () => {
    setScrubbing(true);
    setScrubValue(displayedProgress);
  };

  const handleScrubMove = (e: React.ChangeEvent<HTMLInputElement>) => {
    setScrubValue(Number(e.target.value));
  };

  const handleScrubEnd = (e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
    const fraction = Number((e.currentTarget as HTMLInputElement).value) / 1000;
    // Use source duration when there are no EDL words yet
    const dur = hasWords(project) ? outputDuration : (videoRef.current?.duration ?? 0);
    seekToOutputTime(fraction * dur);
    setScrubbing(false);
  };

  const handleSkip = useCallback(
    (delta: number) => seekToOutputTime(currentTime + delta),
    [seekToOutputTime, currentTime],
  );

  const cycleRate = () => {
    const idx = RATES.indexOf(rate as (typeof RATES)[number]);
    setRate(RATES[(idx + 1) % RATES.length] ?? 1);
  };

  const handlePlayPause = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    seekToSelectedWord();
    setPlaying(true);
  };

  // Display duration: use source duration in free-play mode, output duration otherwise
  const [nativeDuration, setNativeDuration] = useState(0);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onLoaded = () => setNativeDuration(el.duration || 0);
    el.addEventListener("loadedmetadata", onLoaded);
    if (el.duration) setNativeDuration(el.duration);
    return () => el.removeEventListener("loadedmetadata", onLoaded);
  }, [src]);

  const displayDuration = hasTranscriptWords ? outputDuration : nativeDuration;
  const pct = (displayedProgress / 1000) * 100;

  // ── No media loaded ───────────────────────────────────────────────────────
  if (!src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-black text-white/25">
        <Play className="h-12 w-12" strokeWidth={1} />
        <p className="text-sm">No media loaded</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-black">
      {/* Video area */}
      <div className="flex flex-1 items-center justify-center overflow-hidden bg-black">
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.06),transparent_48%)]">
          <video
            ref={videoRef}
            src={src}
            className="max-h-full max-w-full object-contain"
            controls={false}
            playsInline
          />
          <div className="pointer-events-none absolute left-4 top-4 rounded bg-black/55 px-2 py-1 text-[11px] font-medium text-white/80">
            Live preview
          </div>
          <div className="pointer-events-none absolute right-4 top-4 rounded bg-black/55 px-2 py-1 text-[11px] tabular-nums text-white/75">
            {formatTimecode(currentTime, { ms: true })}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2 border-t border-white/[0.08] bg-zinc-950 px-3 pb-3 pt-2.5">

        {/* Scrubber */}
        <div className="relative flex items-center">
          {/* Filled track */}
          <div
            className="pointer-events-none absolute left-0 h-1 rounded-l-full bg-white/70"
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
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white/50 hover:bg-white/10 hover:text-white"
            onClick={() => handleSkip(-5)}
            title="Back 5 s (←)"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-105 transition-transform"
            onClick={handlePlayPause}
            title={playing ? "Pause (Space)" : "Play (Space)"}
          >
            {playing
              ? <Pause className="h-4 w-4 fill-current stroke-none" />
              : <Play className="h-4 w-4 fill-current stroke-none" />}
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white/50 hover:bg-white/10 hover:text-white"
            onClick={() => handleSkip(5)}
            title="Forward 5 s (→)"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </Button>

          <span className="ml-1.5 select-none text-xs tabular-nums text-white/50">
            {formatTimecode(currentTime, { ms: false })}
            <span className="mx-1 text-white/25">/</span>
            {formatTimecode(displayDuration, { ms: false })}
          </span>

          <div className="ml-auto flex items-center gap-0.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 min-w-[34px] px-1.5 text-xs tabular-nums text-white/40 hover:bg-white/10 hover:text-white"
              onClick={cycleRate}
              title="Playback speed"
            >
              {rate === 1 ? "1×" : `${rate}×`}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-white/50 hover:bg-white/10 hover:text-white"
              onClick={toggleMuted}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted
                ? <VolumeX className="h-3.5 w-3.5" />
                : <Volume2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
