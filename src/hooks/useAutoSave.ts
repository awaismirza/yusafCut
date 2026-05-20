/**
 * Auto-save (spec Phase 5):
 *   - Every 30 seconds while dirty
 *   - Debounced 2s after the most recent edit
 *   - Atomic write (delegated to Rust)
 *
 * No-ops when the project has no on-disk path yet.
 */

import { useEffect, useRef } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { saveProject } from "@/lib/ipc";

const DEBOUNCE_MS = 2000;
const INTERVAL_MS = 30_000;

export function useAutoSave() {
  const project = useProjectStore((s) => s.project);
  const dirty = useProjectStore((s) => s.dirty);
  const filePath = useProjectStore((s) => s.filePath);
  const markSaved = useProjectStore((s) => s.markSaved);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced save on edit
  useEffect(() => {
    if (!dirty || !filePath) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void saveProject(project, filePath).then(() => markSaved(filePath));
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [project, dirty, filePath, markSaved]);

  // Periodic save while dirty
  useEffect(() => {
    if (!filePath) return;
    const interval = setInterval(() => {
      const state = useProjectStore.getState();
      if (state.dirty && state.filePath) {
        void saveProject(state.project, state.filePath).then(() =>
          markSaved(state.filePath!),
        );
      }
    }, INTERVAL_MS);
    return () => clearInterval(interval);
  }, [filePath, markSaved]);
}
