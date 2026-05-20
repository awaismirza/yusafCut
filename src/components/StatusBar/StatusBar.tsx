/**
 * StatusBar — bottom strip showing the active model, transcript metrics, and
 * the current / total timecode. Mirrors the design's footer chrome:
 *
 *   ● CoreML active · whisper-large-v3 · 1,124 words · 17 fillers · 4 deleted
 *                                                         Ready · 00:42.18 / 4:21.05
 */

import { useMemo } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { totalDuration } from "@/lib/edl";
import { formatTimecode } from "@/lib/timecode";
import { FILLER_WORDS } from "@/components/TranscriptEditor/WordNode";

export function StatusBar() {
  const project = useProjectStore((s) => s.project);
  const dirty = useProjectStore((s) => s.dirty);
  const currentTime = usePlayerStore((s) => s.currentTime);

  const { wordCount, fillerCount } = useMemo(() => {
    let words = 0;
    let fillers = 0;
    for (const seg of project.segments) {
      for (const w of seg.words) {
        words++;
        const bare = w.text.toLowerCase().replace(/[\s.,!?;:"'()[\]{}—–-]/g, "");
        if (FILLER_WORDS.has(bare)) fillers++;
      }
    }
    return { wordCount: words, fillerCount: fillers };
  }, [project]);

  const duration = totalDuration(project);

  return (
    <div className="scribe-statusbar">
      <span className="chip">
        <span className="pulse" />
        CoreML active
      </span>
      <span className="sep">·</span>
      <span>whisper-large-v3</span>
      {wordCount > 0 && (
        <>
          <span className="sep">·</span>
          <span>
            {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}
          </span>
          <span className="sep">·</span>
          <span>
            {fillerCount} filler{fillerCount === 1 ? "" : "s"}
          </span>
        </>
      )}
      <div className="spacer" />
      <span>{dirty ? "Unsaved" : "Ready"}</span>
      <span className="sep">·</span>
      <span>
        {formatTimecode(currentTime, { ms: false })}
        <span style={{ opacity: 0.5 }}> / </span>
        {formatTimecode(duration, { ms: false })}
      </span>
    </div>
  );
}
