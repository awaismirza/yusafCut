/**
 * Wires Tauri-emitted transcribe/export/model-download progress events into the
 * UI store so the toolbar progress bars can react.
 */

import { useEffect } from "react";
import {
  onExportProgress,
  onModelDownloadProgress,
  onTranscribeProgress,
} from "@/lib/ipc";
import { useUIStore } from "@/stores/uiStore";

export function useTranscribeProgress() {
  const setTranscribeProgress = useUIStore((s) => s.setTranscribeProgress);
  const setExportingProgress = useUIStore((s) => s.setExportingProgress);
  const setModelDownloadProgress = useUIStore((s) => s.setModelDownloadProgress);

  useEffect(() => {
    let unlistenTranscribe: (() => void) | undefined;
    let unlistenExport: (() => void) | undefined;
    let unlistenModel: (() => void) | undefined;

    void onTranscribeProgress((p) => {
      setTranscribeProgress(p.progress >= 1 ? null : p.progress);
    }).then((fn) => {
      unlistenTranscribe = fn;
    });

    void onExportProgress((p) => {
      setExportingProgress(p.progress >= 1 ? null : p.progress);
    }).then((fn) => {
      unlistenExport = fn;
    });

    void onModelDownloadProgress((p) => {
      setModelDownloadProgress(p.progress >= 1 ? null : p.progress);
    }).then((fn) => {
      unlistenModel = fn;
    });

    return () => {
      unlistenTranscribe?.();
      unlistenExport?.();
      unlistenModel?.();
    };
  }, [setTranscribeProgress, setExportingProgress, setModelDownloadProgress]);
}
