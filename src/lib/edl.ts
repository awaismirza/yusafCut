// EDL (Edit Decision List) — the central immutable data model.
//
// Everything in YusafCut is a thin layer over this structure. The transcript view,
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

/** A named jump-point on the OUTPUT timeline. Used for YouTube/podcast chapters. */
export interface Chapter {
  id: string;
  /** Position in seconds on the *output* timeline (post-edits). */
  outputTime: number;
  title: string;
}

/**
 * An audio track laid under the main spoken EDL. Used for music beds, ambient
 * loops, sound effects. Mixed in at export time; never re-encodes the source.
 *
 * Tracks reference `project.media` like any other clip. The mediaId may point
 * to either an audio-only file (mp3 / m4a / wav) or a video — only the audio
 * stream is used.
 *
 * The track plays from `offsetSec` on the OUTPUT timeline. Negative offsets
 * are allowed (track starts before the visible content) and silently clipped
 * at 0 during mixing. `gainDb` is applied before the mix; positive boosts.
 * `ducks` enables sidechain ducking against the main voice — when the speaker
 * is talking the music drops by ~12 dB and recovers on the tail.
 */
export interface AudioTrack {
  id: string;
  mediaId: MediaId;
  /** Volume adjustment in dB. 0 = unity. Negative = quieter. */
  gainDb: number;
  /** When on the output timeline the track begins, in seconds. */
  offsetSec: number;
  /** If true, the main voice ducks this track via sidechain compression. */
  ducks: boolean;
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
  /** Optional — older v2.0 projects don't have this field. Empty by default. */
  chapters?: Chapter[];
  /** Optional — music beds / sfx mixed under the main EDL. Empty by default. */
  audioTracks?: AudioTrack[];
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

/** Given a source time, find its output-time position if that source range survived. */
export function sourceTimeToOutput(
  project: Project,
  mediaId: MediaId,
  sourceTime: number,
): { segment: Segment; outputTime: number } | null {
  const timeline = computeTimeline(project);
  for (const entry of timeline) {
    if (
      entry.mediaId === mediaId &&
      sourceTime >= entry.sourceIn &&
      sourceTime < entry.sourceOut
    ) {
      const segment = project.segments.find((s) => s.id === entry.segmentId);
      if (!segment) return null;
      return { segment, outputTime: entry.outputStart + (sourceTime - entry.sourceIn) };
    }
  }
  return null;
}

/** Map a surviving word id to the output timeline. */
export function wordIdToOutputTime(
  project: Project,
  wordId: string,
): { word: Word; segment: Segment; outputTime: number; sourceTime: number } | null {
  const timeline = computeTimeline(project);
  for (const entry of timeline) {
    const segment = project.segments.find((s) => s.id === entry.segmentId);
    if (!segment) continue;
    const word = segment.words.find((w) => w.id === wordId);
    if (!word) continue;
    const sourceTime = Math.max(entry.sourceIn, Math.min(word.start, entry.sourceOut));
    return {
      word,
      segment,
      sourceTime,
      outputTime: entry.outputStart + (sourceTime - entry.sourceIn),
    };
  }
  return null;
}

/** Return surviving word IDs whose output-time span overlaps the given range. */
export function wordIdsInOutputRange(project: Project, markIn: number, markOut: number): string[] {
  const start = Math.min(markIn, markOut);
  const end = Math.max(markIn, markOut);
  if (end <= start) return [];

  const ids: string[] = [];
  const timeline = computeTimeline(project);
  for (const entry of timeline) {
    const segment = project.segments.find((s) => s.id === entry.segmentId);
    if (!segment) continue;
    for (const word of segment.words) {
      const wordOutStart = entry.outputStart + Math.max(0, word.start - entry.sourceIn);
      const wordOutEnd = entry.outputStart + Math.max(0, word.end - entry.sourceIn);
      if (wordOutStart < end && wordOutEnd > start) ids.push(word.id);
    }
  }
  return ids;
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

/**
 * Remove long silences by splitting segments at every gap > `gapMs` between
 * consecutive surviving words. Each resulting sub-segment keeps `paddingMs`
 * of audio either side of the kept words so consonants don't get clipped.
 *
 * This is a pure EDL operation — no media is re-encoded; the player just
 * skips the now-deleted ranges. Safe to call repeatedly; idempotent once
 * every gap is already < gapMs.
 *
 * Returns a tuple of `[nextProject, removedCount]` so callers can show a
 * "trimmed N silences" toast.
 */
export function removeSilences(
  project: Project,
  options: { gapMs?: number; paddingMs?: number } = {},
): [Project, number] {
  const gap = (options.gapMs ?? 600) / 1000;
  const padding = (options.paddingMs ?? project.settings.paddingMs ?? DEFAULT_PADDING_MS) / 1000;

  let removed = 0;
  const nextSegments: Segment[] = [];

  for (const seg of project.segments) {
    if (seg.words.length < 2) {
      nextSegments.push(seg);
      continue;
    }

    // Find indices `i` where the gap between word[i] and word[i+1] is too big.
    const gapBoundaries: number[] = [];
    for (let i = 0; i < seg.words.length - 1; i++) {
      const a = seg.words[i]!;
      const b = seg.words[i + 1]!;
      if (b.start - a.end > gap) gapBoundaries.push(i);
    }

    if (gapBoundaries.length === 0) {
      nextSegments.push(seg);
      continue;
    }

    removed += gapBoundaries.length;
    // Slice the word list at each gap and emit one Segment per run.
    let runStart = 0;
    for (let k = 0; k <= gapBoundaries.length; k++) {
      const runEnd = k < gapBoundaries.length ? gapBoundaries[k]! + 1 : seg.words.length;
      const runWords = seg.words.slice(runStart, runEnd);
      const firstWord = runWords[0]!;
      const lastWord = runWords[runWords.length - 1]!;
      const isFirstRun = k === 0;
      const isLastRun = k === gapBoundaries.length;

      const sourceIn = isFirstRun
        ? seg.sourceIn
        : Math.max(seg.sourceIn, firstWord.start - padding);
      const sourceOut = isLastRun
        ? seg.sourceOut
        : Math.min(seg.sourceOut, lastWord.end + padding);

      nextSegments.push({
        id: uuidv4(),
        mediaId: seg.mediaId,
        words: runWords,
        sourceIn,
        sourceOut,
      });
      runStart = runEnd;
    }
  }

  if (removed === 0) return [project, 0];
  return [
    { ...project, segments: nextSegments, updatedAt: new Date().toISOString() },
    removed,
  ];
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

// ---------------------------------------------------------------------------
// Chapters — pure helpers. All return a new Project; never mutate.
// ---------------------------------------------------------------------------

/** Read chapters defensively — handles older projects without the field. */
export function projectChapters(project: Project): Chapter[] {
  return project.chapters ?? [];
}

/** Add a chapter at the given output-time. Returns a new project; chapters are
 * stored in ascending outputTime order so the timeline and exporter don't have
 * to re-sort. Duplicate times are allowed (one wins; the user can rename). */
export function addChapter(project: Project, outputTime: number, title = "Chapter"): Project {
  const id = uuidv4();
  const chapter: Chapter = {
    id,
    outputTime: Math.max(0, Math.min(outputTime, totalDuration(project))),
    title: title.trim() || "Chapter",
  };
  const next = [...projectChapters(project), chapter].sort((a, b) => a.outputTime - b.outputTime);
  return { ...project, chapters: next, updatedAt: new Date().toISOString() };
}

export function removeChapter(project: Project, id: string): Project {
  const next = projectChapters(project).filter((c) => c.id !== id);
  if (next.length === projectChapters(project).length) return project;
  return { ...project, chapters: next, updatedAt: new Date().toISOString() };
}

export function renameChapter(project: Project, id: string, title: string): Project {
  const next = projectChapters(project).map((c) =>
    c.id === id ? { ...c, title: title.trim() || "Chapter" } : c,
  );
  return { ...project, chapters: next, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Audio tracks — pure helpers. All return a new Project; never mutate.
// ---------------------------------------------------------------------------

/** Read audio tracks defensively — older projects don't have the field. */
export function projectAudioTracks(project: Project): AudioTrack[] {
  return project.audioTracks ?? [];
}

/** Add a new music bed / sfx track. The media must already be in
 * `project.media`. Returns a new project. */
export function addAudioTrack(
  project: Project,
  track: Omit<AudioTrack, "id"> & { id?: string },
): Project {
  if (!project.media[track.mediaId]) {
    throw new Error(`audio track references unknown media: ${track.mediaId}`);
  }
  const next: AudioTrack = {
    id: track.id ?? uuidv4(),
    mediaId: track.mediaId,
    gainDb: clampGain(track.gainDb),
    offsetSec: Number.isFinite(track.offsetSec) ? track.offsetSec : 0,
    ducks: !!track.ducks,
  };
  return {
    ...project,
    audioTracks: [...projectAudioTracks(project), next],
    updatedAt: new Date().toISOString(),
  };
}

export function removeAudioTrack(project: Project, id: string): Project {
  const tracks = projectAudioTracks(project);
  const next = tracks.filter((t) => t.id !== id);
  if (next.length === tracks.length) return project;
  return { ...project, audioTracks: next, updatedAt: new Date().toISOString() };
}

export function updateAudioTrack(
  project: Project,
  id: string,
  patch: Partial<Omit<AudioTrack, "id" | "mediaId">>,
): Project {
  const tracks = projectAudioTracks(project);
  const idx = tracks.findIndex((t) => t.id === id);
  if (idx === -1) return project;
  const cur = tracks[idx]!;
  const next: AudioTrack = {
    ...cur,
    ...patch,
    gainDb: patch.gainDb !== undefined ? clampGain(patch.gainDb) : cur.gainDb,
    offsetSec:
      patch.offsetSec !== undefined && Number.isFinite(patch.offsetSec)
        ? patch.offsetSec
        : cur.offsetSec,
  };
  const out = tracks.slice();
  out[idx] = next;
  return { ...project, audioTracks: out, updatedAt: new Date().toISOString() };
}

/** Clamp gain to a sensible range: -60 dB (effectively silent) to +12 dB. */
function clampGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(-60, Math.min(12, db));
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
    chapters: [],
    audioTracks: [],
  };
}
