/**
 * Global keyboard shortcuts (per spec Phase 7):
 *   Space         play/pause
 *   J / K / L     transport (rewind / pause / forward)
 *   Cmd+Z         undo
 *   Shift+Cmd+Z   redo
 *   Cmd+S         save  (caller wires the toolbar button)
 *   Cmd+E         export
 *   Delete        cut selection (handled inside TipTap editor)
 */

import { useEffect } from "react";
import { usePlayerStore } from "@/stores/playerStore";
import { useProjectStore, useTemporalProjectStore } from "@/stores/projectStore";
import { wordIdToOutputTime } from "@/lib/edl";

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inTextField =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      const mod = isMac() ? e.metaKey : e.ctrlKey;

      // Space: play/pause — only when not typing in a text field
      if (e.key === " " && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        if (!s.playing && s.selectedWordIds.size > 0) {
          const project = useProjectStore.getState().project;
          let best: ReturnType<typeof wordIdToOutputTime> = null;
          for (const id of s.selectedWordIds) {
            const mapped = wordIdToOutputTime(project, id);
            if (mapped && (!best || mapped.outputTime < best.outputTime)) best = mapped;
          }
          if (best) {
            window.dispatchEvent(
              new CustomEvent("scribe:seek-source", { detail: { start: best.sourceTime } }),
            );
          }
        }
        s.setPlaying(!s.playing);
        return;
      }

      if (e.key.toLowerCase() === "j" && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        s.setRate(Math.max(0.25, s.rate / 2));
        s.setPlaying(true);
        return;
      }
      if (e.key.toLowerCase() === "k" && !inTextField) {
        e.preventDefault();
        usePlayerStore.getState().setPlaying(false);
        return;
      }
      if (e.key.toLowerCase() === "l" && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        s.setRate(Math.min(4, s.rate * 2));
        s.setPlaying(true);
        return;
      }

      if (e.key.toLowerCase() === "i" && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        s.setTimelineRange(s.currentTime, s.timelineMarkOut);
        return;
      }

      if (e.key.toLowerCase() === "o" && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        s.setTimelineRange(s.timelineMarkIn, s.currentTime);
        return;
      }

      if (mod && (e.key === "Backspace" || e.key === "Delete")) {
        const player = usePlayerStore.getState();
        const projectStore = useProjectStore.getState();
        const hasRange = player.timelineMarkIn !== null && player.timelineMarkOut !== null;
        const selectedIds = [...player.selectedWordIds];
        if (!hasRange && selectedIds.length === 0) return;
        e.preventDefault();
        if (hasRange) {
          projectStore.deleteOutputRange(player.timelineMarkIn!, player.timelineMarkOut!);
          player.clearTimelineRange();
          player.setSelectedWordIds([]);
          return;
        }
        projectStore.deleteWords(selectedIds);
        player.setSelectedWordIds([]);
        return;
      }

      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        useProjectStore.temporal.getState().undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && e.shiftKey) {
        e.preventDefault();
        useProjectStore.temporal.getState().redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("scribe:save"));
        return;
      }
      if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("scribe:export"));
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Touch the temporal hook so tree-shaking can't drop it.
  // This is intentional — useTemporalProjectStore initialises the temporal
  // store even when no other component has subscribed yet.
  void useTemporalProjectStore;
}
