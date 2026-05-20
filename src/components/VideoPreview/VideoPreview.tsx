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
import { AlertTriangle, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { formatTimecode } from "@/lib/timecode";
import { useVideoFrameClock } from "@/hooks/useVideoFrameClock";

function firstMediaPath(project: Project): string | null {
  const ids = Object.keys(project.media);
  if (ids.length === 0) return null;
  return project.media[ids[0]!]!.path;
}

function firstMediaId(project: Project): string | null {
  return Object.keys(project.media)[0] ?? null;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** True when the project has at least one segment with transcribed words. */
function hasWords(project: Project) {
  return project.segments.some((s) => s.words.length > 0);
}

function hasTimeline(project: Project) {
  return project.segments.length > 0;
}

function displayDurationForProgress(outputDuration: number, nativeDuration: number) {
  return outputDuration > 0 ? outputDuration : nativeDuration;
}

function videoErrorMessage(error: MediaError) {
  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was interrupted before the media loaded.";
    case MediaError.MEDIA_ERR_NETWORK:
      return "The media URL could not be read by the app.";
    case MediaError.MEDIA_ERR_DECODE:
      return "This video codec could not be decoded by the WebView.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "The media source is not supported or is outside the allowed local-file scope.";
    default:
      return error.message || "Unknown media playback error.";
  }
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
  const [nativeDuration, setNativeDuration] = useState(0);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadMessage, setLoadMessage] = useState<string>("");
  const [activeMediaId, setActiveMediaId] = useState<string | null>(() => firstMediaId(project));
  const pendingSeekRef = useRef<{ sourceTime: number; outputTime: number; play: boolean } | null>(
    null,
  );

  const fallbackMediaPath = firstMediaPath(project);
  const mediaPath = activeMediaId ? (project.media[activeMediaId]?.path ?? null) : fallbackMediaPath;
  const src = mediaPath ? convertFileSrc(mediaPath) : null;
  const outputDuration = totalDuration(project);
  const hasTranscriptWords = hasWords(project);

  // While scrubbing, follow the drag; otherwise follow the player store.
  const displayedProgress = scrubbing
    ? scrubValue
    : displayDurationForProgress(outputDuration, nativeDuration) > 0
      ? Math.round(
          (currentTime / displayDurationForProgress(outputDuration, nativeDuration)) * 1000,
        )
      : 0;

  // Tracks the latest user intent so we can ignore stale Promise rejections
  // from interrupted el.play() calls — e.g. when a click-on-word seek races
  // the play/pause effect. Without this guard, an AbortError from the first
  // play() flips `playing` back to false and pauses the video immediately.
  const playIntentRef = useRef(false);

  const playVideo = useCallback(() => {
    const el = videoRef.current;
    if (!el) return false;
    playIntentRef.current = true;
    if (!el.currentSrc && src) {
      el.load();
    }
    if (el.error) {
      setLoadState("error");
      setLoadMessage(videoErrorMessage(el.error));
      setPlaying(false);
      return false;
    }
    const promise = el.play();
    if (promise) {
      promise.catch((err: DOMException) => {
        if (err.name === "AbortError") return;
        setLoadState("error");
        setLoadMessage(err.message || "Playback failed.");
        if (playIntentRef.current) setPlaying(false);
      });
    }
    setPlaying(true);
    return true;
  }, [setPlaying, src]);

  useEffect(() => {
    const desiredMediaId = outputTimeToSource(project, currentTime)?.segment.mediaId ?? firstMediaId(project);
    if (desiredMediaId && !project.media[activeMediaId ?? ""]) {
      setActiveMediaId(desiredMediaId);
    }
  }, [activeMediaId, currentTime, project]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const pending = pendingSeekRef.current;
    playIntentRef.current = pending?.play ?? false;
    if (!pending) {
      setCurrentTime(0);
      setPlaying(false);
    } else {
      setCurrentTime(pending.outputTime);
      setPlaying(pending.play);
    }
    setNativeDuration(0);
    setLoadState(src ? "loading" : "idle");
    setLoadMessage(src ? "Loading media..." : "");
    el.pause();
    try {
      el.currentTime = pending?.sourceTime ?? 0;
    } catch {
      /* ignored until metadata exists */
    }

    const applyPendingSeek = () => {
      const seek = pendingSeekRef.current;
      if (!seek) return;
      el.currentTime = seek.sourceTime;
      setCurrentTime(seek.outputTime);
      pendingSeekRef.current = null;
      if (seek.play) playVideo();
    };

    el.addEventListener("loadedmetadata", applyPendingSeek, { once: true });
    el.load();
    return () => el.removeEventListener("loadedmetadata", applyPendingSeek);
  }, [playVideo, setCurrentTime, setPlaying, src]);

  const pauseVideo = useCallback(() => {
    const el = videoRef.current;
    playIntentRef.current = false;
    if (el) el.pause();
    setPlaying(false);
  }, [setPlaying]);

  // ── Output-time seek helpers ──────────────────────────────────────────────
  const seekToOutputTime = useCallback(
    (targetOutput: number, opts: { play?: boolean } = {}) => {
      const el = videoRef.current;
      if (!el) return;
      const clamped = Math.max(0, Math.min(targetOutput, outputDuration || el.duration || 0));

      // Free-play mode: output time === source time before an EDL exists.
      if (!hasTimeline(project)) {
        el.currentTime = clamped;
        setCurrentTime(clamped);
        return;
      }

      const mapped = outputTimeToSource(project, clamped);
      if (mapped) {
        const mediaId = mapped.segment.mediaId;
        if (mediaId !== activeMediaId) {
          pendingSeekRef.current = {
            sourceTime: mapped.sourceTime,
            outputTime: clamped,
            play: opts.play ?? usePlayerStore.getState().playing,
          };
          setActiveMediaId(mediaId);
          return;
        }
        el.currentTime = mapped.sourceTime;
        setCurrentTime(clamped);
        return;
      }

      const timeline = computeTimeline(project);
      if (timeline.length > 0) {
        const last = timeline[timeline.length - 1]!;
        if (last.mediaId !== activeMediaId) {
          pendingSeekRef.current = {
            sourceTime: last.sourceOut,
            outputTime: outputDuration,
            play: false,
          };
          setActiveMediaId(last.mediaId);
          return;
        }
        el.currentTime = last.sourceOut;
        setCurrentTime(outputDuration);
      }
    },
    [activeMediaId, outputDuration, project, setCurrentTime],
  );

  // `precise` is the frame-accurate `mediaTime` from requestVideoFrameCallback
  // when available; falling back to `el.currentTime` (which can lag a frame).
  // Passing it explicitly removes one source of jitter in the word/timeline
  // sync — the worst-case error is now sub-millisecond instead of ~16ms.
  const syncPlaybackClock = useCallback((precise?: number) => {
    const el = videoRef.current;
    if (!el || scrubbing) return;
    const mediaId = activeMediaId ?? firstMediaId(project);
    if (!mediaId) return;

    const srcTime = precise ?? el.currentTime;

    if (!hasTimeline(project)) {
      setCurrentTime(srcTime);
      return;
    }

    const timeline = computeTimeline(project);
    const entry = timeline.find(
      (e) => e.mediaId === mediaId && srcTime >= e.sourceIn && srcTime < e.sourceOut,
    );

    if (entry) {
      setCurrentTime(entry.outputStart + (srcTime - entry.sourceIn));
      return;
    }

    const outputNow = usePlayerStore.getState().currentTime;
    const nextTimelineEntry = timeline.find((e) => e.outputStart >= outputNow - 0.05);
    if (nextTimelineEntry) {
      seekToOutputTime(nextTimelineEntry.outputStart + 0.001);
      return;
    }

    const next = nextSurvivingSegment(project, mediaId, srcTime);
    if (next && next.mediaId === mediaId) {
      const mapped = sourceTimeToOutput(project, mediaId, next.sourceIn);
      if (mapped) setCurrentTime(mapped.outputTime);
      el.currentTime = next.sourceIn;
      return;
    }

    el.pause();
    setPlaying(false);
  }, [activeMediaId, project, scrubbing, seekToOutputTime, setCurrentTime, setPlaying]);

  // ── Drive play/pause state from store ────────────────────────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (playing && el.paused) {
      playVideo();
    } else if (!playing && !el.paused) {
      pauseVideo();
    }
  }, [pauseVideo, playVideo, playing]);

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
      const ce = e as CustomEvent<{ start: number; mediaId?: string }>;
      const el = videoRef.current;
      if (!el) return;
      const mediaId = ce.detail.mediaId ?? activeMediaId ?? firstMediaId(project);
      if (mediaId && hasTimeline(project)) {
        const mapped = sourceTimeToOutput(project, mediaId, ce.detail.start);
        if (mapped) {
          seekToOutputTime(mapped.outputTime, { play: true });
          return;
        }
      }
      if (mediaId && mediaId !== activeMediaId) {
        pendingSeekRef.current = {
          sourceTime: ce.detail.start,
          outputTime: ce.detail.start,
          play: true,
        };
        setActiveMediaId(mediaId);
      } else {
        el.currentTime = ce.detail.start;
        setCurrentTime(ce.detail.start);
        playVideo();
      }
    };
    window.addEventListener("scribe:seek-source", handler);
    return () => window.removeEventListener("scribe:seek-source", handler);
  }, [activeMediaId, playVideo, project, seekToOutputTime, setCurrentTime]);

  // ── Time update: skip deleted ranges, update store ────────────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    function onTimeUpdate() {
      // While paused, rVFC doesn't tick — we still need timeupdate to keep the
      // store in sync with manual seeks. While playing, rVFC dominates and this
      // is harmless redundancy.
      syncPlaybackClock(el!.currentTime);
    }

    const onLoadedMetadata = () => {
      setNativeDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setLoadState("ready");
      setLoadMessage("");
    };
    const onCanPlay = () => {
      setLoadState("ready");
      setLoadMessage("");
    };
    const onWaiting = () => {
      if (!el.paused) setLoadState("loading");
    };
    const onError = () => {
      setLoadState("error");
      setLoadMessage(el.error ? videoErrorMessage(el.error) : "Media failed to load.");
      setPlaying(false);
    };
    const onPlay = () => {
      setLoadState("ready");
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("loadedmetadata", onLoadedMetadata);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("error", onError);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("error", onError);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [setPlaying, syncPlaybackClock]);

  // Frame-accurate clock — uses requestVideoFrameCallback (sub-ms precision,
  // locked to video frame presentation) with rAF as a fallback. Replaces the
  // earlier rAF tick that drifted on non-vsync refresh rates.
  useVideoFrameClock(
    videoRef,
    useCallback(
      (mediaTime: number) => {
        syncPlaybackClock(mediaTime);
      },
      [syncPlaybackClock],
    ),
    playing,
  );

  useEffect(() => {
    function onPlay() {
      playVideo();
    }
    function onPause() {
      pauseVideo();
    }
    function onToggle() {
      if (usePlayerStore.getState().playing) pauseVideo();
      else playVideo();
    }
    function onSeekOutput(e: Event) {
      const ce = e as CustomEvent<{ time: number; play?: boolean }>;
      seekToOutputTime(ce.detail.time, { play: ce.detail.play });
      if (ce.detail.play && activeMediaId === outputTimeToSource(project, ce.detail.time)?.segment.mediaId) {
        playVideo();
      }
    }

    window.addEventListener("scribe:play", onPlay);
    window.addEventListener("scribe:pause", onPause);
    window.addEventListener("scribe:toggle-play", onToggle);
    window.addEventListener("scribe:seek-output", onSeekOutput);
    return () => {
      window.removeEventListener("scribe:play", onPlay);
      window.removeEventListener("scribe:pause", onPause);
      window.removeEventListener("scribe:toggle-play", onToggle);
      window.removeEventListener("scribe:seek-output", onSeekOutput);
    };
  }, [activeMediaId, pauseVideo, playVideo, project, seekToOutputTime]);

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
    seekToOutputTime(best.outputTime);
    return true;
  }, [project, seekToOutputTime, selectedWordIds]);

  const handleScrubStart = () => {
    setScrubbing(true);
    setScrubValue(displayedProgress);
  };

  const handleScrubMove = (e: React.ChangeEvent<HTMLInputElement>) => {
    setScrubValue(Number(e.target.value));
  };

  const handleScrubEnd = (
    e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>,
  ) => {
    const fraction = Number((e.currentTarget as HTMLInputElement).value) / 1000;
    // Use source duration only before the EDL has any segment.
    const dur = hasTimeline(project) ? outputDuration : (videoRef.current?.duration ?? 0);
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
      setRate(1);
      pauseVideo();
      return;
    }
    seekToSelectedWord();
    playVideo();
  };

  // Display duration: use source duration in free-play mode, output duration otherwise
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
            key={src}
            ref={videoRef}
            src={src}
            className="max-h-full max-w-full object-contain"
            controls={false}
            preload="metadata"
            playsInline
          />
          {loadState === "loading" && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45">
              <div className="rounded-md border border-white/10 bg-black/75 px-4 py-3 text-sm text-white/75">
                Loading media...
              </div>
            </div>
          )}
          {loadState === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6 text-center">
              <div className="max-w-sm rounded-md border border-red-400/30 bg-red-950/35 px-4 py-3 text-sm text-red-100">
                <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
                <p className="font-semibold">Video could not be loaded</p>
                <p className="mt-1 text-red-100/75">{loadMessage}</p>
              </div>
            </div>
          )}
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
            {playing ? (
              <Pause className="h-4 w-4 fill-current stroke-none" />
            ) : (
              <Play className="h-4 w-4 fill-current stroke-none" />
            )}
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
              {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
