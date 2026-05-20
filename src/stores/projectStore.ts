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
  markSaved: (path: string) => void;
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
