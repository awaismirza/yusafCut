# Changelog

All notable changes to Scribe will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
