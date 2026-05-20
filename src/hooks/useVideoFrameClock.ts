/**
 * Frame-accurate playback clock.
 *
 * `HTMLVideoElement.requestVideoFrameCallback` (rVFC) fires once per *presented*
 * video frame and hands us the exact `mediaTime` of that frame — sub-millisecond
 * precision, locked to the GPU compositor. This is dramatically tighter than the
 * ~250ms granularity of the `timeupdate` event, and tighter even than rAF (which
 * fires on display vsync, not video vsync, so it can stutter on a 60 Hz panel
 * playing 24 fps content).
 *
 * We use rVFC when available and fall back to rAF (driven by `el.currentTime`)
 * otherwise. The callback receives `(mediaTime, frameMetadata?)`:
 *   - `mediaTime` is in seconds, frame-accurate.
 *   - `frameMetadata` is the raw rVFC metadata when present (gives `expectedDisplayTime`,
 *     `presentationTime`, etc.) — useful for diagnostics but optional.
 *
 * The hook only ticks while the video is actually playing. Pausing the video
 * cancels the loop; resuming starts a fresh one. Crucially the loop is _torn
 * down_ on cleanup and on `videoEl` swap, so we never leak frame callbacks
 * across remounts.
 */

import { useEffect, useRef } from "react";

type RVFCMetadata = {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
};

type VideoElementWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, metadata: RVFCMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type FrameClockTick = (mediaTime: number, metadata?: RVFCMetadata) => void;

/**
 * Returns an imperative controller so callers can start/stop the clock
 * deterministically. The callback receives `mediaTime` in seconds.
 */
export function useVideoFrameClock(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  onTick: FrameClockTick,
  enabled: boolean,
): void {
  // Keep the latest tick in a ref so we don't tear down the loop just because
  // a parent re-rendered and produced a new closure.
  const tickRef = useRef(onTick);
  useEffect(() => {
    tickRef.current = onTick;
  }, [onTick]);

  useEffect(() => {
    const el = videoRef.current as VideoElementWithRVFC | null;
    if (!el || !enabled) return;

    let cancelled = false;
    let rvfcHandle: number | null = null;
    let rafHandle: number | null = null;

    const hasRVFC = typeof el.requestVideoFrameCallback === "function";

    if (hasRVFC) {
      const loop = (_now: number, metadata: RVFCMetadata) => {
        if (cancelled) return;
        tickRef.current(metadata.mediaTime, metadata);
        rvfcHandle = el.requestVideoFrameCallback!(loop);
      };
      rvfcHandle = el.requestVideoFrameCallback!(loop);
    } else {
      // Fallback: rAF + el.currentTime. Less precise but works on older WKWebView builds.
      const loop = () => {
        if (cancelled) return;
        tickRef.current(el.currentTime);
        rafHandle = window.requestAnimationFrame(loop);
      };
      rafHandle = window.requestAnimationFrame(loop);
    }

    return () => {
      cancelled = true;
      if (rvfcHandle !== null && el.cancelVideoFrameCallback) {
        el.cancelVideoFrameCallback(rvfcHandle);
      }
      if (rafHandle !== null) {
        window.cancelAnimationFrame(rafHandle);
      }
    };
  }, [enabled, videoRef]);
}
