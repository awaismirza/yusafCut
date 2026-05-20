/** Lightweight UI store: toasts, modal state, model-download progress overlay. */

import { create } from "zustand";

export type Toast = {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
};

export type EditorTool = "select";

interface UIState {
  toasts: Toast[];
  exportingProgress: number | null;
  modelDownloadProgress: number | null;
  transcribeProgress: number | null;
  mediaLoading: boolean;
  activeTool: EditorTool;

  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;

  setExportingProgress: (p: number | null) => void;
  setModelDownloadProgress: (p: number | null) => void;
  setTranscribeProgress: (p: number | null) => void;
  setMediaLoading: (loading: boolean) => void;
  setActiveTool: (tool: EditorTool) => void;
}

export const useUIStore = create<UIState>((set) => ({
  toasts: [],
  exportingProgress: null,
  modelDownloadProgress: null,
  transcribeProgress: null,
  mediaLoading: false,
  activeTool: "select",

  pushToast: (t) =>
    set((s) => ({
      toasts: [...s.toasts, { id: crypto.randomUUID(), ...t }],
    })),
  dismissToast: (id) =>
    set((s) => ({
      toasts: s.toasts.filter((t) => t.id !== id),
    })),

  setExportingProgress: (p) => set({ exportingProgress: p }),
  setModelDownloadProgress: (p) => set({ modelDownloadProgress: p }),
  setTranscribeProgress: (p) => set({ transcribeProgress: p }),
  setMediaLoading: (loading) => set({ mediaLoading: loading }),
  setActiveTool: (tool) => set({ activeTool: tool }),
}));
