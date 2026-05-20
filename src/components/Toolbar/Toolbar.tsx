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
import {
  CheckCircle2,
  Download,
  FilePlus2,
  FolderOpen,
  MicVocal,
  Power,
  Save,
  Scissors,
  Settings2,
} from "lucide-react";
import { formatDuration } from "@/lib/timecode";
import { newProject, totalDuration } from "@/lib/edl";
import { usePlayerStore } from "@/stores/playerStore";

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
  const closeProject = useProjectStore((s) => s.closeProject);

  const transcribeProgress = useUIStore((s) => s.transcribeProgress);
  const exportingProgress = useUIStore((s) => s.exportingProgress);
  const modelDownloadProgress = useUIStore((s) => s.modelDownloadProgress);
  const pushToast = useUIStore((s) => s.pushToast);
  const displayName = filePath?.split(/[\\/]/).pop() ?? `${project.name}.scribe`;

  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<WhisperModel>("large-v3-turbo");
  const [installedModels, setInstalledModels] = useState<ModelInfo[]>([]);
  const [exportSettings, setExportSettings] = useState({
    resolution: "1080p",
    customWidth: 1920,
    customHeight: 1080,
    videoBitrateKbps: 8000,
    audioBitrateKbps: 192,
    fps: "",
    codec: "h264" as "h264" | "hevc",
  });
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

  function resetPlayer() {
    usePlayerStore.getState().reset();
  }

  function handleCloseProject() {
    closeProject();
    useProjectStore.temporal.getState().clear();
    resetPlayer();
    pushToast({ title: "Project closed" });
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

  const runExport = useCallback(async () => {
    const outPath = await saveDialog({
      defaultPath: `${project.name}.mp4`,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!outPath) return;
    const resolution = exportSettings.resolution;
    const dims =
      resolution === "original"
        ? {}
        : resolution === "720p"
          ? { width: 1280, height: 720 }
          : resolution === "1080p"
            ? { width: 1920, height: 1080 }
            : resolution === "4k"
              ? { width: 3840, height: 2160 }
              : {
                  width: Math.max(16, exportSettings.customWidth),
                  height: Math.max(16, exportSettings.customHeight),
                };
    try {
      await exportVideo({
        project,
        outputPath: outPath,
        preset: project.settings.exportPreset,
        ...dims,
        codec: exportSettings.codec,
        fps: exportSettings.fps ? Number(exportSettings.fps) : undefined,
        videoBitrateKbps: exportSettings.videoBitrateKbps,
        audioBitrateKbps: exportSettings.audioBitrateKbps,
      });
      pushToast({ title: "Export complete", description: outPath });
    } catch (err) {
      pushToast({
        title: "Export failed",
        description: String(err),
        variant: "destructive",
      });
    }
  }, [exportSettings, project, pushToast]);

  const handleExport = useCallback(() => {
    if (Object.keys(project.media).length === 0 || project.segments.length === 0) {
      pushToast({ title: "Nothing to export", variant: "destructive" });
      return;
    }
    setExportDialogOpen(true);
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
    <div className="editor-toolbar">
      <div className="editor-toolbar-top">
        <div className="traffic-lights" aria-hidden="true">
          <span className="bg-[#ff5f57]" />
          <span className="bg-[#febc2e]" />
          <span className="bg-[#28c840]" />
        </div>

        <div className="toolbar-title">
          <span>{displayName}</span>
          <span>{dirty ? "unsaved edits" : "no edits"}</span>
        </div>

        <div className="toolbar-export">
          <span className="toolbar-duration">{formatDuration(totalDuration(project))}</span>
          <Button size="sm" onClick={handleExport} className="h-8 gap-2 rounded-md px-3 font-semibold">
            <Download className="h-4 w-4" /> Export .mp4
          </Button>
        </div>
      </div>

      <div className="editor-toolbar-bottom">
        <div className="tool-group">
          <Button size="sm" variant="ghost" className="tool-button" onClick={handleOpen}>
            <FolderOpen className="h-4 w-4" /> Open Media
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="tool-button"
            onClick={() => {
              setProject(newProject("Untitled"));
              useProjectStore.temporal.getState().clear();
              resetPlayer();
            }}
          >
            <FilePlus2 className="h-4 w-4" /> New
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="tool-button"
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
            <FolderOpen className="h-4 w-4" /> Project
          </Button>
          <Button size="sm" variant="ghost" className="tool-button" onClick={handleSave}>
            <Save className="h-4 w-4" /> Save{dirty ? " *" : ""}
          </Button>
        </div>

        <div className="tool-group">
          <Button size="sm" variant="ghost" className="tool-button tool-button-primary" onClick={handleTranscribe}>
            <MicVocal className="h-4 w-4" /> Transcribe
          </Button>
          <Button size="sm" variant="ghost" className="tool-button tool-button-danger" onClick={handleCloseProject}>
            <Power className="h-4 w-4" /> Close
          </Button>
        </div>
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

      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Export video</DialogTitle>
            <DialogDescription>
              Choose output resolution and quality before rendering the edited timeline.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-1">
            <label className="grid gap-1.5 text-sm">
              Resolution
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={exportSettings.resolution}
                onChange={(e) => setExportSettings((s) => ({ ...s, resolution: e.target.value }))}
              >
                <option value="original">Original</option>
                <option value="720p">1280 x 720</option>
                <option value="1080p">1920 x 1080</option>
                <option value="4k">3840 x 2160</option>
                <option value="custom">Custom</option>
              </select>
            </label>

            {exportSettings.resolution === "custom" && (
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 text-sm">
                  Width
                  <input
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    type="number"
                    min={16}
                    step={2}
                    value={exportSettings.customWidth}
                    onChange={(e) =>
                      setExportSettings((s) => ({ ...s, customWidth: Number(e.target.value) }))
                    }
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  Height
                  <input
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    type="number"
                    min={16}
                    step={2}
                    value={exportSettings.customHeight}
                    onChange={(e) =>
                      setExportSettings((s) => ({ ...s, customHeight: Number(e.target.value) }))
                    }
                  />
                </label>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-sm">
                Codec
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={exportSettings.codec}
                  onChange={(e) =>
                    setExportSettings((s) => ({ ...s, codec: e.target.value as "h264" | "hevc" }))
                  }
                >
                  <option value="h264">H.264</option>
                  <option value="hevc">HEVC</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                Frame rate
                <input
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="Original"
                  value={exportSettings.fps}
                  onChange={(e) => setExportSettings((s) => ({ ...s, fps: e.target.value }))}
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-sm">
                Video bitrate
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1"
                    type="range"
                    min={1500}
                    max={30000}
                    step={500}
                    value={exportSettings.videoBitrateKbps}
                    onChange={(e) =>
                      setExportSettings((s) => ({
                        ...s,
                        videoBitrateKbps: Number(e.target.value),
                      }))
                    }
                  />
                  <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                    {(exportSettings.videoBitrateKbps / 1000).toFixed(1)} Mbps
                  </span>
                </div>
              </label>
              <label className="grid gap-1.5 text-sm">
                Audio bitrate
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={exportSettings.audioBitrateKbps}
                  onChange={(e) =>
                    setExportSettings((s) => ({
                      ...s,
                      audioBitrateKbps: Number(e.target.value),
                    }))
                  }
                >
                  <option value={128}>128 kbps</option>
                  <option value={192}>192 kbps</option>
                  <option value={256}>256 kbps</option>
                  <option value={320}>320 kbps</option>
                </select>
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setExportDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setExportDialogOpen(false);
                void runExport();
              }}
              className="gap-2"
            >
              <Settings2 className="h-4 w-4" />
              Export .mp4
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={transcribeProgress !== null} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MicVocal className="h-4 w-4 text-primary" />
              Transcribing media
            </DialogTitle>
            <DialogDescription>
              Scribe is building the word-level edit timeline locally on this Mac.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Progress value={(transcribeProgress ?? 0) * 100} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Whisper running locally</span>
              <span>{Math.round((transcribeProgress ?? 0) * 100)}%</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={exportingProgress !== null} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scissors className="h-4 w-4 text-primary" />
              Exporting video
            </DialogTitle>
            <DialogDescription>
              Rendering the edited timeline with your selected export settings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Progress value={(exportingProgress ?? 0) * 100} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Writing .mp4</span>
              <span>{Math.round((exportingProgress ?? 0) * 100)}%</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={modelDownloadProgress !== null} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-4 w-4 text-primary" />
              Downloading model
            </DialogTitle>
            <DialogDescription>
              Preparing the local transcription model.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Progress value={(modelDownloadProgress ?? 0) * 100} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Model download</span>
              <span>{Math.round((modelDownloadProgress ?? 0) * 100)}%</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
