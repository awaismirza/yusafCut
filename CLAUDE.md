# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Workflow rules (mandatory — follow for every task)

### 1. Every feature or fix starts on a new branch
Always create a new branch from `main` before beginning any change:
```bash
git checkout main && git pull origin main
git checkout -b feature/<short-description>   # or fix/, chore/, docs/
```

### 2. Bump the version on every meaningful commit
Every feature branch that will be merged to `main` must bump the version in:
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package] version`
- `src-tauri/tauri.conf.json` → `"version"`

Use semantic versioning (semver):
- `patch` (x.x.**Z**) — bug fixes, tiny tweaks
- `minor` (x.**Y**.0) — new features, non-breaking
- `major` (**X**.0.0) — breaking changes

### 3. Commit only — never create the PR or merge
After committing, push the branch:
```bash
git push -u origin <branch-name>
```
**Do NOT create the PR or merge.** Awais will do that manually when ready. The one exception is when Awais explicitly asks you to push, create PR, and merge — then do it in one go and create the version tag.

### 4. Keep docs updated on every change
Every time you implement a feature or fix a bug you **must** also update in the same commit:
- `CHANGELOG.md` — add an entry under `[Unreleased]` or the new version section
- `docs/architecture.md` — if the data flow, component layout, or Rust structure changed
- `README.md` — if the feature table, status, or tech stack changed
- `docs/yusafcut-spec.md` — if spec sections describing the changed behaviour are outdated

No code commit should land without the corresponding doc update.

---

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

---

## Architecture

YusafCut is a **local-first, Apple Silicon-only** text-based video editor built with Tauri 2 (React frontend + Rust backend). Editing the transcript edits the video. All processing is 100% local — no cloud, no telemetry.

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
- **`stores/`** — `projectStore` (EDL + project metadata), `playerStore` (video playback), `jobsStore` (background jobs), `uiStore` (modal state + operation loaders)
- **`components/Toolbar/`** — top toolbar with responsive overflow dropdowns (collapses at < 860 px), all progress dialogs, and transcription settings
- **`components/Toolbox/`** — inline editing tools: markers, trim silences, chapters, b-roll, zoom
- **`components/TranscriptEditor/`** — TipTap editor with custom `WordNode` that maps each word to its EDL segment
- **`components/VideoPreview/`** — single `<video>` element; see `docs/architecture.md` for why

### UI loading pattern

Every operation that blocks the UI **must** show an indeterminate progress dialog via `uiStore`:

| Store field | When it is `true` / non-null |
|---|---|
| `mediaLoading` | Media file is being probed by ffprobe |
| `transcribeProgress` | Whisper is running |
| `exportingProgress` | FFmpeg export is in progress |
| `modelDownloadProgress` | A Whisper model is being downloaded |
| `editOperationLabel` | Any heavy synchronous edit (Trim Silences, AI chapters, B-roll, etc.) |

To add a loader for a new heavy operation:
1. Set `useUIStore.getState().setEditOperationLabel("Doing X…")` before the work starts
2. Wrap the actual work in a double `requestAnimationFrame` so the dialog renders first
3. Call `setEditOperationLabel(null)` in the `finally` block

### Rust backend (`src-tauri/src/`)

Commands are registered in `commands/mod.rs` and grouped by domain: `media`, `transcribe`, `project`, `export`, `snapshots`, `llm`, `jobs`, `misc`. Business logic lives in the module files, not the command handlers.

### Transcription engine

YusafCut uses **whisper.cpp** exclusively for transcription via the `whisper-cli` sidecar binary with Core ML + Metal acceleration.

Key flags for timestamp accuracy:
- `--split-on-word` — per-token word boundaries
- `--word-thold 0.01` — keep all tokens
- `--max-len 0` — unbounded segment length (prevents timestamp compression drift)
- `--best-of 5 --beam-size 5` — beam search for quality

> **WhisperKit / ANE restoration note:** WhisperKit was removed in v3.2.0 because ANE-quantized models caused video/text drift. To restore it, run:
> `git show 4726d25:src-tauri/src/commands/transcribe.rs` (Rust)
> `git show 4726d25:src/components/Toolbar/Toolbar.tsx` (frontend engine picker)

### Sidecar binaries (`src-tauri/binaries/`)

All binaries are `aarch64-apple-darwin` only:
- `ffmpeg` / `ffprobe` — video encode/decode (VideoToolbox HW acceleration)
- `whisper-cli` — transcription (Core ML + Metal via whisper.cpp)
- `mlx-sidecar` — optional on-device LLM (PyInstaller bundle, `mlx-sidecar` feature flag)

Fetch scripts: `src-tauri/binaries/fetch.sh` (downloads FFmpeg/FFprobe; whisper-cli must be built manually per `HOW_TO_RUN.md`).

---

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
- **Mac App Store**: `npm run build:mas` → `npm run xcarchive` (requires provisioning profile at `src-tauri/YusafCut_MAS.provisionprofile` — never committed)
- **GitHub Actions release**: `.github/workflows/release.yml` triggers on release tags
