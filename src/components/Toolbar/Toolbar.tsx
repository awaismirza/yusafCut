import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  downloadModel,
  exportVideo,
  importMedia,
  listModels,
  loadProject,
  onModelDownloadProgress,
  saveProject,
  transcribe,
  type ModelInfo,
  type WhisperModel,
} from "@/lib/ipc";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, Download, FilePlus2, FolderOpen, MicVocal, Save, Scissors } from "lucide-react";
import { formatDuration } from "@/lib/timecode";
import { newProject, totalDuration } from "@/lib/edl";

const MODELS: { name: WhisperModel; label: string; sizeMb: number }[] = [
  { name: "tiny", label: "Tiny (fast, lower accuracy)", sizeMb: 75 },
  { name: "base", label: "Base", sizeMb: 142 },
  { name: "small", label: "Small", sizeMb: 466 },
  { name: "medium", label: "Medium", sizeMb: 1500 },
  { name: "large-v3-turbo", label: "Large v3 Turbo (recommended)", sizeMb: 1600 },
];

export function Toolbar() {
  const project = useProjectStore((s) => s.project);
  const dirty = useProjectStore((s) => s.dirty);
  const filePath = useProjectStore((s) => s.filePath);
  const setProject = useProjectStore((s) => s.setProject);
  const addMediaWithTranscript = useProjectStore((s) => s.addMediaWithTranscript);
  const markSaved = useProjectStore((s) => s.markSaved);

  const transcribeProgress = useUIStore((s) => s.transcribeProgress);
  const exportingProgress = useUIStore((s) => s.exportingProgress);
  const modelDownloadProgress = useUIStore((s) => s.modelDownloadProgress);
  const pushToast = useUIStore((s) => s.pushToast);

  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<WhisperModel>("large-v3-turbo");
  const [installedModels, setInstalledModels] = useState<ModelInfo[]>([]);
  // Which model is currently being downloaded inside the dialog, and its progress.
  const [downloadingModel, setDownloadingModel] = useState<WhisperModel | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const unlistenDownloadRef = useRef<(() => void) | null>(null);

  async function handleOpen() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v", "mkv"] }],
    });
    if (typeof path !== "string") return;
    try {
      const media = await importMedia(path);
      // Initialise an empty transcript — user must press Transcribe.
      addMediaWithTranscript(media, []);
      pushToast({ title: "Media imported", description: media.path });
    } catch (err) {
      pushToast({
        title: "Failed to import media",
        description: String(err),
        variant: "destructive",
      });
    }
  }

  async function refreshModelList() {
    try {
      const info = await listModels();
      setInstalledModels(info);
    } catch {
      setInstalledModels([]);
    }
  }

  async function handleTranscribe() {
    const ids = Object.keys(project.media);
    if (ids.length === 0) {
      pushToast({ title: "Open a video first", variant: "destructive" });
      return;
    }
    await refreshModelList();
    setModelDialogOpen(true);
  }

  /** Download a single model from within the dialog, updating inline progress. */
  async function handleDownloadModel(name: WhisperModel) {
    if (downloadingModel) return; // already downloading something

    setDownloadingModel(name);
    setDownloadProgress(0);

    // Subscribe to download progress events so the inline bar updates live.
    const unlisten = await onModelDownloadProgress((p) => {
      if (p.name === name) setDownloadProgress(p.progress);
    });
    unlistenDownloadRef.current = unlisten;

    try {
      await downloadModel(name);
      // Mark as installed in local state immediately.
      setInstalledModels((prev) =>
        prev.map((m) => (m.name === name ? { ...m, installed: true } : m)),
      );
      // Auto-select the freshly downloaded model.
      setSelectedModel(name);
    } catch (err) {
      pushToast({
        title: "Download failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      unlisten();
      unlistenDownloadRef.current = null;
      setDownloadingModel(null);
      setDownloadProgress(0);
    }
  }

  // Clean up progress listener if the dialog is closed mid-download.
  useEffect(() => {
    if (!modelDialogOpen && unlistenDownloadRef.current) {
      unlistenDownloadRef.current();
      unlistenDownloadRef.current = null;
      setDownloadingModel(null);
      setDownloadProgress(0);
    }
  }, [modelDialogOpen]);

  async function startTranscribe() {
    setModelDialogOpen(false);
    const ids = Object.keys(project.media);
    if (ids.length === 0) return;

    try {
      // ── Step 1: download the model if it isn't on disk yet ──────────────
      const isInstalled = installedModels.find((m) => m.name === selectedModel)?.installed ?? false;
      if (!isInstalled) {
        const modelLabel = MODELS.find((m) => m.name === selectedModel)?.label ?? selectedModel;
        pushToast({
          title: `Downloading ${modelLabel}…`,
          description: "This may take a few minutes. Progress shown in the toolbar.",
        });
        await downloadModel(selectedModel);
        pushToast({ title: "Model downloaded — starting transcription…" });
      }

      // ── Step 2: transcribe ───────────────────────────────────────────────
      const media = project.media[ids[0]!]!;
      const result = await transcribe({
        mediaId: ids[0]!,
        mediaPath: media.path,
        modelName: selectedModel,
        mediaDuration: media.duration,
      });

      // Replace the empty initial transcript with the real words.
      const next = {
        ...project,
        segments: [
          {
            id: crypto.randomUUID(),
            mediaId: media.id,
            words: result.words,
            sourceIn: 0,
            sourceOut: media.duration,
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      setProject(next);
      pushToast({
        title: "Transcription complete",
        description: `${result.words.length} words`,
      });
    } catch (err) {
      pushToast({
        title: "Transcription failed",
        description: String(err),
        variant: "destructive",
      });
    }
  }

  const handleSave = useCallback(async () => {
    let path = filePath;
    if (!path) {
      const next = await saveDialog({
        defaultPath: `${project.name}.scribe`,
        filters: [{ name: "Scribe project", extensions: ["scribe"] }],
      });
      if (!next) return;
      path = next;
    }
    try {
      await saveProject(project, path);
      markSaved(path);
      pushToast({ title: "Saved" });
    } catch (err) {
      pushToast({
        title: "Save failed",
        description: String(err),
        variant: "destructive",
      });
    }
  }, [filePath, project, markSaved, pushToast]);

  const handleExport = useCallback(async () => {
    const outPath = await saveDialog({
      defaultPath: `${project.name}.mp4`,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!outPath) return;
    try {
      await exportVideo({
        project,
        outputPath: outPath,
        preset: project.settings.exportPreset,
      });
      pushToast({ title: "Export complete", description: outPath });
    } catch (err) {
      pushToast({
        title: "Export failed",
        description: String(err),
        variant: "destructive",
      });
    }
  }, [project, pushToast]);

  useEffect(() => {
    window.addEventListener("scribe:save", handleSave);
    window.addEventListener("scribe:export", handleExport);
    return () => {
      window.removeEventListener("scribe:save", handleSave);
      window.removeEventListener("scribe:export", handleExport);
    };
  }, [handleSave, handleExport]);

  return (
    <div className="flex h-12 items-center gap-1 border-b border-border bg-background px-3">
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={handleOpen}>
          <FolderOpen className="mr-1 h-4 w-4" /> Open
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setProject(newProject("Untitled"))}>
          <FilePlus2 className="mr-1 h-4 w-4" /> New
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const path = await openDialog({
              multiple: false,
              filters: [{ name: "Scribe project", extensions: ["scribe"] }],
            });
            if (typeof path !== "string") return;
            try {
              const loaded = await loadProject(path);
              setProject(loaded);
              markSaved(path);
              pushToast({ title: "Project opened", description: path });
            } catch (err) {
              pushToast({
                title: "Failed to open project",
                description: String(err),
                variant: "destructive",
              });
            }
          }}
        >
          <FolderOpen className="mr-1 h-4 w-4" /> Open Project
        </Button>
        <Button size="sm" variant="ghost" onClick={handleSave}>
          <Save className="mr-1 h-4 w-4" /> Save {dirty && "*"}
        </Button>
      </div>

      <div className="ml-4 flex items-center gap-1 border-l border-border pl-4">
        <Button size="sm" variant="ghost" onClick={handleTranscribe}>
          <MicVocal className="mr-1 h-4 w-4" /> Transcribe
        </Button>
        <Button size="sm" variant="ghost" onClick={handleExport}>
          <Download className="mr-1 h-4 w-4" /> Export
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
        {modelDownloadProgress !== null && (
          <div className="flex w-52 items-center gap-2">
            <Download className="h-3 w-3 shrink-0" />
            <span className="shrink-0">Downloading…</span>
            <Progress value={modelDownloadProgress * 100} className="flex-1" />
          </div>
        )}
        {transcribeProgress !== null && (
          <div className="flex w-44 items-center gap-2">
            <MicVocal className="h-3 w-3 shrink-0" />
            <span className="shrink-0">Transcribing…</span>
            <Progress value={transcribeProgress * 100} className="flex-1" />
          </div>
        )}
        {exportingProgress !== null && (
          <div className="flex w-44 items-center gap-2">
            <Scissors className="h-3 w-3 shrink-0" />
            <span className="shrink-0">Exporting…</span>
            <Progress value={exportingProgress * 100} className="flex-1" />
          </div>
        )}
        <span>{formatDuration(totalDuration(project))}</span>
      </div>

      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Choose a Whisper model</DialogTitle>
            <DialogDescription>
              Select a model to transcribe with. Download any model you don't have yet — larger models are more accurate but slower.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            {MODELS.map((m) => {
              const installed = installedModels.find((i) => i.name === m.name)?.installed ?? false;
              const isDownloading = downloadingModel === m.name;
              const isOtherDownloading = downloadingModel !== null && !isDownloading;

              return (
                <div
                  key={m.name}
                  className={`rounded-md border p-3 transition-colors ${
                    selectedModel === m.name
                      ? "border-primary bg-accent"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  {/* Top row: radio + name + status */}
                  <div className="flex items-center justify-between">
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                      <input
                        type="radio"
                        name="model"
                        value={m.name}
                        checked={selectedModel === m.name}
                        disabled={!installed}
                        onChange={() => setSelectedModel(m.name)}
                      />
                      {m.label}
                    </label>

                    {/* Right-side badge / button */}
                    {installed ? (
                      <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Installed
                      </span>
                    ) : isDownloading ? (
                      <span className="text-xs text-muted-foreground">
                        {Math.round(downloadProgress * 100)}%
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 text-xs"
                        disabled={isOtherDownloading}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDownloadModel(m.name);
                        }}
                      >
                        <Download className="h-3 w-3" />
                        {m.sizeMb >= 1000
                          ? `${(m.sizeMb / 1000).toFixed(1)} GB`
                          : `${m.sizeMb} MB`}
                      </Button>
                    )}
                  </div>

                  {/* Inline download progress bar */}
                  {isDownloading && (
                    <div className="mt-2">
                      <Progress value={downloadProgress * 100} className="h-1.5" />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Downloading… {Math.round(downloadProgress * 100)}% — do not close this window
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <DialogFooter>
            <Button
              onClick={() => setModelDialogOpen(false)}
              variant="outline"
              disabled={downloadingModel !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={startTranscribe}
              disabled={
                downloadingModel !== null ||
                !installedModels.find((m) => m.name === selectedModel)?.installed
              }
            >
              Transcribe
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
