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
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setSelectedWordIds = usePlayerStore((s) => s.setSelectedWordIds);
  const setTimelineRange = usePlayerStore((s) => s.setTimelineRange);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const firstMedia = Object.values(project.media)[0];
  const duration = totalDuration(project);

  const { bars, ticks } = useMemo(() => {
    const timeline = computeTimeline(project);
    const outDuration = Math.max(totalDuration(project), 0.001);
    let wordIndex = 0;
    const nextBars = timeline.flatMap((entry) => {
      const segment = project.segments.find((s) => s.id === entry.segmentId);
      if (!segment) return [];
      return segment.words.map((word) => {
        const outputStart = entry.outputStart + Math.max(0, word.start - entry.sourceIn);
        const outputEnd = entry.outputStart + Math.max(0, word.end - entry.sourceIn);
        const width = Math.max(0.2, ((outputEnd - outputStart) / outDuration) * 100);
        const left = (outputStart / outDuration) * 100;
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
      });
    });

    const tickStep = outDuration > 180 ? 30 : outDuration > 60 ? 10 : 5;
    const nextTicks: { left: number; label: string }[] = [];
    for (let t = 0; t <= outDuration; t += tickStep) {
      nextTicks.push({ left: (t / outDuration) * 100, label: formatTimecode(t, { ms: false }) });
    }
    return { bars: nextBars, ticks: nextTicks };
  }, [project, selectedWordIds]);

  function outputTimeFromPointer(e: React.MouseEvent<HTMLDivElement>) {
    const rail = railRef.current;
    if (!rail) return null;
    const rect = rail.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return fraction * duration;
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

  if (duration <= 0 || bars.length === 0) {
    return (
      <div className="timeline-panel flex items-center justify-center text-xs text-muted-foreground">
        Transcribe to build an editable output timeline
      </div>
    );
  }

  const playheadLeft = Math.max(0, Math.min(100, (currentTime / duration) * 100));
  const hasTimelineRange = timelineMarkIn !== null && timelineMarkOut !== null;
  const markInLeft = timelineMarkIn !== null ? (timelineMarkIn / duration) * 100 : null;
  const markOutLeft = timelineMarkOut !== null ? (timelineMarkOut / duration) * 100 : null;
  const selectionStart = hasTimelineRange
    ? (Math.min(timelineMarkIn!, timelineMarkOut!) / duration) * 100
    : 0;
  const selectionWidth = hasTimelineRange
    ? (Math.abs(timelineMarkOut! - timelineMarkIn!) / duration) * 100
    : 0;

  return (
    <div className="timeline-panel">
      <div className="timeline-header">
        <div className="timeline-title">
          Timeline
          <span><i className="legend-audio" /> kept audio</span>
          <span><i className="legend-filler" /> filler</span>
          <span><i className="legend-selected" /> selected</span>
        </div>
        <div className="timeline-help">drag selects · I/O mark range · Cmd+Delete ripple deletes</div>
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
