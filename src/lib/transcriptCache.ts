import type { Project, SourceMedia, Word } from "@/lib/edl";

const TRANSCRIPT_CACHE_PREFIX = "yusafcut.transcript.v1.";

function transcriptCacheKey(media: SourceMedia): string {
  return `${TRANSCRIPT_CACHE_PREFIX}${media.sha256}`;
}

export function readTranscriptCache(media: SourceMedia): Word[] | null {
  try {
    const raw = localStorage.getItem(transcriptCacheKey(media));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { words?: Word[] };
    return Array.isArray(parsed.words) ? parsed.words : null;
  } catch {
    return null;
  }
}

export function writeTranscriptCache(media: SourceMedia, words: Word[]) {
  try {
    localStorage.setItem(
      transcriptCacheKey(media),
      JSON.stringify({ mediaSha256: media.sha256, updatedAt: new Date().toISOString(), words }),
    );
  } catch {
    // Cache failure should never block editing.
  }
}

export function clearTranscriptCache(media: SourceMedia) {
  try {
    localStorage.removeItem(transcriptCacheKey(media));
  } catch {
    // Cache failure should never block editing.
  }
}

export function cacheProjectTranscripts(project: Project) {
  for (const media of Object.values(project.media)) {
    const words = project.segments
      .filter((segment) => segment.mediaId === media.id)
      .flatMap((segment) => segment.words);
    if (words.length > 0) writeTranscriptCache(media, words);
  }
}
