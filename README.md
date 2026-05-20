# Scribe

> Local-first, text-based video editor for Apple Silicon Macs. Edit the
> transcript — the video edits with it.

Scribe is an open-source desktop app where the **transcript is the timeline**.
Delete words, the corresponding video disappears. Reorder paragraphs, the video
reorders. Everything runs 100% locally using your Mac's CPU/GPU/Neural Engine
— no cloud, no telemetry, no API keys required.

This is a v0.1 MVP scaffold. See [`scribe-spec.md`](../scribe-spec.md) for the
full design document.

## Status

| Phase | Description | State |
|-------|-------------|-------|
| 0 | Project scaffolding | ✅ scaffolded |
| 1 | Media import + FFprobe | 🚧 commands in place; binary not bundled |
| 2 | Whisper transcription | 🚧 commands in place; binary not bundled |
| 3 | Transcript editor UI | ✅ TipTap + Word node implemented |
| 4 | Edit operations | ✅ EDL helpers + delete pipeline |
| 5 | Project save/load | ✅ atomic .scribe bundle round-trip |
| 6 | Export | 🚧 ffmpeg filter graph built; binary not bundled |
| 7 | Polish (icons, notarisation, auto-update) | ⏳ |

"Binary not bundled" means the Rust command code is in place but the actual
sidecar binaries (`whisper-cli`, `ffmpeg`, `ffprobe`) must be obtained
separately — see [`src-tauri/binaries/README.md`](src-tauri/binaries/README.md).

## Quick start

```bash
# Requires Node ≥ 20, Rust stable, and Xcode CLT
nvm use            # picks up .nvmrc
npm install
npm run tauri:dev
```

Before transcribing or exporting, populate the sidecar binaries:

```bash
./src-tauri/binaries/fetch.sh
```

(That script handles ffmpeg/ffprobe; whisper-cli must be built from source.)

## Architecture in one paragraph

The **Edit Decision List (EDL)** is the single source of truth. It's a flat
list of segments, each pointing into a source media file with `sourceIn` /
`sourceOut` timecodes and a slice of `Word`s. The transcript view, the video
player, and the export pipeline all derive their state from this structure.
Edits are pure transformations: deleting a word range splits surrounding
segments and drops the middle. Source timecodes on words are *never* mutated.
See [`docs/architecture.md`](docs/architecture.md).

## Tech stack

- **Tauri 2.x** — native macOS shell, small binary, Rust backend
- **React + TypeScript + Vite** — UI
- **Tailwind + shadcn/ui** — styling
- **TipTap (ProseMirror)** — transcript editor
- **Zustand + zundo** — state + undo
- **WaveSurfer.js** — waveform display
- **whisper.cpp** (Core ML + Metal) — transcription
- **FFmpeg** (VideoToolbox) — video processing
- **MLX** (Python sidecar, opt-in) — local LLM features (Phase 6+)

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (UI only — no Tauri shell) |
| `npm run tauri:dev` | Run the full app in dev mode |
| `npm run tauri:build` | Build a release `.app` / `.dmg` |
| `npm run lint` | ESLint over `src/` and `tests/` |
| `npm run typecheck` | TypeScript --noEmit |
| `npm test` | Vitest unit tests |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust unit tests |

## License

[AGPL-3.0-or-later](LICENSE).

Why AGPL? It protects against closed-source forks of an editor with this much
local-first value. Any networked derivative work must release its source. Per
the spec section 9, reusable libraries we split out may use MIT instead.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
