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

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

export interface TranscribeOptions {
  mediaId: string;
  mediaPath: string;
  modelName: WhisperModel;
  /** Total media duration in seconds — used to compute 0..1 progress. */
  mediaDuration?: number;
}

export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v3-turbo";

export interface TranscribeResult {
  mediaId: string;
  words: Word[];
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
  name: WhisperModel;
  /** Approximate disk size in MB. */
  sizeMb: number;
  /** Whether the model is already downloaded. */
  installed: boolean;
}

export function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models");
}

export function downloadModel(name: WhisperModel): Promise<void> {
  return invoke<void>("download_model", { name });
}

export interface ModelDownloadProgress {
  name: WhisperModel;
  /** 0..1 */
  progress: number;
  bytesDownloaded: number;
  bytesTotal: number;
}

export function onModelDownloadProgress(
  handler: (p: ModelDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<ModelDownloadProgress>("model:download:progress", (e) =>
    handler(e.payload),
  );
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

export function onExportProgress(
  handler: (p: ExportProgress) => void,
): Promise<UnlistenFn> {
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
