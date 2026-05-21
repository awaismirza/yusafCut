# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run tauri:dev       # Full app (Rust + React) — primary dev mode
npm run dev             # Vite only (no Tauri shell, for UI-only iteration)

# Build
npm run tauri:build     # Release .app + .dmg
npm run build:production  # Production macOS build
npm run build:mas       # Mac App Store build

# Test
npm test                # Vitest unit tests (TypeScript/React)
npm run test:rust       # cargo test for Rust
npm run test:all        # All test suites (JS + Rust + Python sidecar)

# Code quality
npm run check           # typecheck + lint (runs both)
npm run lint            # ESLint (max-warnings=0)
npm run typecheck       # tsc --noEmit
npm run format          # Prettier on src/**/*.{ts,tsx,css}

# CI equivalent
npm run ci              # check + test + test:rust + test:sidecar

# Cleanup
npm run clean:all       # Remove node_modules + Rust artifacts
npm run fresh           # Clean install + dev
```

Run a single Vitest test: `npx vitest run tests/edl.test.ts`

## Architecture

Scribe is a **local-first, Apple Silicon-only** text-based video editor built with Tauri 2 (React frontend + Rust backend). Editing the transcript edits the video. All processing is 100% local — no cloud, no telemetry.

### Core invariant: the Edit Decision List (EDL)

The **EDL** is the single source of truth for the project. Every edit operation — deletions, cuts, joins — is expressed as a transformation on the EDL. The EDL lives in `projectStore` (Zustand) on the frontend and is serialized by `src-tauri/src/edl.rs`. Pure EDL logic (no side effects) lives in `src/lib/edl.ts` and is covered by `tests/edl.test.ts`.

### Data flow

```
TranscriptEditor (TipTap/ProseMirror + custom WordNode)
  ↓ user edits
projectStore (Zustand + zundo for 50-step undo/redo)
  ↓ EDL derived state
VideoPreview (HTML5 <video>) + Waveform (WaveSurfer.js)
  ↓ Tauri invoke / events
Rust commands (src-tauri/src/commands/)
  ↓ spawns sidecars
ffprobe / ffmpeg / whisper-cli / mlx-sidecar
```

### Frontend layout (`src/`)

- **`lib/edl.ts`** — pure EDL operations (no imports from React/Tauri)
- **`lib/ipc.ts`** — all Tauri `invoke` wrappers in one place
- **`stores/`** — `projectStore` (EDL + project metadata), `playerStore` (video playback), `jobsStore` (background jobs), `uiStore` (modal state)
- **`components/TranscriptEditor/`** — TipTap editor with custom `WordNode` that maps each word to its EDL segment
- **`components/VideoPreview/`** — single `<video>` element; architecture doc explains why there's only one

### Rust backend (`src-tauri/src/`)

Commands are registered in `commands/mod.rs` and grouped by domain: `media`, `transcribe`, `project`, `export`, `snapshots`, `llm`, `jobs`, `misc`. Business logic lives in the module files (`edl.rs`, `project.rs`, `transcribe.rs`, etc.), not the command handlers.

### Sidecar binaries (`src-tauri/binaries/`)

All binaries are `aarch64-apple-darwin` only:
- `ffmpeg` / `ffprobe` — video encode/decode (VideoToolbox HW acceleration)
- `whisper-cli` — transcription (Core ML + Metal via whisper.cpp)
- `mlx-sidecar` — optional on-device LLM (PyInstaller bundle, `mlx-sidecar` feature flag)
- `whisperkit-cli` — Phase 2 roadmap stub

Fetch scripts: `src-tauri/binaries/fetch.sh` (downloads FFmpeg/FFprobe; whisper-cli must be built manually per `HOW_TO_RUN.md`).

## Key constraints

- **Apple Silicon Mac only** — no Intel support is in scope. All binaries are `aarch64-apple-darwin`.
- **macOS 13.0 minimum** — set in `tauri.conf.json`.
- **AGPL-3.0-or-later** license — changes that touch the core editor must remain open source.
- `macOSPrivateApi` is **disabled** (required for Mac App Store compliance).

## Code style

- Prettier config: double quotes, semicolons, trailing commas, 100-char line width, 2-space indent.
- ESLint enforces `react-hooks` rules and no unused vars (underscore prefix exempted).
- Path alias `@/*` maps to `./src/*`.
- Rust: Edition 2021, release profile uses LTO + `panic = "abort"` + strip.

## Project file format

`.scribe` bundles are directories (not archives) containing the EDL JSON and project metadata. Serialization is in `src-tauri/src/project.rs`.

## Distribution

- **DMG / direct download**: `npm run tauri:build:dmg`
- **Mac App Store**: `npm run build:mas` → `npm run xcarchive` (requires provisioning profile at `src-tauri/Scribe_MAS.provisionprofile` — never committed)
- **GitHub Actions release**: `.github/workflows/release.yml` triggers on release tags
