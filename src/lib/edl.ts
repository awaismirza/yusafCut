// EDL (Edit Decision List) — the central immutable data model.
//
// Everything in Scribe is a thin layer over this structure. The transcript view,
// the player, and the export pipeline all derive their state from a Project.
//
// Invariants (must hold after every operation):
//   1. Words are never mutated. Their start/end always refer to the *source* media.
//   2. Source timecodes are immutable.
//   3. Segments are the unit of cut: deleting a word-range splits surrounding segments
//      and drops the middle segment(s).
//   4. All edits are pure EDL transformations — no edit ever touches a video file
//      until export.

import { v4 as uuidv4 } from "uuid";

export type MediaId = string;

export interface SourceMedia {
  id: MediaId;
  path: string;
  duration: number; // seconds
  fps: number;
  width: number;
  height: number;
  audioSampleRate: number;
  sha256: string;
}

export interface Word {
  id: string;
  text: string;
  start: number; // seconds, relative to source media
  end: number;
  confidence: number; // 0..1
  speaker?: string;
}

export interface Segment {
  id: string;
  mediaId: MediaId;
  words: Word[];
  sourceIn: number;
  sourceOut: number;
}

export type ExportPreset = "youtube-1080p" | "podcast-audio" | "custom";

export interface ProjectSettings {
  exportPreset: ExportPreset;
  paddingMs: number; // default audio padding around cuts
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  media: Record<MediaId, SourceMedia>;
  segments: Segment[];
  settings: ProjectSettings;
}

export interface TimelineEntry {
  segmentId: string;
  mediaId: MediaId;
  sourceIn: number;
  sourceOut: number;
  outputStart: number;
  outputEnd: number;
}

// ---------------------------------------------------------------------------
// Pure functions over Project / Segment / Word
// ---------------------------------------------------------------------------

/** Default padding (in seconds) added around the boundaries of a cut to avoid
 * clipped consonants. Mirrors `settings.paddingMs` (ms) when applied. */
export const DEFAULT_PADDING_MS = 80;

/** Total duration of the output timeline in seconds. */
export function totalDuration(project: Project): number {
  return project.segments.reduce(
    (acc, seg) => acc + Math.max(0, seg.sourceOut - seg.sourceIn),
    0,
  );
}

/**
 * Compute output timecodes for each segment by concatenating in order.
 * This is the single source of truth for mapping source-time → output-time.
 */
export function computeTimeline(project: Project): TimelineEntry[] {
  let outputCursor = 0;
  const result: TimelineEntry[] = [];
  for (const seg of project.segments) {
    const segDuration = Math.max(0, seg.sourceOut - seg.sourceIn);
    result.push({
      segmentId: seg.id,
      mediaId: seg.mediaId,
      sourceIn: seg.sourceIn,
      sourceOut: seg.sourceOut,
      outputStart: outputCursor,
      outputEnd: outputCursor + segDuration,
    });
    outputCursor += segDuration;
  }
  return result;
}

/** Given an output time, find which segment is playing and where in the source. */
export function outputTimeToSource(
  project: Project,
  outputTime: number,
): { segment: Segment; sourceTime: number } | null {
  const timeline = computeTimeline(project);
  for (const entry of timeline) {
    if (outputTime >= entry.outputStart && outputTime < entry.outputEnd) {
      const segment = project.segments.find((s) => s.id === entry.segmentId);
      if (!segment) return null;
      const sourceTime = entry.sourceIn + (outputTime - entry.outputStart);
      return { segment, sourceTime };
    }
  }
  return null;
}

/** Given a source time within a media file, find the *next* surviving segment
 * for that media (used by the player to skip deleted ranges). Returns null if
 * we're past the last segment for the media. */
export function nextSurvivingSegment(
  project: Project,
  mediaId: MediaId,
  sourceTime: number,
): Segment | null {
  // Segments are stored in *output order* — for "next surviving" we need source order.
  const candidates = project.segments
    .filter((s) => s.mediaId === mediaId)
    .filter((s) => s.sourceIn >= sourceTime);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.sourceIn - b.sourceIn);
  return candidates[0] ?? null;
}

/** Find the word whose [start, end) brackets the given source time. */
export function findWordAtSourceTime(segment: Segment, sourceTime: number): Word | null {
  for (const w of segment.words) {
    if (sourceTime >= w.start && sourceTime < w.end) return w;
  }
  return null;
}

/** Find which segment contains a given word id (and the index of the word within it). */
export function findWord(
  project: Project,
  wordId: string,
): { segment: Segment; segmentIndex: number; wordIndex: number } | null {
  for (let i = 0; i < project.segments.length; i++) {
    const seg = project.segments[i]!;
    const wi = seg.words.findIndex((w) => w.id === wordId);
    if (wi !== -1) return { segment: seg, segmentIndex: i, wordIndex: wi };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutating helpers — always return a *new* Project; never mutate the input.
// ---------------------------------------------------------------------------

/**
 * Split a segment at a given word boundary. Returns up to 2 new segments. The
 * resulting segments share the same mediaId and are sliced at the boundary
 * between word[wordIndex - 1] and word[wordIndex] (so wordIndex=0 leaves the
 * "left" empty and returns just the original; wordIndex=words.length leaves the
 * "right" empty).
 */
export function splitSegmentAtWord(segment: Segment, wordIndex: number): Segment[] {
  if (wordIndex <= 0) return [segment];
  if (wordIndex >= segment.words.length) return [segment];

  const leftWords = segment.words.slice(0, wordIndex);
  const rightWords = segment.words.slice(wordIndex);

  const leftEnd = leftWords[leftWords.length - 1]!.end;
  const rightStart = rightWords[0]!.start;

  // Boundary in source-time: midpoint between the two adjacent words. This is
  // intentionally simple — phase 6 will refine using audio-aware silence detection.
  const boundary = (leftEnd + rightStart) / 2;

  const left: Segment = {
    id: uuidv4(),
    mediaId: segment.mediaId,
    words: leftWords,
    sourceIn: segment.sourceIn,
    sourceOut: Math.min(segment.sourceOut, boundary),
  };
  const right: Segment = {
    id: uuidv4(),
    mediaId: segment.mediaId,
    words: rightWords,
    sourceIn: Math.max(segment.sourceIn, boundary),
    sourceOut: segment.sourceOut,
  };
  return [left, right];
}

/**
 * Delete a set of word IDs from the project. The IDs are expected to be a
 * contiguous range *within a single source media* but the operation tolerates
 * multi-segment ranges and gaps.
 *
 * Algorithm:
 *   1. For each affected segment, partition its words into [keep-left, drop, keep-right].
 *   2. Each non-empty side becomes its own segment.
 *   3. Apply `paddingMs` to the boundary so we keep a small amount of audio either side.
 */
export function deleteWords(project: Project, wordIds: ReadonlySet<string>): Project {
  if (wordIds.size === 0) return project;

  const paddingSec = (project.settings.paddingMs ?? DEFAULT_PADDING_MS) / 1000;
  const nextSegments: Segment[] = [];

  for (const seg of project.segments) {
    // Quick path: nothing to do
    if (!seg.words.some((w) => wordIds.has(w.id))) {
      nextSegments.push(seg);
      continue;
    }

    // Walk the words and break them into runs of (kept|dropped).
    type Run = { kept: boolean; words: Word[] };
    const runs: Run[] = [];
    let current: Run | null = null;
    for (const w of seg.words) {
      const kept = !wordIds.has(w.id);
      if (!current || current.kept !== kept) {
        current = { kept, words: [w] };
        runs.push(current);
      } else {
        current.words.push(w);
      }
    }

    // Convert kept runs into segments with appropriate source-time bounds.
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!;
      if (!run.kept) continue;

      const firstWord = run.words[0]!;
      const lastWord = run.words[run.words.length - 1]!;

      // Source bounds: start at firstWord.start - padding (clamped to seg.sourceIn),
      // end at lastWord.end + padding (clamped to seg.sourceOut).
      // If this run is the very first/last in the segment, use the segment bounds
      // so we don't accidentally shave off pre/post-roll the user explicitly kept.
      const isFirstRun = i === 0;
      const isLastRun = i === runs.length - 1;
      const sourceIn = isFirstRun ? seg.sourceIn : Math.max(seg.sourceIn, firstWord.start - paddingSec);
      const sourceOut = isLastRun ? seg.sourceOut : Math.min(seg.sourceOut, lastWord.end + paddingSec);

      nextSegments.push({
        id: uuidv4(),
        mediaId: seg.mediaId,
        words: run.words,
        sourceIn,
        sourceOut,
      });
    }
  }

  return { ...project, segments: nextSegments, updatedAt: new Date().toISOString() };
}

/**
 * Restore previously deleted words by re-introducing them into the appropriate
 * segment. Because the UI keeps deleted words visible (struck-through), this is
 * the inverse of `deleteWords` for cases when the user re-selects them.
 *
 * NOTE: Phase 4 will refine this. For now, we implement it as "remove these
 * word ids from any explicit delete-tracker and rebuild segments from the
 * original transcript" — which requires the *original* transcript to be kept
 * around. The current EDL does not track deletions explicitly, so restore is
 * implemented at the store level via undo (zundo). This function is a stub for
 * a future explicit-tombstone model.
 */
export function restoreWords(_project: Project, _wordIds: ReadonlySet<string>): Project {
  // Intentionally unimplemented — phase 4 will revisit. Use undo for now.
  throw new Error(
    "restoreWords is not implemented in v1. Use the undo stack (Cmd+Z) to restore deleted words.",
  );
}

/** Add a new source media + initial single-segment-covers-everything EDL. */
export function addMediaWithTranscript(
  project: Project,
  media: SourceMedia,
  words: Word[],
): Project {
  const segment: Segment = {
    id: uuidv4(),
    mediaId: media.id,
    words,
    sourceIn: 0,
    sourceOut: media.duration,
  };
  return {
    ...project,
    media: { ...project.media, [media.id]: media },
    segments: [...project.segments, segment],
    updatedAt: new Date().toISOString(),
  };
}

/** Create a brand new empty project. */
export function newProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: uuidv4(),
    name,
    createdAt: now,
    updatedAt: now,
    media: {},
    segments: [],
    settings: {
      exportPreset: "youtube-1080p",
      paddingMs: DEFAULT_PADDING_MS,
    },
  };
}
