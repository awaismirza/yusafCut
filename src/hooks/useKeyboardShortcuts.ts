/**
 * Global keyboard shortcuts (per spec Phase 7):
 *   Space         play/pause
 *   J / K / L     transport (rewind / pause / forward)
 *   Cmd+Z         undo
 *   Shift+Cmd+Z   redo
 *   Cmd+S         save  (caller wires the toolbar button)
 *   Cmd+E         export
 *   Delete        cut selected transcript words
 */

import { useEffect } from "react";
import { usePlayerStore } from "@/stores/playerStore";
import { useProjectStore, useTemporalProjectStore } from "@/stores/projectStore";
import { wordIdToOutputTime, wordIdsInOutputRange } from "@/lib/edl";

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

const SHUTTLE_RATES = [1, 1.2, 1.5, 1.8, 2] as const;

function nextShuttleRate(current: number) {
  const idx = SHUTTLE_RATES.findIndex((rate) => rate > current + 0.01);
  return idx === -1 ? SHUTTLE_RATES[SHUTTLE_RATES.length - 1] : SHUTTLE_RATES[idx]!;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inTextField =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      const mod = isMac() ? e.metaKey : e.ctrlKey;

      // Space: play/pause — only when not typing in a text field
      if (e.key === " " && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        const willPause = s.playing;
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
        if (willPause) s.setRate(1);
        window.dispatchEvent(new CustomEvent("scribe:toggle-play"));
        return;
      }

      if (e.key.toLowerCase() === "j" && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        const nextRate = e.shiftKey ? 0.5 : nextShuttleRate(s.playing ? s.rate : 0);
        s.setRate(nextRate);
        window.dispatchEvent(
          new CustomEvent("scribe:seek-output", {
            detail: { time: Math.max(0, s.currentTime - 3 * nextRate), play: true },
          }),
        );
        return;
      }
      if (e.key.toLowerCase() === "k" && !inTextField) {
        e.preventDefault();
        usePlayerStore.getState().setRate(1);
        window.dispatchEvent(new CustomEvent("scribe:pause"));
        return;
      }
      if (e.key.toLowerCase() === "l" && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        const nextRate = nextShuttleRate(s.playing ? s.rate : 0);
        s.setRate(nextRate);
        window.dispatchEvent(new CustomEvent("scribe:play"));
        return;
      }

      if (e.key.toLowerCase() === "i" && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        s.setTimelineRange(s.currentTime, s.timelineMarkOut);
        if (s.timelineMarkOut !== null) {
          s.setSelectedWordIds(
            wordIdsInOutputRange(
              useProjectStore.getState().project,
              s.currentTime,
              s.timelineMarkOut,
            ),
          );
        }
        return;
      }

      if (e.key.toLowerCase() === "o" && !inTextField) {
        e.preventDefault();
        const s = usePlayerStore.getState();
        s.setTimelineRange(s.timelineMarkIn, s.currentTime);
        if (s.timelineMarkIn !== null) {
          s.setSelectedWordIds(
            wordIdsInOutputRange(
              useProjectStore.getState().project,
              s.timelineMarkIn,
              s.currentTime,
            ),
          );
        }
        return;
      }

      if (e.key.toLowerCase() === "x" && !inTextField) {
        const s = usePlayerStore.getState();
        if (s.timelineMarkIn === null && s.timelineMarkOut === null && s.selectedWordIds.size === 0)
          return;
        e.preventDefault();
        s.clearTimelineRange();
        s.setSelectedWordIds([]);
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
          const seekTo = Math.min(player.timelineMarkIn!, player.timelineMarkOut!);
          projectStore.deleteOutputRange(player.timelineMarkIn!, player.timelineMarkOut!);
          player.clearTimelineRange();
          player.setSelectedWordIds([]);
          player.setCurrentTime(seekTo);
          window.dispatchEvent(
            new CustomEvent("scribe:seek-output", { detail: { time: seekTo, play: false } }),
          );
          return;
        }
        projectStore.deleteWords(selectedIds);
        player.setSelectedWordIds([]);
        return;
      }

      if (!mod && (e.key === "Backspace" || e.key === "Delete") && !inTextField) {
        const player = usePlayerStore.getState();
        const projectStore = useProjectStore.getState();
        const selectedIds = [...player.selectedWordIds];
        if (selectedIds.length === 0) return;
        e.preventDefault();
        projectStore.deleteWords(selectedIds);
        player.setSelectedWordIds([]);
        window.getSelection()?.removeAllRanges();
        return;
      }

      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        const temporal = useProjectStore.temporal.getState();
        if (temporal.pastStates.length === 0) return;
        e.preventDefault();
        temporal.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && e.shiftKey) {
        const temporal = useProjectStore.temporal.getState();
        if (temporal.futureStates.length === 0) return;
        e.preventDefault();
        temporal.redo();
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
