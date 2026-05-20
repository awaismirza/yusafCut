/**
 * Output timeline.
 *
 * Two view modes, switched purely by `timelineZoom`:
 *  - zoom = 1: the rail fits the panel exactly and behaves like a static overview.
 *  - zoom > 1: the rail is `zoom × containerWidth` wide and lives inside a
 *    horizontally-scrolling container. The playhead is auto-scrolled into view,
 *    word bars are virtualised (only those overlapping the visible window are
 *    rendered) and a small minimap above the rail shows where you are in the
 *    whole output.
 *
 * Sync notes:
 *  - Bars are positioned in absolute px relative to the full-width rail using a
 *    single `pxPerSecond` scale. Pixel layout never moves while the user scrolls
 *    — only the scrollLeft changes — so the playhead stays sub-pixel accurate
 *    even at 32x zoom.
 *  - Wheel-to-pan (horizontal): regular wheel scroll just scrolls the rail.
 *  - Wheel-to-zoom (Cmd/Ctrl + wheel): zooms in/out, recentring on the cursor.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  computeTimeline,
  outputTimeToSource,
  totalDuration,
  wordIdsInOutputRange,
  type Word,
} from "@/lib/edl";
import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { FILLER_WORDS } from "@/components/TranscriptEditor/WordNode";
import { formatTimecode } from "@/lib/timecode";

function bareToken(text: string): string {
  return text.toLowerCase().replace(/[\s.,!?;:"'()[\]{}—–-]/g, "");
}

function isFiller(word: Word): boolean {
  return FILLER_WORDS.has(bareToken(word.text));
}

function amplitude(word: Word, index: number): number {
  let hash = index + 17;
  for (let i = 0; i < word.text.length; i++) hash = (hash * 31 + word.text.charCodeAt(i)) | 0;
  return 22 + (Math.abs(hash) % 44);
}

/** Px overdraw outside the visible window so virtualised bars enter/exit smoothly. */
const VIRTUAL_OVERDRAW_PX = 200;

/** Width of the minimap rail (px). Only shown when zoomed in. */
const MINIMAP_WIDTH_PX = 220;
const MINIMAP_HEIGHT_PX = 14;

export function Waveform() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const project = useProjectStore((s) => s.project);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const selectedWordIds = usePlayerStore((s) => s.selectedWordIds);
  const timelineMarkIn = usePlayerStore((s) => s.timelineMarkIn);
  const timelineMarkOut = usePlayerStore((s) => s.timelineMarkOut);
  const timelineZoom = usePlayerStore((s) => s.timelineZoom);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setSelectedWordIds = usePlayerStore((s) => s.setSelectedWordIds);
  const setTimelineRange = usePlayerStore((s) => s.setTimelineRange);
  const setTimelineZoom = usePlayerStore((s) => s.setTimelineZoom);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  const firstMedia = Object.values(project.media)[0];
  const duration = totalDuration(project);
  const zoomed = timelineZoom > 1.001;

  // ── Layout math ──────────────────────────────────────────────────────────
  // We size the rail relative to the scroll container's clientWidth. At zoom=1
  // the rail equals the container width (and no scrollbar appears). At zoom=N
  // the rail is N× that wide, so 1s of source occupies N times as many pixels.
  const railWidth = Math.max(0, containerWidth * timelineZoom);
  const pxPerSecond = duration > 0 ? railWidth / duration : 0;

  // ── Resize observer to keep `containerWidth` in sync ───────────────────────
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Track scrollLeft for virtualisation + minimap ─────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => setScrollLeft(el.scrollLeft));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  // Reset scroll when the project changes or zoom drops back to 1.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!zoomed) {
      el.scrollLeft = 0;
      setScrollLeft(0);
    }
  }, [zoomed]);

  // ── Auto-follow playhead while playing ────────────────────────────────────
  const playing = usePlayerStore((s) => s.playing);
  const scrubbingNow = dragging;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !zoomed || !playing || scrubbingNow) return;
    const playheadPx = currentTime * pxPerSecond;
    const left = el.scrollLeft;
    const right = left + el.clientWidth;
    // Keep playhead within the central 60% of the viewport — once it drifts
    // outside that band, scroll smoothly to recentre.
    const inset = el.clientWidth * 0.2;
    if (playheadPx < left + inset || playheadPx > right - inset) {
      const target = Math.max(0, playheadPx - el.clientWidth / 2);
      el.scrollTo({ left: target, behavior: "smooth" });
    }
  }, [currentTime, pxPerSecond, playing, scrubbingNow, zoomed]);

  // ── Wheel: horizontal pan; Cmd/Ctrl wheel = zoom around cursor ───────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Zoom factor — slower than the default to feel like a trackpad pinch.
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const beforeZoom = usePlayerStore.getState().timelineZoom;
        const newZoom = Math.max(1, Math.min(32, beforeZoom * factor));
        if (Math.abs(newZoom - beforeZoom) < 1e-3) return;

        // Recentre so the time under the cursor stays put.
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const beforePx = el.scrollLeft + cursorX;
        setTimelineZoom(newZoom);
        // Apply scroll fix in a microtask so React has re-rendered the rail width.
        window.requestAnimationFrame(() => {
          const scale = newZoom / beforeZoom;
          const afterPx = beforePx * scale;
          el.scrollLeft = Math.max(0, afterPx - cursorX);
        });
        return;
      }
      // Pan: trackpads emit deltaX, classic mice emit deltaY. Always treat
      // wheel-on-timeline as horizontal — vertical scrolling here is meaningless.
      if (!zoomed) return;
      const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (dx === 0) return;
      e.preventDefault();
      el.scrollLeft += dx;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setTimelineZoom, zoomed]);

  // ── Virtualised bars + ticks for the visible window ──────────────────────
  const visibleStartPx = Math.max(0, scrollLeft - VIRTUAL_OVERDRAW_PX);
  const visibleEndPx = scrollLeft + containerWidth + VIRTUAL_OVERDRAW_PX;
  const visibleStartSec = pxPerSecond > 0 ? visibleStartPx / pxPerSecond : 0;
  const visibleEndSec = pxPerSecond > 0 ? visibleEndPx / pxPerSecond : duration;

  const { bars, ticks } = useMemo(() => {
    if (pxPerSecond <= 0) return { bars: [] as BarSpec[], ticks: [] as TickSpec[] };
    const timeline = computeTimeline(project);
    let wordIndex = 0;
    const nextBars: BarSpec[] = [];
    for (const entry of timeline) {
      const segment = project.segments.find((s) => s.id === entry.segmentId);
      if (!segment) continue;
      // Quick prune: if the whole segment is outside the window, skip it.
      if (entry.outputEnd < visibleStartSec || entry.outputStart > visibleEndSec) {
        wordIndex += segment.words.length;
        continue;
      }
      for (const word of segment.words) {
        const outputStart = entry.outputStart + Math.max(0, word.start - entry.sourceIn);
        const outputEnd = entry.outputStart + Math.max(0, word.end - entry.sourceIn);
        const idx = wordIndex++;
        if (outputEnd < visibleStartSec || outputStart > visibleEndSec) continue;
        const leftPx = outputStart * pxPerSecond;
        const widthPx = Math.max(2, (outputEnd - outputStart) * pxPerSecond);
        nextBars.push({
          id: word.id,
          leftPx,
          widthPx,
          height: amplitude(word, idx),
          filler: isFiller(word),
          selected: selectedWordIds.has(word.id),
          label: word.text,
        });
      }
    }

    // Density-aware tick step. At higher zoom we want finer divisions.
    const visibleDuration = Math.max(visibleEndSec - visibleStartSec, 1e-3);
    const tickStep =
      visibleDuration > 600 ? 60 :
      visibleDuration > 240 ? 30 :
      visibleDuration > 90 ? 10 :
      visibleDuration > 30 ? 5 :
      visibleDuration > 10 ? 1 :
      visibleDuration > 3 ? 0.5 :
      0.1;
    const nextTicks: TickSpec[] = [];
    const firstTick = Math.ceil(visibleStartSec / tickStep) * tickStep;
    for (let t = firstTick; t <= visibleEndSec + 1e-6; t += tickStep) {
      nextTicks.push({
        leftPx: t * pxPerSecond,
        label: tickStep < 1
          ? formatTimecode(t, { ms: true })
          : formatTimecode(t, { ms: false }),
      });
    }
    return { bars: nextBars, ticks: nextTicks };
  }, [project, pxPerSecond, selectedWordIds, visibleEndSec, visibleStartSec]);

  // ── Pointer geometry ─────────────────────────────────────────────────────
  function outputTimeFromPointer(e: React.MouseEvent<HTMLDivElement>) {
    const rail = railRef.current;
    if (!rail || railWidth <= 0) return null;
    const rect = rail.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.max(0, Math.min(duration, (x / railWidth) * duration));
  }

  function seekToOutputTime(outputTime: number) {
    if (!firstMedia) return;
    const mapped = outputTimeToSource(project, outputTime);
    if (!mapped) return;
    setCurrentTime(outputTime);
    window.dispatchEvent(
      new CustomEvent("scribe:seek-source", {
        detail: { start: mapped.sourceTime, mediaId: mapped.segment.mediaId },
      }),
    );
    usePlayerStore.getState().setPlaying(true);
  }

  function updateSelection(markIn: number, markOut: number) {
    setTimelineRange(markIn, markOut);
    setSelectedWordIds(wordIdsInOutputRange(project, markIn, markOut));
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const outputTime = outputTimeFromPointer(e);
    if (outputTime === null) return;
    setDragStart(outputTime);
    setDragging(false);
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (dragStart === null) return;
    const outputTime = outputTimeFromPointer(e);
    if (outputTime === null) return;
    if (Math.abs(outputTime - dragStart) > 0.05) setDragging(true);
    updateSelection(dragStart, outputTime);
  }

  function handleMouseUp(e: React.MouseEvent<HTMLDivElement>) {
    const outputTime = outputTimeFromPointer(e);
    if (outputTime === null) return;
    if (!dragging || dragStart === null) {
      seekToOutputTime(outputTime);
    } else {
      updateSelection(dragStart, outputTime);
    }
    setDragStart(null);
    setDragging(false);
  }

  // ── Minimap interaction (only shown when zoomed) ──────────────────────────
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const minimapJumpTo = useCallback(
    (clientX: number) => {
      const el = minimapRef.current;
      const scroll = scrollRef.current;
      if (!el || !scroll || duration <= 0) return;
      const rect = el.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const target = fraction * railWidth - scroll.clientWidth / 2;
      scroll.scrollLeft = Math.max(0, target);
    },
    [duration, railWidth],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  if (!firstMedia) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Timeline appears once media is loaded
      </div>
    );
  }

  if (duration <= 0) {
    return (
      <div className="timeline-panel flex items-center justify-center text-xs text-muted-foreground">
        Transcribe to build an editable output timeline
      </div>
    );
  }

  const playheadLeftPx = currentTime * pxPerSecond;
  const hasTimelineRange = timelineMarkIn !== null && timelineMarkOut !== null;
  const markInPx = timelineMarkIn !== null ? timelineMarkIn * pxPerSecond : null;
  const markOutPx = timelineMarkOut !== null ? timelineMarkOut * pxPerSecond : null;
  const selectionStartPx = hasTimelineRange
    ? Math.min(timelineMarkIn!, timelineMarkOut!) * pxPerSecond
    : 0;
  const selectionWidthPx = hasTimelineRange
    ? Math.abs(timelineMarkOut! - timelineMarkIn!) * pxPerSecond
    : 0;

  // Minimap rectangle — fraction of full duration visible.
  const visibleFraction = railWidth > 0 ? Math.min(1, containerWidth / railWidth) : 1;
  const minimapWindowLeft = railWidth > 0 ? (scrollLeft / railWidth) * MINIMAP_WIDTH_PX : 0;
  const minimapWindowWidth = visibleFraction * MINIMAP_WIDTH_PX;
  const minimapPlayheadLeft =
    duration > 0 ? (currentTime / duration) * MINIMAP_WIDTH_PX : 0;

  return (
    <div className="timeline-panel">
      <div className="timeline-header">
        <div className="timeline-title">
          Timeline
          <span>
            <i className="legend-audio" /> kept audio
          </span>
          <span>
            <i className="legend-filler" /> filler
          </span>
          <span>
            <i className="legend-selected" /> selected
          </span>
        </div>

        {zoomed && (
          <div
            ref={minimapRef}
            className="timeline-minimap"
            style={{ width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX }}
            onMouseDown={(e) => {
              minimapJumpTo(e.clientX);
              const onMove = (ev: MouseEvent) => minimapJumpTo(ev.clientX);
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
            title="Drag to navigate"
          >
            <div
              className="timeline-minimap-window"
              style={{ left: minimapWindowLeft, width: minimapWindowWidth }}
            />
            <div
              className="timeline-minimap-playhead"
              style={{ left: minimapPlayheadLeft }}
            />
          </div>
        )}

        <div className="timeline-help">
          {zoomed
            ? `drag selects · I/O mark range · ⌘+scroll to zoom · zoom ${timelineZoom.toFixed(1)}x`
            : `drag selects · I/O mark range · zoom ${timelineZoom.toFixed(1)}x`}
        </div>
      </div>

      <div
        ref={scrollRef}
        className={zoomed ? "timeline-scroll is-zoomed" : "timeline-scroll"}
      >
        <div
          ref={railRef}
          className="timeline-rail"
          style={{ width: railWidth || "100%" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <div className="timeline-ticks">
            {ticks.map((tick) => (
              <span key={tick.leftPx.toFixed(2)} style={{ left: tick.leftPx }}>
                {tick.label}
              </span>
            ))}
          </div>
          <div className="timeline-bars">
            {bars.map((bar) => (
              <div
                key={bar.id}
                className={[
                  "timeline-bar",
                  bar.filler ? "is-filler" : "",
                  bar.selected ? "is-selected" : "",
                ].join(" ")}
                style={{
                  left: bar.leftPx,
                  width: bar.widthPx,
                  height: `${bar.height}px`,
                }}
                title={bar.label}
              />
            ))}
          </div>
          {hasTimelineRange && selectionWidthPx > 0.1 && (
            <div
              className="timeline-selection"
              style={{ left: selectionStartPx, width: selectionWidthPx }}
            >
              <span />
              <span />
            </div>
          )}
          {markInPx !== null && (
            <div className="timeline-marker is-in" style={{ left: markInPx }}>
              <span>I</span>
            </div>
          )}
          {markOutPx !== null && (
            <div className="timeline-marker is-out" style={{ left: markOutPx }}>
              <span>O</span>
            </div>
          )}
          <div className="timeline-playhead" style={{ left: playheadLeftPx }}>
            <span />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── local types kept down here to keep the JSX above readable ─────────────
type BarSpec = {
  id: string;
  leftPx: number;
  widthPx: number;
  height: number;
  filler: boolean;
  selected: boolean;
  label: string;
};
type TickSpec = { leftPx: number; label: string };
