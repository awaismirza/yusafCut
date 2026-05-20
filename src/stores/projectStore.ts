/**
 * The project store is the single source of truth for the EDL.
 *
 * Every edit funnels through this store; `zundo` wraps it to give us undo/redo
 * with a 50-step ring buffer (per spec Phase 4).
 *
 * Heuristic: snapshot on every edit. We are not concerned about memory — the
 * EDL is tiny compared to the media files it references.
 */

import { temporal, type TemporalState } from "zundo";
import { create, useStore } from "zustand";
import {
  addMediaWithTranscript,
  deleteWords,
  newProject,
  type Project,
  type SourceMedia,
  type Word,
} from "@/lib/edl";

interface ProjectState {
  project: Project;
  /** True when the project has unsaved changes since the last save. */
  dirty: boolean;
  /** Absolute path on disk; null for an unsaved project. */
  filePath: string | null;

  // Mutations
  setProject: (p: Project) => void;
  rename: (name: string) => void;
  addMediaWithTranscript: (media: SourceMedia, words: Word[]) => void;
  deleteWords: (ids: Iterable<string>) => void;
  /** Delete every word whose text (case-insensitive, punctuation-stripped)
   *  matches one of the given tokens. Returns the count of words removed. */
  deleteWordsByText: (tokens: ReadonlySet<string>) => number;
  /** Replace the text of every word whose token equals `find` (case-insensitive)
   *  with `replace`. Returns the count of replacements made. */
  replaceText: (find: string, replace: string, opts?: { caseSensitive?: boolean; wholeWord?: boolean }) => number;
  markSaved: (path: string) => void;
}

/** Strip surrounding punctuation/whitespace and lowercase. */
function normaliseToken(s: string): string {
  return s
    .trim()
    .replace(/^[\s.,!?;:"'()[\]{}—–-]+|[\s.,!?;:"'()[\]{}—–-]+$/g, "")
    .toLowerCase();
}

export const useProjectStore = create<ProjectState>()(
  temporal(
    (set, _get) => ({
      project: newProject("Untitled"),
      dirty: false,
      filePath: null,

      setProject: (p) => set({ project: p, dirty: true }),

      rename: (name) =>
        set((s) => ({
          project: { ...s.project, name, updatedAt: new Date().toISOString() },
          dirty: true,
        })),

      addMediaWithTranscript: (media, words) =>
        set((s) => ({
          project: addMediaWithTranscript(s.project, media, words),
          dirty: true,
        })),

      deleteWords: (ids) =>
        set((s) => ({
          project: deleteWords(s.project, new Set(ids)),
          dirty: true,
        })),

      deleteWordsByText: (tokens) => {
        let removed = 0;
        const ids: string[] = [];
        const project = _get().project;
        for (const seg of project.segments) {
          for (const w of seg.words) {
            if (tokens.has(normaliseToken(w.text))) {
              ids.push(w.id);
              removed++;
            }
          }
        }
        if (ids.length === 0) return 0;
        set({
          project: deleteWords(project, new Set(ids)),
          dirty: true,
        });
        return removed;
      },

      replaceText: (find, replace, opts) => {
        const caseSensitive = opts?.caseSensitive ?? false;
        const wholeWord = opts?.wholeWord ?? true;
        const needle = caseSensitive ? find : find.toLowerCase();
        if (needle.length === 0) return 0;
        let replaced = 0;
        const project = _get().project;
        const nextSegments = project.segments.map((seg) => ({
          ...seg,
          words: seg.words.map((w) => {
            const haystack = caseSensitive ? w.text : w.text.toLowerCase();
            if (wholeWord) {
              // Whole-word match — compare token without surrounding punctuation
              const norm = caseSensitive
                ? w.text.trim().replace(/^[\s.,!?;:"'()[\]{}—–-]+|[\s.,!?;:"'()[\]{}—–-]+$/g, "")
                : normaliseToken(w.text);
              if (norm === needle) {
                replaced++;
                // Preserve trailing punctuation so the transcript reads naturally
                const trailing = w.text.match(/[\s.,!?;:"'()[\]{}—–-]+$/)?.[0] ?? "";
                return { ...w, text: replace + trailing };
              }
              return w;
            }
            // Substring search
            if (!haystack.includes(needle)) return w;
            const re = caseSensitive
              ? new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
              : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
            const newText = w.text.replace(re, () => {
              replaced++;
              return replace;
            });
            return { ...w, text: newText };
          }),
        }));
        if (replaced === 0) return 0;
        set({
          project: { ...project, segments: nextSegments, updatedAt: new Date().toISOString() },
          dirty: true,
        });
        return replaced;
      },

      markSaved: (path) => set({ dirty: false, filePath: path }),
    }),
    {
      // Per spec: cap undo at 50 steps.
      limit: 50,
      // Only snapshot the `project` field — don't churn the stack on dirty/path changes.
      partialize: (state) => ({ project: state.project }),
      // Throttle bursts (e.g. typed deletes) so we don't fill the stack.
      handleSet: (handleSet) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        return (state) => {
          if (timeout) clearTimeout(timeout);
          timeout = setTimeout(() => handleSet(state), 100);
        };
      },
    },
  ),
);

/** Helper for components to access undo/redo. */
export function useTemporalProjectStore<T>(
  selector: (state: TemporalState<{ project: Project }>) => T,
): T {
  // The temporal store is exposed as a method on the main store.
  return useStore(useProjectStore.temporal, selector);
}
