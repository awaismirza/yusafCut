# Changelog

All notable changes to Scribe will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.0] - 2026-05-21

### Added
- **Responsive toolbar overflow.** The top toolbar now uses a `ResizeObserver`
  to detect when the window is too narrow (< 860 px) and collapses each button
  group into a "More ▾" dropdown. Nothing is hidden — every action is always
  reachable.
- **Indeterminate progress dialog for blocking edits.** Any heavy synchronous
  operation (Trim Silences, etc.) now shows a centred modal with a spinning
  indicator and a label so the app never looks frozen. The pattern is driven by
  `uiStore.editOperationLabel` — set a string to show the dialog, set `null` to
  dismiss it. New operations follow the same two-`requestAnimationFrame` deferred
  pattern so React renders the dialog before the work begins.
- **Project open loader.** Opening a `.scribe` file now shows the existing
  media-loading spinner so large projects don't silently stall the UI.

### Changed
- **Whisper.cpp accuracy improvements.** Added `--max-len 0` (eliminates
  segment-length-cap timestamp compression drift), `--best-of 5`, and
  `--beam-size 5` for higher-quality transcripts and better word-timestamp
  alignment.
- **Fixed token-offset ambiguity.** `token_offsets_ms` now correctly handles
  the `seg.from == 0` edge case where absolute and relative token offsets look
  identical, preventing rare timestamp doubling at the start of recordings. Also
  adds a safety clamp (`end = end.max(start + 1)`) to guard against
  zero-duration words from corrupted JSON.

### Removed
- **WhisperKit / ANE engine removed.** The WhisperKit engine and
  `whisperkit-cli` sidecar are removed because ANE-quantized models produced
  inaccurate word timestamps that caused video/text drift. The full
  implementation is preserved in git at commit `4726d25`; restore it with
  `git show 4726d25:src-tauri/src/commands/transcribe.rs`.

## [2.2.0] - 2026-05-21

### Added
- **Smart-cut export.** The exporter now stream-copies the long interior of
  each EDL segment and only re-encodes a few hundred frames either side of
  each cut. Typical 30-minute exports finish in seconds instead of minutes.
  Eligibility falls back to the full re-encode path when the EDL mixes
  multiple source codecs, requests a resolution / fps / codec change, or the
  source has no usable keyframes. A "Force full re-encode" toggle in the
  export dialog lets users opt out.
- **Background job queue.** Exports, transcriptions, and model downloads
  now register as cancellable jobs in a queue that persists across app
  restarts. The new "Jobs" flyout in the StatusBar shows progress, ETA, and
  errors per job, and a single click cancels the running task.
- **Multi-track audio with ducking.** A new "Music" panel adds music beds /
  sfx that the exporter mixes under the main spoken EDL. Each track has its
  own gain, offset, and an optional sidechain-ducking toggle that drops the
  music ~12 dB whenever the speaker is talking.
- **Project snapshots.** Named restore points stored inside the .scribe
  bundle as gzipped JSON. Survive restarts and travel with the project file.
  Accessed via the new "Snapshots" toolbar button.

### Changed
- Export `Codec` selector defaults to "Match source (smart-cut)" so the fast
  path engages without the user thinking about it; explicit H.264 / HEVC
  still works and skips smart-cut.
- Resolution defaults to "Original" so smart-cut isn't disabled by an
  accidental rescale.

## [1.3.0] - 2026-05-20

### Added
- Timeline-docked editing toolbox with working in/out marker controls, marker
  clearing, transcript search access, and timeline zoom.
- Configurable delete-gap padding for transcript search/filler removals, from
  0 to 10 seconds.
- Indeterminate progress animation for local transcription and media probing
  when reliable percentages are unavailable.

### Changed
- Removed non-functional Razor, Slip, and Slide tool buttons in favor of
  controls that are wired to real editing behavior.
- Pausing playback from Space/K/the preview button now restores playback speed
  to 1x.

## [1.1.0] - 2026-05-20

### Added
- Transcript cache keyed by media hash so already-transcribed videos reopen with
  their transcript without rerunning Whisper.
- Transcript and timeline selection sync: marked timeline ranges now highlight
  the matching words in the transcript.

### Changed
- Transcript editing is now selection-and-delete only. Users can select words
  and remove the matching video range, but cannot type over or replace transcript
  text.

### Fixed
- `Cmd+Z` no longer undoes media import, project open, or transcription loading.
  Undo history now starts at intentional edit operations.
- Common edit shortcuts guard against empty undo/redo stacks and selected-word
  deletes clear the native text selection after the EDL update.

## [1.0.0] - 2026-05-20

### Added
- MVP-ready local media playback through Tauri's asset protocol.
- Transcript-driven preview, filler highlighting, ripple delete, and export controls.
- Timeline in/out markers with `I`/`O`, `Cmd+Delete` ripple delete, and J/K/L transport.
- Left editor toolbox with Select, Razor, Slip, and Slide tools.
- Centered progress modals for media loading, transcription, model download, and export.
- Initial project scaffold for Phases 0–6 of the spec.
- EDL data model (TypeScript + Rust) with full round-trip tests.
- TipTap-based transcript editor with custom Word inline node.
- Zustand project store with zundo undo middleware (50-step history).
- Rust commands for media import (FFprobe), transcription (whisper.cpp), project
  save/load, and export (FFmpeg + VideoToolbox).
- Vitest + Cargo test suites covering EDL ops, timecode helpers, FFprobe parser,
  Whisper JSON parser, and the ffmpeg filter graph builder.
- GitHub Actions CI workflow (lint, typecheck, test, build).

### Post-1.0
- Sidecar binaries are not bundled — see `src-tauri/binaries/README.md`.
- Auto-update manifest signing.
- Code-signed `.dmg` distribution.
- Filler-word detection, speaker diarisation, LLM features (Phase 2 of the spec).
