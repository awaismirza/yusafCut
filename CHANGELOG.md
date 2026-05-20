# Changelog

All notable changes to Scribe will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
