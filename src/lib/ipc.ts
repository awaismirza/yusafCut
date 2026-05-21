/**
 * Wrappers around `@tauri-apps/api` `invoke` calls. These functions are the
 * *only* place in the frontend that talks to Rust. Keep the shape of each call
 * in sync with the Rust commands in `src-tauri/src/commands/`.
 *
 * Each function returns a typed Promise. If a Rust command rejects with a
 * string, it surfaces as a thrown error here.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Project, SourceMedia, Word } from "./edl";

// ---------------------------------------------------------------------------
// Media import
// ---------------------------------------------------------------------------

/** Probe a video file with ffprobe and return parsed metadata. */
export function importMedia(path: string): Promise<SourceMedia> {
  return invoke<SourceMedia>("import_media", { path });
}

export type RecordingMode = "voiceover" | "screen" | "camera";

export function startNativeRecording(mode: RecordingMode): Promise<string> {
  return invoke<string>("start_native_recording", { mode });
}

export function stopNativeRecording(): Promise<string> {
  return invoke<string>("stop_native_recording");
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Transcription engine — whisper.cpp only.
 *
 * WhisperKit (ANE) was removed in v3.2.0 due to word-timestamp inaccuracies
 * that caused video/text drift. To restore it, see commit 4726d25.
 */
export type TranscriptionEngine = "whisper-cpp";

/** whisper.cpp GGML model names (kebab-case, matches Rust WhisperModel). */
export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v3-turbo";

export interface TranscribeOptions {
  mediaId: string;
  mediaPath: string;
  engine?: TranscriptionEngine;
  modelName: WhisperModel;
  /** Total media duration in seconds — used to compute 0..1 progress. */
  mediaDuration?: number;
  /**
   * BCP-47 language code for the source audio (e.g. "fr", "es", "de").
   * Omit or pass "auto" to let Whisper detect the language.
   */
  language?: string;
  /** When true, Whisper outputs English regardless of the source language. */
  translate?: boolean;
  /**
   * When true, whisper-cli attempts to identify speakers via --diarize.
   * Requires whisper.cpp built with diarisation support.
   */
  diarize?: boolean;
}

export interface TranscribeResult {
  mediaId: string;
  words: Word[];
  engine: TranscriptionEngine;
}

/** Kick off a transcription. Resolves when complete; subscribe to progress events
 * via `onTranscribeProgress` before calling this if you want a progress bar. */
export function transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  return invoke<TranscribeResult>("transcribe", { opts });
}

export interface TranscribeProgress {
  mediaId: string;
  /** 0..1 */
  progress: number;
  /** Currently-decoded source timestamp, in seconds. */
  currentTime: number;
}

/** Subscribe to streaming progress for whichever transcription is running. */
export function onTranscribeProgress(
  handler: (p: TranscribeProgress) => void,
): Promise<UnlistenFn> {
  return listen<TranscribeProgress>("transcribe:progress", (e) => handler(e.payload));
}

// ---------------------------------------------------------------------------
// Model management
// ---------------------------------------------------------------------------

export interface ModelInfo {
  engine: TranscriptionEngine;
  /** WhisperModel slug, e.g. "large-v3-turbo". */
  name: string;
  /** Approximate disk size in MB. */
  sizeMb: number;
  /** Whether the model is already downloaded. */
  installed: boolean;
}

export function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models");
}

/**
 * Download a model. Pass the model's `name` and `engine` as returned by
 * `listModels` — the backend uses the engine to pick the right download path.
 */
export function downloadModel(engine: TranscriptionEngine, name: string): Promise<void> {
  return invoke<void>("download_model", { engine, name });
}

export interface ModelDownloadProgress {
  name: string;
  /** 0..1 */
  progress: number;
  bytesDownloaded: number;
  bytesTotal: number;
}

export function onModelDownloadProgress(
  handler: (p: ModelDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<ModelDownloadProgress>("model:download:progress", (e) => handler(e.payload));
}

// ---------------------------------------------------------------------------
// Project I/O
// ---------------------------------------------------------------------------

export function saveProject(project: Project, path: string): Promise<void> {
  return invoke<void>("save_project", { project, path });
}

export function loadProject(path: string): Promise<Project> {
  return invoke<Project>("load_project", { path });
}

export function relinkMedia(path: string, expectedSha256: string): Promise<SourceMedia> {
  return invoke<SourceMedia>("relink_media", { path, expectedSha256 });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportPreset = "youtube-1080p" | "podcast-audio" | "custom";

export interface ExportOptions {
  project: Project;
  outputPath: string;
  preset: ExportPreset;
  /** Custom preset only — bitrate in kbps. */
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: "h264" | "hevc";
  /** Bypass smart-cut and force the slow full re-encode path. Used by the
   *  "Force re-encode" advanced toggle in the export dialog. */
  forceReencode?: boolean;
}

export function exportVideo(opts: ExportOptions): Promise<void> {
  return invoke<void>("export_video", { opts });
}

export interface ExportProgress {
  /** 0..1 */
  progress: number;
  /** Encoded output time in seconds. */
  outputTimeSec: number;
  etaSec: number | null;
}

export function onExportProgress(handler: (p: ExportProgress) => void): Promise<UnlistenFn> {
  return listen<ExportProgress>("export:progress", (e) => handler(e.payload));
}

export function cancelExport(): Promise<void> {
  return invoke<void>("cancel_export");
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Return the path the app's `Application Support` directory. */
export function appDataDir(): Promise<string> {
  return invoke<string>("app_data_dir");
}

/** Open the export folder in Finder once a render is done. */
export function revealInFinder(path: string): Promise<void> {
  return invoke<void>("reveal_in_finder", { path });
}

// ---------------------------------------------------------------------------
// Jobs (background queue)
// ---------------------------------------------------------------------------

// AI / LLM features (detect_chapters, suggest_broll) were removed in v3.4.0
// to eliminate the Python/MLX sidecar dependency. Restore from commit
// 074d1d3 if needed.

export type JobKind = "export" | "transcribe" | "download-model" | "snapshot";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  etaSec: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export function listJobs(): Promise<JobSnapshot[]> {
  return invoke<JobSnapshot[]>("list_jobs");
}

export function cancelJob(id: string): Promise<void> {
  return invoke<void>("cancel_job", { id });
}

export function onJobsUpdate(handler: (jobs: JobSnapshot[]) => void): Promise<UnlistenFn> {
  return listen<JobSnapshot[]>("jobs:update", (e) => handler(e.payload));
}

// ---------------------------------------------------------------------------
// Snapshots (project history / restore points)
// ---------------------------------------------------------------------------

export interface SnapshotIndex {
  id: string;
  label: string;
  createdAt: string;
  durationSec: number;
  segments: number;
}

export function createSnapshot(
  project: Project,
  projectPath: string,
  label: string,
): Promise<SnapshotIndex> {
  return invoke<SnapshotIndex>("create_snapshot", { project, projectPath, label });
}

export function listSnapshots(projectPath: string): Promise<SnapshotIndex[]> {
  return invoke<SnapshotIndex[]>("list_snapshots", { projectPath });
}

export function restoreSnapshot(projectPath: string, id: string): Promise<Project> {
  return invoke<Project>("restore_snapshot", { projectPath, id });
}

export function deleteSnapshot(projectPath: string, id: string): Promise<void> {
  return invoke<void>("delete_snapshot", { projectPath, id });
}
