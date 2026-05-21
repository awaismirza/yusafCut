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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
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
  startNativeRecording,
  stopNativeRecording,
  transcribe,
  type ModelInfo,
  type RecordingMode,
  type WhisperModel,
} from "@/lib/ipc";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  Captions,
  CheckCircle2,
  ChevronDown,
  Download,
  FilePlus2,
  FolderOpen,
  History,
  MonitorUp,
  MicVocal,
  Music,
  Power,
  Radio,
  Save,
  Scissors,
  Settings2,
  Square,
  Video,
} from "lucide-react";
import { formatDuration } from "@/lib/timecode";
import {
  addMediaWithTranscript as buildProjectWithMedia,
  newProject,
  totalDuration,
  type Project,
  type Word,
} from "@/lib/edl";
import { buildSrt, buildVtt } from "@/lib/captions";
import { usePlayerStore } from "@/stores/playerStore";
import { Toolbox } from "@/components/Toolbox/Toolbox";
import { MusicTracksDialog } from "@/components/Toolbox/MusicTracksDialog";
import { SnapshotsDialog } from "@/components/Toolbox/SnapshotsDialog";
import {
  cacheProjectTranscripts,
  clearTranscriptCache,
  readTranscriptCache,
  writeTranscriptCache,
} from "@/lib/transcriptCache";

const MODELS: { name: WhisperModel; label: string; sizeMb: number }[] = [
  { name: "tiny", label: "Tiny (fast, lower accuracy)", sizeMb: 75 },
  { name: "base", label: "Base", sizeMb: 142 },
  { name: "small", label: "Small", sizeMb: 466 },
  { name: "medium", label: "Medium", sizeMb: 1500 },
  { name: "large-v3-turbo", label: "Large v3 Turbo (recommended)", sizeMb: 1600 },
];

/** ISO 639-1 languages Whisper supports well. */
const WHISPER_LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
  { code: "ko", label: "Korean" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "tr", label: "Turkish" },
  { code: "sv", label: "Swedish" },
  { code: "uk", label: "Ukrainian" },
];

const MEDIA_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "m4a", "wav"];

function mediaNameFromPath(path: string, fallback = "Untitled") {
  return (
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || fallback
  );
}

function wordsForMedia(project: Project, mediaId: string) {
  return project.segments
    .filter((segment) => segment.mediaId === mediaId)
    .flatMap((segment) => segment.words);
}

function applyTranscriptToMedia(
  project: Project,
  mediaId: string,
  words: Word[],
  force = false,
): Project {
  return {
    ...project,
    segments: project.segments.map((segment) => {
      if (segment.mediaId !== mediaId) return segment;
      // In normal mode skip segments that already have words; in force mode overwrite all.
      if (!force && segment.words.length > 0) return segment;
      return {
        ...segment,
        words: words.filter(
          (word) => word.end > segment.sourceIn && word.start < segment.sourceOut,
        ),
      };
    }),
    updatedAt: new Date().toISOString(),
  };
}

interface ToolbarProps {
  onFindClick?: () => void;
}

function recordingLabel(mode: RecordingMode) {
  if (mode === "voiceover") return "Voice over";
  if (mode === "screen") return "Screen recording";
  return "Camera recording";
}

export function Toolbar({ onFindClick }: ToolbarProps) {
  const project = useProjectStore((s) => s.project);
  const dirty = useProjectStore((s) => s.dirty);
  const filePath = useProjectStore((s) => s.filePath);
  const markSaved = useProjectStore((s) => s.markSaved);

  const transcribeProgress = useUIStore((s) => s.transcribeProgress);
  const exportingProgress = useUIStore((s) => s.exportingProgress);
  const modelDownloadProgress = useUIStore((s) => s.modelDownloadProgress);
  const mediaLoading = useUIStore((s) => s.mediaLoading);
  const editOperationLabel = useUIStore((s) => s.editOperationLabel);
  const pushToast = useUIStore((s) => s.pushToast);
  const setMediaLoading = useUIStore((s) => s.setMediaLoading);
  const setExportingProgress = useUIStore((s) => s.setExportingProgress);
  const setTranscribeProgress = useUIStore((s) => s.setTranscribeProgress);
  const displayName = filePath?.split(/[\\/]/).pop() ?? `${project.name}.scribe`;

  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<WhisperModel>("large-v3-turbo");
  const [transcribeLanguage, setTranscribeLanguage] = useState("auto");
  const [transcribeTranslate, setTranscribeTranslate] = useState(false);
  const [transcribeDiarize, setTranscribeDiarize] = useState(false);
  const [installedModels, setInstalledModels] = useState<ModelInfo[]>([]);
  const [exportSettings, setExportSettings] = useState({
    resolution: "original",
    customWidth: 1920,
    customHeight: 1080,
    videoBitrateKbps: 8000,
    audioBitrateKbps: 192,
    fps: "",
    codec: "auto" as "auto" | "h264" | "hevc",
    /** When true, bypass smart-cut and re-encode every frame. */
    forceReencode: false,
  });
  // Which model is currently being downloaded inside the dialog, and its progress.
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [musicDialogOpen, setMusicDialogOpen] = useState(false);
  const [snapshotsDialogOpen, setSnapshotsDialogOpen] = useState(false);
  const [recordingMode, setRecordingMode] = useState<RecordingMode>("voiceover");
  const [recording, setRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("Ready to record locally");
  const unlistenDownloadRef = useRef<(() => void) | null>(null);
  /** Set to true before opening the model dialog when the user clicks Re-Transcribe. */
  const forceRetranscribeRef = useRef(false);

  // toolbarBottomRef kept for potential future use
  const toolbarBottomRef = useRef<HTMLDivElement>(null);

  /** True when at least one segment already has transcribed words. */
  const hasTranscript = project.segments.some((s) => s.words.length > 0);

  async function handleOpen() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }],
    });
    if (typeof path !== "string") return;
    setMediaLoading(true);
    try {
      const media = await importMedia(path);
      const name = mediaNameFromPath(media.path);
      const cachedWords = readTranscriptCache(media);
      const nextProject = buildProjectWithMedia(newProject(name), media, cachedWords ?? []);
      resetPlayer();
      replaceProjectBaseline(nextProject, { dirty: true, filePath: null });
      pushToast({
        title: cachedWords ? "Media imported with cached transcript" : "Media imported",
        description: media.path,
      });
    } catch (err) {
      pushToast({
        title: "Failed to import media",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setMediaLoading(false);
    }
  }

  async function handleAddClip() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }],
    });
    if (typeof path !== "string") return;
    await addClipToTimeline(path);
  }

  async function addClipToTimeline(path: string) {
    setMediaLoading(true);
    try {
      const before = useProjectStore.getState().project;
      const appendAt = totalDuration(before);
      const media = await importMedia(path);
      const cachedWords = readTranscriptCache(media) ?? [];
      useProjectStore.getState().addMediaWithTranscript(media, cachedWords);
      usePlayerStore.getState().clearTimelineRange();
      usePlayerStore.getState().setSelectedWordIds(new Set());
      window.dispatchEvent(new CustomEvent("scribe:seek-output", { detail: { time: appendAt } }));
      pushToast({
        title: cachedWords.length > 0 ? "Clip added with cached transcript" : "Clip added",
        description:
          cachedWords.length > 0
            ? media.path
            : "Click Transcribe to generate text for this clip.",
      });
    } catch (err) {
      pushToast({
        title: "Failed to add clip",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setMediaLoading(false);
    }
  }

  function resetPlayer() {
    usePlayerStore.getState().reset();
  }

  function handleCloseProject() {
    replaceProjectBaseline(newProject("Untitled"), { dirty: false, filePath: null });
    resetPlayer();
    pushToast({ title: "Project closed" });
  }

  function handleNewProject() {
    replaceProjectBaseline(newProject("Untitled"), { dirty: false, filePath: null });
    resetPlayer();
  }

  async function handleOpenProject() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Scribe project", extensions: ["scribe"] }],
    });
    if (typeof path !== "string") return;
    setMediaLoading(true);
    try {
      const loaded = await loadProject(path);
      cacheProjectTranscripts(loaded);
      replaceProjectBaseline(loaded, { dirty: false, filePath: path });
      resetPlayer();
      pushToast({ title: "Project opened", description: path });
    } catch (err) {
      pushToast({
        title: "Failed to open project",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setMediaLoading(false);
    }
  }

  async function ensureSelectedModelInstalled() {
    const info = await listModels();
    setInstalledModels(info);
    const installed = info.find((m) => m.name === selectedModel)?.installed ?? false;
    if (installed) return;

    const modelLabel = MODELS.find((m) => m.name === selectedModel)?.label ?? selectedModel;
    pushToast({
      title: `Downloading ${modelLabel}…`,
      description: "Needed once before local transcription can run.",
    });
    await downloadModel("whisper-cpp", selectedModel);
    setInstalledModels((prev) =>
      prev.map((m) => (m.name === selectedModel ? { ...m, installed: true } : m)),
    );
  }

  async function importAndTranscribeRecording(path: string, label: string) {
    setMediaLoading(true);
    try {
      const media = await importMedia(path);
      const name = mediaNameFromPath(media.path, label);
      const projectWithMedia = buildProjectWithMedia(newProject(name), media, []);
      resetPlayer();
      replaceProjectBaseline(projectWithMedia, { dirty: true, filePath: null });
      pushToast({ title: `${label} saved`, description: media.path });

      await ensureSelectedModelInstalled();
      const result = await transcribe({
        mediaId: media.id,
        mediaPath: media.path,
        engine: "whisper-cpp",
        modelName: selectedModel,
        mediaDuration: media.duration,
        language: transcribeLanguage === "auto" ? undefined : transcribeLanguage,
        translate: transcribeTranslate,
        diarize: transcribeDiarize,
      });
      writeTranscriptCache(media, result.words);
      replaceProjectBaseline(
        {
          ...projectWithMedia,
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
        },
        { dirty: true, filePath: null },
      );
      pushToast({ title: "Recording transcribed", description: `${result.words.length} words` });
    } catch (err) {
      pushToast({
        title: "Recording import/transcription failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setMediaLoading(false);
    }
  }

  async function startRecording(mode: RecordingMode) {
    setRecordingMode(mode);
    setRecordingStatus("Starting native macOS recorder…");

    try {
      await startNativeRecording(mode);
      setRecording(true);
      setRecordingStatus(`${recordingLabel(mode)} in progress`);
    } catch (err) {
      setRecording(false);
      setRecordingStatus("Ready to record locally");
      pushToast({
        title: "Recording failed to start",
        description: String(err),
        variant: "destructive",
      });
    }
  }

  async function stopRecording() {
    setRecordingStatus("Stopping recording…");
    try {
      const label = recordingLabel(recordingMode);
      const path = await stopNativeRecording();
      setRecording(false);
      setRecordingStatus("Transcribing recording…");
      await importAndTranscribeRecording(path, label);
      setRecordDialogOpen(false);
    } catch (err) {
      pushToast({
        title: "Recording failed to stop",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setRecording(false);
      setRecordingStatus("Ready to record locally");
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
    const mediaIds = Array.from(new Set(project.segments.map((segment) => segment.mediaId)));
    if (mediaIds.length === 0) {
      pushToast({ title: "Open a video first", variant: "destructive" });
      return;
    }
    forceRetranscribeRef.current = false;
    await refreshModelList();
    setModelDialogOpen(true);
  }

  async function handleReTranscribe() {
    const mediaIds = Array.from(new Set(project.segments.map((segment) => segment.mediaId)));
    if (mediaIds.length === 0) return;
    forceRetranscribeRef.current = true;
    await refreshModelList();
    setModelDialogOpen(true);
  }

  /** Download a single model from within the dialog, updating inline progress. */
  async function handleDownloadModel(name: string) {
    if (downloadingModel) return; // already downloading something

    setDownloadingModel(name);
    setDownloadProgress(0);

    // Subscribe to download progress events so the inline bar updates live.
    const unlisten = await onModelDownloadProgress((p) => {
      if (p.name === name) setDownloadProgress(p.progress);
    });
    unlistenDownloadRef.current = unlisten;

    try {
      await downloadModel("whisper-cpp", name);
      // Mark as installed in local state immediately.
      setInstalledModels((prev) =>
        prev.map((m) => (m.name === name ? { ...m, installed: true } : m)),
      );
      // Auto-select the freshly downloaded model.
      setSelectedModel(name as WhisperModel);
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
    const force = forceRetranscribeRef.current;
    forceRetranscribeRef.current = false; // reset immediately

    const mediaIds = Array.from(new Set(project.segments.map((segment) => segment.mediaId)));
    if (mediaIds.length === 0) return;

    // Show the transcription progress dialog immediately — before the first
    // Whisper event arrives so the user sees feedback right away.
    setTranscribeProgress(0);

    if (force) {
      pushToast({
        title: "Re-transcribing…",
        description: "Clearing existing transcript and starting fresh.",
      });
    }

    try {
      // ── Step 1: download the model if it isn't on disk yet ──────────────
      const isInstalled = installedModels.find((m) => m.name === selectedModel)?.installed ?? false;
      if (!isInstalled) {
        pushToast({
          title: `Downloading ${selectedModel}…`,
          description: "This may take a few minutes. Progress shown in the toolbar.",
        });
        await downloadModel("whisper-cpp", selectedModel);
        pushToast({ title: "Model downloaded — starting transcription…" });
      }

      // ── Step 2: clear caches when re-transcribing ────────────────────────
      let nextProject = useProjectStore.getState().project;
      if (force) {
        for (const mediaId of mediaIds) {
          const media = nextProject.media[mediaId];
          if (media) clearTranscriptCache(media);
        }
      }

      // ── Step 3: transcribe each clip ─────────────────────────────────────
      let totalWords = 0;
      let transcribedClips = 0;
      for (const mediaId of mediaIds) {
        const media = nextProject.media[mediaId];
        if (!media) continue;
        const cached = force ? null : readTranscriptCache(media);
        const existingWords = wordsForMedia(nextProject, mediaId);
        if (!force && existingWords.length > 0) {
          totalWords += existingWords.length;
          continue;
        }
        const words =
          cached ??
          (
            await transcribe({
              mediaId,
              mediaPath: media.path,
              engine: "whisper-cpp",
              modelName: selectedModel,
              mediaDuration: media.duration,
              language: transcribeLanguage === "auto" ? undefined : transcribeLanguage,
              translate: transcribeTranslate,
              diarize: transcribeDiarize,
            })
          ).words;
        writeTranscriptCache(media, words);
        nextProject = applyTranscriptToMedia(nextProject, mediaId, words, force);
        totalWords += words.length;
        transcribedClips++;
      }

      replaceProjectBaseline(nextProject, { dirty: true, filePath });
      pushToast({
        title: force ? "Re-transcription complete" : "Transcription complete",
        description:
          transcribedClips > 0
            ? `${totalWords} words across ${mediaIds.length} clip${mediaIds.length === 1 ? "" : "s"}`
            : "All clips already had transcript text",
      });
    } catch (err) {
      pushToast({
        title: force ? "Re-transcription failed" : "Transcription failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      // Always hide the progress dialog — whether we succeeded, errored, or
      // skipped transcription entirely (all clips already had words).
      setTranscribeProgress(null);
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

    // Show the export progress dialog immediately so the user sees feedback
    // before the first ffmpeg progress event arrives.
    setExportingProgress(0);

    try {
      await exportVideo({
        project,
        outputPath: outPath,
        preset: project.settings.exportPreset,
        ...dims,
        // "auto" means: don't specify a codec — let the smart-cut path stream-copy
        // the source rather than transcoding. Explicit h264/hevc disables smart-cut.
        codec: exportSettings.codec === "auto" ? undefined : exportSettings.codec,
        fps: exportSettings.fps ? Number(exportSettings.fps) : undefined,
        videoBitrateKbps: exportSettings.videoBitrateKbps,
        audioBitrateKbps: exportSettings.audioBitrateKbps,
        forceReencode: exportSettings.forceReencode,
      });
      pushToast({ title: "Export complete", description: outPath });
    } catch (err) {
      pushToast({
        title: "Export failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      // Always hide the progress dialog — covers both success and ffmpeg errors.
      // On success, the Rust backend already emitted progress=1.0 which would
      // also set this to null via useTranscribeProgress, but being explicit here
      // ensures the dialog closes even if the event is lost.
      setExportingProgress(null);
    }
  }, [exportSettings, project, pushToast, setExportingProgress]);

  const handleExport = useCallback(() => {
    if (Object.keys(project.media).length === 0 || project.segments.length === 0) {
      pushToast({ title: "Nothing to export", variant: "destructive" });
      return;
    }
    setExportDialogOpen(true);
  }, [project, pushToast]);

  // ── Caption export (SRT / VTT) ──────────────────────────────────────────
  // Captions reflect the *output* timeline, so deletes and clip reordering
  // carry over to the .srt/.vtt without the user having to think about it.
  const handleExportCaptions = useCallback(async () => {
    const hasWords = project.segments.some((s) => s.words.length > 0);
    if (!hasWords) {
      pushToast({
        title: "No captions to export",
        description: "Transcribe the clip first to generate word timings.",
        variant: "destructive",
      });
      return;
    }
    const outPath = await saveDialog({
      defaultPath: `${project.name}.srt`,
      filters: [
        { name: "SubRip subtitles", extensions: ["srt"] },
        { name: "WebVTT captions", extensions: ["vtt"] },
      ],
    });
    if (!outPath) return;
    const isVtt = outPath.toLowerCase().endsWith(".vtt");
    try {
      const content = isVtt ? buildVtt(project) : buildSrt(project);
      await writeTextFile(outPath, content);
      pushToast({
        title: isVtt ? "WebVTT exported" : "SRT exported",
        description: outPath,
      });
    } catch (err) {
      pushToast({
        title: "Caption export failed",
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
    <div className="editor-toolbar">
      <div className="editor-toolbar-top">
        <div className="toolbar-title">
          <span>{displayName}</span>
          <span>{dirty ? "unsaved edits" : "no edits"}</span>
        </div>

        <div className="toolbar-export">
          <span className="toolbar-duration">{formatDuration(totalDuration(project))}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleExportCaptions}
            className="h-8 gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
            title="Export captions (.srt or .vtt)"
          >
            <Captions className="h-4 w-4" /> Captions
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            className="h-8 gap-2 rounded-md px-3 font-semibold"
          >
            <Download className="h-4 w-4" /> Export .mp4
          </Button>
        </div>
      </div>

      <div className="editor-toolbar-bottom" ref={toolbarBottomRef}>
        {/* ── Left: file operations ── */}
        <div className="tool-group">
          <Button size="sm" variant="ghost" className="tool-button" onClick={handleOpen}>
            <FolderOpen className="h-4 w-4" /> Open
          </Button>
          <Button size="sm" variant="ghost" className="tool-button" onClick={handleSave}>
            <Save className="h-4 w-4" /> Save{dirty ? " *" : ""}
          </Button>
          {/* File ▾ — project management, snapshots, and lifecycle */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="tool-button">
                File <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[180px]">
              <DropdownMenuItem onClick={handleAddClip}>
                <Scissors className="h-4 w-4 mr-2" /> Add Clip
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleNewProject}>
                <FilePlus2 className="h-4 w-4 mr-2" /> New Project
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void handleOpenProject()}>
                <FolderOpen className="h-4 w-4 mr-2" /> Open Project
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSnapshotsDialogOpen(true)}>
                <History className="h-4 w-4 mr-2" /> Snapshots
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={handleCloseProject}
              >
                <Power className="h-4 w-4 mr-2" /> Close project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Toolbox onFindClick={onFindClick} />

        {/* ── Right: transcribe + capture + project lifecycle ── */}
        <div className="tool-group">
          <Button
            size="sm"
            variant="ghost"
            className="tool-button tool-button-primary"
            title={
              hasTranscript
                ? "Clear existing transcript and re-run Whisper from scratch"
                : "Transcribe audio with Whisper"
            }
            onClick={hasTranscript ? handleReTranscribe : handleTranscribe}
          >
            <MicVocal className="h-4 w-4" />
            {hasTranscript ? "Re-Transcribe" : "Transcribe"}
          </Button>
          {/* Capture ▾ — recording and audio inputs */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="tool-button">
                Capture <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuItem onClick={() => setRecordDialogOpen(true)}>
                <Radio className="h-4 w-4 mr-2" /> Record
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setMusicDialogOpen(true)}>
                <Music className="h-4 w-4 mr-2" /> Music tracks
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Dialog
        open={recordDialogOpen}
        onOpenChange={(open) => {
          if (!recording) setRecordDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-primary" />
              Record locally
            </DialogTitle>
            <DialogDescription>
              Capture voice, screen, or camera media on this Mac. Scribe saves the clip locally,
              imports it, and transcribes it with Whisper.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant={recordingMode === "voiceover" ? "default" : "outline"}
                className="h-auto flex-col gap-2 py-4"
                disabled={recording}
                onClick={() => setRecordingMode("voiceover")}
              >
                <MicVocal className="h-5 w-5" />
                Voice over
              </Button>
              <Button
                variant={recordingMode === "screen" ? "default" : "outline"}
                className="h-auto flex-col gap-2 py-4"
                disabled={recording}
                onClick={() => setRecordingMode("screen")}
              >
                <MonitorUp className="h-5 w-5" />
                Screen
              </Button>
              <Button
                variant={recordingMode === "camera" ? "default" : "outline"}
                className="h-auto flex-col gap-2 py-4"
                disabled={recording}
                onClick={() => setRecordingMode("camera")}
              >
                <Video className="h-5 w-5" />
                Camera
              </Button>
            </div>

            <div className="rounded-md border border-border bg-secondary/45 px-3 py-2 text-sm text-muted-foreground">
              {recordingStatus}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRecordDialogOpen(false)}
              disabled={recording}
            >
              Cancel
            </Button>
            {recording ? (
              <Button variant="destructive" className="gap-2" onClick={() => void stopRecording()}>
                <Square className="h-4 w-4" />
                Stop recording
              </Button>
            ) : (
              <Button className="gap-2" onClick={() => void startRecording(recordingMode)}>
                <Radio className="h-4 w-4" />
                Start {recordingLabel(recordingMode)}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {forceRetranscribeRef.current ? "Re-Transcribe" : "Transcription settings"}
            </DialogTitle>
            <DialogDescription>
              {forceRetranscribeRef.current
                ? "This will clear the existing transcript and re-run Whisper from scratch."
                : "Choose an engine, model, and language. Larger models are more accurate but slower."}
            </DialogDescription>
          </DialogHeader>

          {/* ── Engine info ── */}
          <p className="text-xs text-muted-foreground rounded-md border border-border px-3 py-2">
            <span className="font-semibold text-foreground">whisper.cpp · Core ML</span>
            {" "}— runs 100% locally with Apple Silicon acceleration. Tight word-level
            timestamps for accurate video/text sync.
          </p>

          {/* ── Model list ── */}
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
            {MODELS.map((m) => {
              const installed = installedModels.find((i) => i.name === m.name)?.installed ?? false;
              const isDownloading = downloadingModel === m.name;
              const isOtherDownloading = downloadingModel !== null && !isDownloading;
              const isSelected = selectedModel === m.name;

              return (
                <div
                  key={m.name}
                  className={`rounded-md border p-3 transition-colors ${
                    isSelected ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                      <input
                        type="radio"
                        name="model"
                        value={m.name}
                        checked={isSelected}
                        disabled={!installed}
                        onChange={() => setSelectedModel(m.name as WhisperModel)}
                      />
                      {m.label}
                    </label>
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
                  {isDownloading && (
                    <div className="mt-2">
                      <Progress value={downloadProgress * 100} className="h-1.5" />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Downloading… {Math.round(downloadProgress * 100)}% — do not close
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Language / options ── */}
          <div className="grid gap-3 rounded-md border border-border p-3">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Source language
              <select
                className="h-8 rounded border border-input bg-background px-2 text-sm text-foreground"
                value={transcribeLanguage}
                onChange={(e) => setTranscribeLanguage(e.target.value)}
              >
                {WHISPER_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            {/* translate + diarize */}
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={transcribeTranslate}
                  onChange={(e) => setTranscribeTranslate(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Translate to English</span>
                  <span className="ml-1 text-muted-foreground">
                    — output English regardless of source
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={transcribeDiarize}
                  onChange={(e) => setTranscribeDiarize(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Speaker diarisation</span>
                  <span className="ml-1 text-muted-foreground">
                    — label who is speaking
                  </span>
                </span>
              </label>
            </div>
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
              variant={forceRetranscribeRef.current ? "destructive" : "default"}
            >
              {forceRetranscribeRef.current ? "Re-Transcribe" : "Transcribe"}
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
                    setExportSettings((s) => ({
                      ...s,
                      codec: e.target.value as "auto" | "h264" | "hevc",
                    }))
                  }
                >
                  <option value="auto">Match source (smart-cut)</option>
                  <option value="h264">H.264 (re-encode)</option>
                  <option value="hevc">HEVC (re-encode)</option>
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

            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={exportSettings.forceReencode}
                onChange={(e) =>
                  setExportSettings((s) => ({ ...s, forceReencode: e.target.checked }))
                }
              />
              Force full re-encode (disable smart-cut)
            </label>
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
            {/*
             * Same two-phase pattern as export:
             *  transcribeProgress === 0  → Whisper model is loading / audio is being decoded,
             *                              no meaningful % yet — show indeterminate bar.
             *  transcribeProgress  > 0  → Whisper is actively transcribing; show real %.
             */}
            {(transcribeProgress ?? 0) > 0 ? (
              <>
                <Progress value={(transcribeProgress ?? 0) * 100} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Whisper running locally</span>
                  <span>{Math.round((transcribeProgress ?? 0) * 100)}%</span>
                </div>
              </>
            ) : (
              <>
                <Progress indeterminate />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Whisper running locally</span>
                  <span>Loading model…</span>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mediaLoading} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-primary" />
              Loading media
            </DialogTitle>
            <DialogDescription>
              Probing the file and preparing it for local playback.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Progress indeterminate />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Reading metadata</span>
              <span>Local file</span>
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
            {/*
             * Two-phase progress UI:
             *  exportingProgress === 0  → ffmpeg is initialising (no frames encoded yet),
             *                             show an indeterminate "running" bar with no %.
             *  exportingProgress  > 0  → real frame data is flowing; switch to a
             *                             determinate bar so the user can see how far along
             *                             the render is.
             */}
            {(exportingProgress ?? 0) > 0 ? (
              <>
                <Progress value={(exportingProgress ?? 0) * 100} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Writing .mp4</span>
                  <span>{Math.round((exportingProgress ?? 0) * 100)}%</span>
                </div>
              </>
            ) : (
              <>
                <Progress indeterminate />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Preparing export…</span>
                  <span>Starting ffmpeg</span>
                </div>
              </>
            )}
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
            <DialogDescription>Preparing the local transcription model.</DialogDescription>
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

      {/* ── Generic "operation in progress" dialog (Trim silences, etc.) ── */}
      <Dialog open={editOperationLabel !== null} onOpenChange={() => undefined}>
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scissors className="h-4 w-4 text-primary" />
              {editOperationLabel ?? "Processing…"}
            </DialogTitle>
            <DialogDescription>
              Applying edits to the project — this will complete shortly.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Progress indeterminate />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Working…</span>
              <span>Please wait</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <MusicTracksDialog open={musicDialogOpen} onOpenChange={setMusicDialogOpen} />
      <SnapshotsDialog open={snapshotsDialogOpen} onOpenChange={setSnapshotsDialogOpen} />
    </div>
  );
}
