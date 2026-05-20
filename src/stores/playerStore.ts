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
  /** Output-time in/out selection from the timeline. */
  timelineMarkIn: number | null;
  timelineMarkOut: number | null;
  /** Visual zoom level for the output timeline. 1 = full timeline. */
  timelineZoom: number;

  // Setters used by the <video> element / transcript editor
  setCurrentTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setSelectedWordIds: (ids: Iterable<string>) => void;
  toggleMuted: () => void;
  setRate: (r: number) => void;
  setTimelineRange: (markIn: number | null, markOut: number | null) => void;
  clearTimelineRange: () => void;
  setTimelineZoom: (zoom: number) => void;
  reset: () => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentTime: 0,
  playing: false,
  selectedWordIds: new Set(),
  muted: false,
  rate: 1.0,
  timelineMarkIn: null,
  timelineMarkOut: null,
  timelineZoom: 1,

  setCurrentTime: (t) => set({ currentTime: t }),
  setPlaying: (p) => set({ playing: p }),
  setSelectedWordIds: (ids) => set({ selectedWordIds: new Set(ids) }),
  toggleMuted: () => set((s) => ({ muted: !s.muted })),
  setRate: (r) => set({ rate: r }),
  setTimelineRange: (markIn, markOut) => set({ timelineMarkIn: markIn, timelineMarkOut: markOut }),
  clearTimelineRange: () => set({ timelineMarkIn: null, timelineMarkOut: null }),
  // Wider zoom range supports the horizontal-scrolling rail introduced in v2.1.
  // 32x lets editors land on individual words on long-form content.
  setTimelineZoom: (zoom) => set({ timelineZoom: Math.max(1, Math.min(32, zoom)) }),
  reset: () =>
    set({
      currentTime: 0,
      playing: false,
      selectedWordIds: new Set(),
      muted: false,
      rate: 1.0,
      timelineMarkIn: null,
      timelineMarkOut: null,
      timelineZoom: 1,
    }),
}));
