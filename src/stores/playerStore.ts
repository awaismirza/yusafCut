/**
 * Player state — current playback position in *output time*, play/pause, and a
 * shared reference to the underlying <video> element. Components subscribe to
 * `currentTime` to highlight the active word, etc.
 *
 * The actual playback machinery lives in `<VideoPreview />` — this store just
 * holds the state and exposes imperative seek().
 */

import { create } from "zustand";

interface PlayerState {
  /** Current output-time position in seconds. */
  currentTime: number;
  /** True while audio/video is playing. */
  playing: boolean;
  /** The Selection range of active word IDs (inclusive set). */
  selectedWordIds: Set<string>;
  /** Whether the user has muted audio. */
  muted: boolean;
  /** Playback rate. */
  rate: number;

  // Setters used by the <video> element / transcript editor
  setCurrentTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setSelectedWordIds: (ids: Iterable<string>) => void;
  toggleMuted: () => void;
  setRate: (r: number) => void;
  reset: () => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentTime: 0,
  playing: false,
  selectedWordIds: new Set(),
  muted: false,
  rate: 1.0,

  setCurrentTime: (t) => set({ currentTime: t }),
  setPlaying: (p) => set({ playing: p }),
  setSelectedWordIds: (ids) => set({ selectedWordIds: new Set(ids) }),
  toggleMuted: () => set((s) => ({ muted: !s.muted })),
  setRate: (r) => set({ rate: r }),
  reset: () =>
    set({
      currentTime: 0,
      playing: false,
      selectedWordIds: new Set(),
      muted: false,
      rate: 1.0,
    }),
}));
