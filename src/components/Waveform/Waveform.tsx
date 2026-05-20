/**
 * Output timeline.
 *
 * The video preview plays source media, but this strip is deliberately drawn in
 * output time: once words are deleted, the removed ranges disappear here too.
 * Filler words are highlighted amber so the transcript and timeline agree.
 */

import { useMemo, useRef, useState } from "react";
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

export function Waveform() {
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
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const firstMedia = Object.values(project.media)[0];
  const duration = totalDuration(project);
  const visibleDuration = duration > 0 ? duration / timelineZoom : 0;
  const windowStart = Math.max(
    0,
    Math.min(Math.max(0, duration - visibleDuration), currentTime - visibleDuration / 2),
  );
  const windowEnd = windowStart + visibleDuration;

  const { bars, ticks } = useMemo(() => {
    const timeline = computeTimeline(project);
    const outDuration = Math.max(totalDuration(project), 0.001);
    const zoom = Math.max(1, timelineZoom);
    const viewportDuration = outDuration / zoom;
    const viewportStart = Math.max(
      0,
      Math.min(Math.max(0, outDuration - viewportDuration), currentTime - viewportDuration / 2),
    );
    const viewportEnd = viewportStart + viewportDuration;
    let wordIndex = 0;
    const nextBars = timeline.flatMap((entry) => {
      const segment = project.segments.find((s) => s.id === entry.segmentId);
      if (!segment) return [];
      return segment.words
        .map((word) => {
          const outputStart = entry.outputStart + Math.max(0, word.start - entry.sourceIn);
          const outputEnd = entry.outputStart + Math.max(0, word.end - entry.sourceIn);
          if (outputEnd < viewportStart || outputStart > viewportEnd) return null;
          const clippedStart = Math.max(outputStart, viewportStart);
          const clippedEnd = Math.min(outputEnd, viewportEnd);
          const width = Math.max(0.2, ((clippedEnd - clippedStart) / viewportDuration) * 100);
          const left = ((clippedStart - viewportStart) / viewportDuration) * 100;
          const idx = wordIndex++;
          return {
            id: word.id,
            left,
            width,
            height: amplitude(word, idx),
            filler: isFiller(word),
            selected: selectedWordIds.has(word.id),
            label: word.text,
          };
        })
        .filter((bar): bar is NonNullable<typeof bar> => bar !== null);
    });

    const tickStep =
      viewportDuration > 180 ? 30 : viewportDuration > 60 ? 10 : viewportDuration > 20 ? 5 : 1;
    const nextTicks: { left: number; label: string }[] = [];
    const firstTick = Math.ceil(viewportStart / tickStep) * tickStep;
    for (let t = firstTick; t <= viewportEnd + 1e-6; t += tickStep) {
      nextTicks.push({
        left: ((t - viewportStart) / viewportDuration) * 100,
        label: formatTimecode(t, { ms: false }),
      });
    }
    return { bars: nextBars, ticks: nextTicks };
  }, [currentTime, project, selectedWordIds, timelineZoom]);

  function outputTimeFromPointer(e: React.MouseEvent<HTMLDivElement>) {
    const rail = railRef.current;
    if (!rail) return null;
    const rect = rail.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return windowStart + fraction * visibleDuration;
  }

  function seekToOutputTime(outputTime: number) {
    if (!firstMedia) return;
    const mapped = outputTimeToSource(project, outputTime);
    if (!mapped) return;
    setCurrentTime(outputTime);
    window.dispatchEvent(
      new CustomEvent("scribe:seek-source", { detail: { start: mapped.sourceTime } }),
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

  const playheadLeft = Math.max(
    0,
    Math.min(100, ((currentTime - windowStart) / visibleDuration) * 100),
  );
  const hasTimelineRange = timelineMarkIn !== null && timelineMarkOut !== null;
  const markInLeft =
    timelineMarkIn !== null && timelineMarkIn >= windowStart && timelineMarkIn <= windowEnd
      ? ((timelineMarkIn - windowStart) / visibleDuration) * 100
      : null;
  const markOutLeft =
    timelineMarkOut !== null && timelineMarkOut >= windowStart && timelineMarkOut <= windowEnd
      ? ((timelineMarkOut - windowStart) / visibleDuration) * 100
      : null;
  const selectionVisibleStart = hasTimelineRange
    ? Math.max(windowStart, Math.min(timelineMarkIn!, timelineMarkOut!))
    : 0;
  const selectionVisibleEnd = hasTimelineRange
    ? Math.min(windowEnd, Math.max(timelineMarkIn!, timelineMarkOut!))
    : 0;
  const selectionStart = hasTimelineRange
    ? ((selectionVisibleStart - windowStart) / visibleDuration) * 100
    : 0;
  const selectionWidth = hasTimelineRange
    ? ((selectionVisibleEnd - selectionVisibleStart) / visibleDuration) * 100
    : 0;

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
        <div className="timeline-help">
          drag selects · I/O mark range · zoom {timelineZoom.toFixed(1)}x
        </div>
      </div>

      <div
        ref={railRef}
        className="timeline-rail"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <div className="timeline-ticks">
          {ticks.map((tick) => (
            <span key={tick.label} style={{ left: `${tick.left}%` }}>
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
                left: `${bar.left}%`,
                width: `${bar.width}%`,
                height: `${bar.height}px`,
              }}
              title={bar.label}
            />
          ))}
        </div>
        {hasTimelineRange && selectionWidth > 0.1 && (
          <div
            className="timeline-selection"
            style={{ left: `${selectionStart}%`, width: `${selectionWidth}%` }}
          >
            <span />
            <span />
          </div>
        )}
        {markInLeft !== null && (
          <div className="timeline-marker is-in" style={{ left: `${markInLeft}%` }}>
            <span>I</span>
          </div>
        )}
        {markOutLeft !== null && (
          <div className="timeline-marker is-out" style={{ left: `${markOutLeft}%` }}>
            <span>O</span>
          </div>
        )}
        <div className="timeline-playhead" style={{ left: `${playheadLeft}%` }}>
          <span />
        </div>
      </div>
    </div>
  );
}
