/**
 * Output timeline.
 *
 * The video preview plays source media, but this strip is deliberately drawn in
 * output time: once words are deleted, the removed ranges disappear here too.
 * Filler words are highlighted amber so the transcript and timeline agree.
 */

import { useMemo, useRef } from "react";
import { computeTimeline, outputTimeToSource, totalDuration, type Word } from "@/lib/edl";
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
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);

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

  function seekFromPointer(e: React.MouseEvent<HTMLDivElement>) {
    const rail = railRef.current;
    if (!rail || !firstMedia) return;
    const rect = rail.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const outputTime = fraction * duration;
    const mapped = outputTimeToSource(project, outputTime);
    if (!mapped) return;
    setCurrentTime(outputTime);
    window.dispatchEvent(
      new CustomEvent("scribe:seek-source", { detail: { start: mapped.sourceTime } }),
    );
    usePlayerStore.getState().setPlaying(true);
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

  return (
    <div className="timeline-panel">
      <div className="timeline-header">
        <div className="timeline-title">
          Timeline
          <span><i className="legend-audio" /> kept audio</span>
          <span><i className="legend-filler" /> filler</span>
          <span><i className="legend-selected" /> selected</span>
        </div>
        <div className="timeline-help">shift-drag selects words · click timeline to seek</div>
      </div>

      <div ref={railRef} className="timeline-rail" onClick={seekFromPointer}>
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
        <div className="timeline-playhead" style={{ left: `${playheadLeft}%` }}>
          <span />
        </div>
      </div>
    </div>
  );
}
