# YusafCut

> Local-first, transcript-based video editing for Apple Silicon Macs. Edit the
> words; YusafCut edits the video.

YusafCut is an open-source desktop editor for cutting talking-head videos,
podcasts, interviews, courses, screen recordings, and creator clips by editing
their transcript. Delete a word and the matching video disappears. Reorder
paragraphs and the video follows. Everything runs locally on your Mac with no
cloud upload, no telemetry, and no API keys.

The project is built with Tauri, React, TypeScript, Rust, whisper.cpp, and
FFmpeg. It currently targets Apple Silicon Macs.

## Why YusafCut?

- **Transcript-first editing:** the transcript is the timeline, not a side
  panel.
- **Local by default:** media, transcripts, models, and project files stay on
  your machine.
- **Fast Apple Silicon pipeline:** whisper.cpp uses Core ML and Metal; exports
  use FFmpeg with VideoToolbox where possible.
- **Real project files:** `.scribe` bundles store the edit decision list,
  metadata, snapshots, and project state.
- **Open-source foundation:** AGPL-licensed so improvements to the editor stay
  available to the community.

## Status

YusafCut 3.7.0 is production-ready for local-first transcript editing, timeline
preview, and MP4 export on Apple Silicon Macs. The project is pre-1.0 from an
open-source governance and release-process perspective, so expect fast
iteration and some rough edges around packaging.

| Feature | State |
|---|---|
| Media import with FFprobe | Complete |
| Whisper.cpp transcription with Core ML + Metal | Complete |
| Transcript editor with TipTap + custom word nodes | Complete |
| EDL-based edit operations + 50-step undo | Complete |
| Project save/load as `.scribe` bundles | Complete |
| Smart-cut MP4 export with FFmpeg + VideoToolbox | Complete |
| Background job queue with cancellation | Complete |
| Multi-clip editing and Add Clip support | Complete |
| Multi-track audio with music ducking | Complete |
| Project snapshots and named restore points | Complete |
| Toolbar category menus for File, Capture, and Project | Complete |
| Blocking-operation progress dialogs | Complete |
| One-click filler word removal | Complete |
| DTW word-timestamp refinement via `whisper.cpp --dtw` | Complete |
| Cut-point pre-roll padding | Complete |
| Timeline zoom and in/out markers | Complete |
| Speaker diarisation | Experimental |
| Auto-update and notarisation | Planned |

## Screenshots

Screenshots and release assets are not committed yet. If you are evaluating the
project today, run the app locally with `npm run tauri:dev`.

## Requirements

- macOS on Apple Silicon
- Node.js 20 or newer
- Rust stable via `rustup`
- Xcode Command Line Tools
- Sidecar binaries for transcription/export:
  `whisper-cli`, `ffmpeg`, and `ffprobe`

## Quick Start

```bash
git clone https://github.com/awaismirza/yusafCut.git
cd yusafCut
nvm use
npm install
./src-tauri/binaries/fetch.sh
npm run tauri:dev
```

`fetch.sh` handles FFmpeg and FFprobe. The Whisper CLI binary may need to be
built separately depending on your local setup. See
[`src-tauri/binaries/README.md`](src-tauri/binaries/README.md).

## Common Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite UI only |
| `npm run tauri:dev` | Run the full desktop app |
| `npm run tauri:build` | Build a release `.app` and `.dmg` |
| `npm run typecheck` | Run TypeScript checks |
| `npm run lint` | Run ESLint over the frontend |
| `npm test` | Run Vitest unit tests |
| `npm run test:rust` | Run Rust tests |
| `npm run check` | Run typecheck and lint |
| `npm run ci` | Run the full local CI suite |

## How It Works

The Edit Decision List (EDL) is the source of truth. It is a flat list of
segments, each pointing into a source media file with `sourceIn`, `sourceOut`,
and word-level timing metadata. The transcript view, preview player, waveform,
snapshots, and export pipeline all derive from this structure.

Edits are pure transformations. Deleting a word range splits surrounding
segments and drops the middle. Source timecodes on words are never mutated,
which keeps preview, undo, save/load, and export predictable.

Read more in:

- [`docs/architecture.md`](docs/architecture.md)
- [`yusafcut-spec.md`](yusafcut-spec.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/manual-test.md`](docs/manual-test.md)

## Privacy Model

YusafCut is local-first:

- Your media is not uploaded.
- Generated transcripts stay on your machine.
- There is no telemetry, analytics, or remote crash reporting in v1.
- Network access is limited to model downloads and, once enabled, release
  update metadata.

See [`SECURITY.md`](SECURITY.md) for the current threat model and vulnerability
reporting process.

## Project Files

YusafCut currently saves projects as `.scribe` bundles. The extension is kept
for compatibility with existing project files while the product name changes to
YusafCut.

## Tech Stack

- **Tauri 2.x:** native macOS shell and Rust backend
- **React + TypeScript + Vite:** frontend app
- **Tailwind + shadcn/ui:** styling and UI primitives
- **TipTap / ProseMirror:** transcript editing surface
- **Zustand + zundo:** state management and undo
- **WaveSurfer.js:** waveform display
- **whisper.cpp:** local transcription
- **FFmpeg:** media processing and export

## Contributing

Contributions are welcome. Please start with
[`CONTRIBUTING.md`](CONTRIBUTING.md), especially the EDL invariants and testing
expectations. For larger architectural changes, open an issue first so the
direction can be discussed before implementation.

Good first contribution areas:

- Improve onboarding and setup docs.
- Add screenshots and short demo assets.
- Expand manual and automated regression coverage.
- Improve packaging, signing, notarisation, and release automation.
- Polish accessibility and keyboard workflows.

## Security

Please do not open public issues for vulnerabilities. Follow the private
reporting process in [`SECURITY.md`](SECURITY.md).

## License

YusafCut is licensed under
[AGPL-3.0-or-later](LICENSE).

The AGPL protects against closed-source hosted or networked forks of an editor
with this much local-first value. Reusable libraries split out of this repo may
use a more permissive license in the future.
