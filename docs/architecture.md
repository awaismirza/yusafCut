# Architecture

This document explains how the code maps to the spec at the repo root.

## Layered view

```
┌──────────────────────────────────────────────────────────────────┐
│ React + Tauri webview                                            │
│                                                                  │
│   ┌───────────────────────┐   ┌────────────────────────────────┐ │
│   │ TranscriptEditor      │   │ VideoPreview / Waveform        │ │
│   │ (TipTap + Word node)  │◀──┤ (HTML5 <video> + WaveSurfer)   │ │
│   └─────────┬─────────────┘   └────────────┬───────────────────┘ │
│             │                              │                     │
│             ▼                              ▼                     │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │  Zustand stores:  projectStore (EDL) | playerStore | ui  │   │
│   │  + zundo (50-step undo)                                  │   │
│   └────────────────┬─────────────────────────────────────────┘   │
└────────────────────┼─────────────────────────────────────────────┘
                     │ Tauri `invoke` / events
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Rust backend (src-tauri/)                                        │
│                                                                  │
│   commands/{media,transcribe,project,export,misc}                │
│   ├── parse_ffprobe_json (pure, tested)                          │
│   ├── parse_whisper_json (pure, tested)                          │
│   └── filter graph builder (pure, tested)                        │
│                                                                  │
│   sidecar processes:                                             │
│     - ffprobe                                                    │
│     - ffmpeg (with VideoToolbox hw encode/decode)                │
│     - whisper-cli (Core ML + Metal)                              │
│     - mlx-sidecar (optional, Phase 6.3)                          │
└──────────────────────────────────────────────────────────────────┘
```

## The EDL contract

Everything important happens through `Project`:

```ts
type Project = {
  version: 1;
  id: string; name: string;
  createdAt: string; updatedAt: string;
  media: Record<MediaId, SourceMedia>;
  segments: Segment[];              // ORDER MATTERS — this IS the timeline
  settings: { exportPreset; paddingMs };
}
```

**Invariants** (enforced by tests):

1. `Word.start` / `Word.end` are immutable.
2. Source timecodes (`sourceIn`, `sourceOut`) refer to the original media file.
3. Deleting a word range splits the affected segment(s) and drops the middle.
4. `paddingMs` is applied at the *boundary* of cuts only — never to the start of
   the first surviving run or the end of the last surviving run.

`tests/edl.test.ts` is the canonical reference. Read it before changing any
EDL operation.

## Why a single `<video>` element

We chose Option A from spec §4: one `<video>` driving the source media, with
the player jumping over deleted ranges in `timeupdate`. This is "coarse but
works": browsers seek MP4s in tens-of-milliseconds, which is within the spec's
~50 ms accuracy promise.

Option B (pre-render a low-quality proxy) is deferred to v2.

## Cross-platform code that isn't

The Tauri shell supports Linux and Windows, but Scribe explicitly targets
Apple Silicon macOS. The architectural choice rests on whisper.cpp's Core ML +
Metal path and FFmpeg's VideoToolbox. We accept the lock-in for the
performance moat per spec section 1's non-goals.
