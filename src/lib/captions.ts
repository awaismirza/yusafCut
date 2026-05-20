/**
 * Build SRT and WebVTT caption strings from a Project, using output-time
 * (so deleted ranges and re-ordered segments are reflected exactly the way
 * they will play back in the exported video).
 *
 * Words are grouped into cues by:
 *  - a gap heuristic: any silence > GAP_S between consecutive words starts a
 *    new cue;
 *  - a length cap: cues are split when they would exceed MAX_CUE_S of speech
 *    or MAX_CUE_WORDS words.
 *
 * The grouping is deliberately conservative — punctuation-aware sentence splits
 * would need an NLP pass; this version produces broadcast-style readable cues
 * that map cleanly to the editor's word boundaries.
 */

import { computeTimeline, type Project, type Word } from "./edl";

const GAP_S = 0.7;
const MAX_CUE_S = 5;
const MAX_CUE_WORDS = 14;

export interface CaptionCue {
  /** 1-based index, matches the cue numbering in .srt. */
  index: number;
  /** Output-time start (seconds). */
  start: number;
  /** Output-time end (seconds). */
  end: number;
  /** Cleaned-up text, no leading/trailing whitespace. */
  text: string;
}

interface OutputWord {
  word: Word;
  start: number; // output-time
  end: number;
}

/**
 * Walk the project's timeline in output order and emit every surviving word
 * with its output-time bounds. We intentionally do *not* dedupe identical
 * texts — captions need to match what's spoken, not what's unique.
 */
export function flattenWordsInOutputTime(project: Project): OutputWord[] {
  const out: OutputWord[] = [];
  for (const entry of computeTimeline(project)) {
    const segment = project.segments.find((s) => s.id === entry.segmentId);
    if (!segment) continue;
    for (const word of segment.words) {
      // Clamp word time to the surviving segment range (we trim words that the
      // user kept but whose timing falls outside the segment's source bounds).
      const clampedStart = Math.max(word.start, entry.sourceIn);
      const clampedEnd = Math.min(word.end, entry.sourceOut);
      if (clampedEnd <= clampedStart) continue;
      out.push({
        word,
        start: entry.outputStart + (clampedStart - entry.sourceIn),
        end: entry.outputStart + (clampedEnd - entry.sourceIn),
      });
    }
  }
  return out;
}

/** Group an output-time word list into reading-paced caption cues. */
export function buildCues(project: Project): CaptionCue[] {
  const words = flattenWordsInOutputTime(project);
  if (words.length === 0) return [];

  const cues: CaptionCue[] = [];
  let currentWords: OutputWord[] = [words[0]!];

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const cur = words[i]!;
    const gap = cur.start - prev.end;
    const cueDuration = prev.end - currentWords[0]!.start;
    const tooLong = cueDuration >= MAX_CUE_S;
    const tooWordy = currentWords.length >= MAX_CUE_WORDS;
    const bigGap = gap >= GAP_S;
    const sentenceEnd = /[.!?]$/.test(prev.word.text.trim());

    if (bigGap || tooLong || tooWordy || (sentenceEnd && cueDuration > 1.2)) {
      cues.push(makeCue(cues.length + 1, currentWords));
      currentWords = [cur];
    } else {
      currentWords.push(cur);
    }
  }
  cues.push(makeCue(cues.length + 1, currentWords));
  return cues;
}

function makeCue(index: number, words: OutputWord[]): CaptionCue {
  const text = words
    .map((w) => w.word.text)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1") // tighten punctuation
    .trim();
  return {
    index,
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text,
  };
}

// ── Formatters ─────────────────────────────────────────────────────────────

/** SRT uses comma as the decimal separator: 00:00:01,234 */
export function formatSrtTimestamp(t: number): string {
  return formatHmsMs(t, ",");
}

/** WebVTT uses dot: 00:00:01.234 */
export function formatVttTimestamp(t: number): string {
  return formatHmsMs(t, ".");
}

function formatHmsMs(t: number, msSep: "," | "."): string {
  const clamped = Math.max(0, t);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSep}${pad(ms, 3)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Serialise to a complete .srt string. */
export function buildSrt(project: Project): string {
  const cues = buildCues(project);
  if (cues.length === 0) return "";
  return cues
    .map(
      (c) =>
        `${c.index}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}\n`,
    )
    .join("\n");
}

/** Serialise to a complete .vtt string. */
export function buildVtt(project: Project): string {
  const cues = buildCues(project);
  const header = "WEBVTT\n\n";
  if (cues.length === 0) return header;
  return (
    header +
    cues
      .map(
        (c) =>
          `${formatVttTimestamp(c.start)} --> ${formatVttTimestamp(c.end)}\n${c.text}\n`,
      )
      .join("\n")
  );
}
