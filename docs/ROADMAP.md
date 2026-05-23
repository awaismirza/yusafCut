# YusafCut — Commercial Roadmap

This document is the running spec for what needs to land between today's
v2.1 pro pass and a shippable commercial product. Each item is sized
honestly — t-shirt size (S/M/L/XL) for effort, and a one-line rationale
explaining why the feature moves YusafCut out of "MVP" and into "a thing
people pay for."

Anything marked **Shipped in v2.1** below already lives on `main`. Everything
else is opinion; pick what to schedule.

## Shipped in v2.1

| Feature | Why it matters |
| --- | --- |
| Frame-accurate sync (`requestVideoFrameCallback`) | Removes the ~16 ms drift the rAF loop had on 24/30 fps content. The word highlight now actually lands on the spoken word. |
| Horizontal-scroll virtual timeline + minimap + Cmd-wheel zoom | Editing a 90-min podcast at 1× zoom is useless. 32× zoom + smooth panning makes YusafCut usable for long-form. |
| SRT / VTT caption export | Most paying creators *already* re-edit captions in Final Cut Pro / Premiere. Saves them that round-trip. |
| One-click silence trim | The "remove ums" demo from Descript that goes viral. Pure EDL — instant, undoable. |
| Chapter markers + ffmpeg `[CHAPTER]` metadata | YouTube auto-detects them on upload. Spotify, Apple Podcasts read the same blocks. |

## Shipped in v2.2 (this branch)

| Feature | Why it matters |
| --- | --- |
| Smart-cut export (stream-copy interior, re-encode at boundaries) | 30-minute exports finish in seconds. The single biggest demo improvement we have. |
| Background job queue with cancel + persisted progress | Exports, transcriptions, and model downloads survive a reload; the Jobs flyout shows progress and ETA per job. |
| Multi-track audio (music bed + sidechain ducking) | Podcast/voice-over creators get a real music mix at export, including auto-ducking under the speaker. |
| Project history / named snapshots | Pin restore points inside the .scribe bundle. Survives restarts and ships with the project. |

---

## Tier 1 — quick wins that visibly raise the value floor (S/M)

> **Shipped in v2.2.** See `Shipped in v2.2` above for the implementation notes.
> Originally documented as four pieces of work, all of which now live on
> `main`:

### Smart-cut export (stream-copy interior, re-encode at boundaries) — **L**
Currently every export re-encodes 100% of the timeline through
`h264_videotoolbox`. For a 30-min talk with 20 cuts, that's 30 minutes of
GPU encoding to save maybe 90 seconds of content. The professional
behaviour is to *stream-copy* the long interior of each segment and only
re-encode a few hundred frames either side of each cut so the GOP
structure remains valid.

Why now: the engine already has the EDL and uses ffmpeg. Two-pass split
(`-c copy` segments, then short re-encode segments, then concat) drops
export time 10–50×. Sells itself on the "export speed" demo.

**Risks:** keyframe alignment varies by codec/container; needs robust fallback
to full re-encode for sources without seekable GOPs (some screen recordings).

### Background job queue with cancel + persisted progress — **M**
Today's export, transcribe, and download are each one-shot async calls. If
the app is reloaded mid-export the work is lost; you can't queue a second
job while one runs.

Plan: a `JobQueue` in Rust holding a `Vec<Job>` per kind, a stable id per
job, and a `job:progress` event keyed by id. Frontend gets a small "Jobs"
flyout in the status bar showing running + queued items.

### Multi-track audio (music bed, ducking) — **L**
A "podcast" preset that mixes a music track under the spoken EDL with
auto-ducking (`sidechaincompress` in ffmpeg). The data model needs one
new track type (`AudioTrack { mediaId; gainDb; offsetSec; ducks: bool }`).
Major credibility boost — most local-first editors don't have this.

### Project history / branches — **M**
Today undo is 50 steps in memory. For commercial use we need *named*
restore points (`Snapshot v3 — before client edits`). Save them as
sibling files in the project bundle so they survive restarts. The whole
project is small JSON — gzip per snapshot is fine.

---

## Tier 2 — competitive moat (M/L)

### Better transcription engines

Three real options on Apple Silicon, ranked by likely payoff:

1. **WhisperKit** (Argmax / Apple-friendly Core ML port of Whisper).
   Faster than whisper.cpp on Apple Silicon because it skips the CPU
   roundtrips and uses ANE directly. Same model files we already
   distribute (`ggml-*` → `mlpackage`). Sidecar binary + a new
   `TranscriptionEngine` enum in the transcribe IPC.
2. **Parakeet-MLX** (NVIDIA Parakeet TDT on Apple's MLX). Reports
   ~5× real-time on M2 with `large-v3`-class accuracy. Trickier to
   bundle because MLX is Python; we'd need a sidecar that we currently
   only scaffold for `mlx-llm`. Worth it for the speed claim alone —
   "transcribe a 90-minute interview in 60 seconds" is a sellable
   benchmark.
3. **Whisper-large-v3** via whisper.cpp with `--flash-attn` once that
   lands stable in the binary we ship. Smallest delta; probably ~30%
   faster on existing models.

Recommendation: pick **WhisperKit** first because it reuses our model
distribution, then evaluate Parakeet if a buyer asks for it.

### Speaker diarisation — **L**
Identify who's speaking when. Two paths:

- `pyannote-audio` via a Python sidecar (cleanest results, ~200 MB model).
- `whisper.cpp` already emits per-segment speaker tokens with the right
  args (`--diarize`) but quality is mediocre.

UI: each surviving word stays as-is; we add a "Speaker" column to the
transcript editor and a coloured ribbon on the timeline rail per
speaker. Editing the speaker name in one place updates everywhere.

### AI chapter detection (using the existing MLX-LLM sidecar) — **M**
The sidecars/mlx-llm folder is already scaffolded. Build a `summarise`
command that takes the full transcript, runs Llama-3.1-8B in 4-bit
locally, and asks for "10 chapter titles with timestamps". Insert them
as draft chapters the user can edit. Demo gold; nobody else does this
fully on-device.

### B-roll suggestions — **L**
For each ~30 s span, ask the LLM for 3 b-roll concepts (Unsplash queries
or local-file hints). Drop them as comment-style annotations on the
timeline; user clicks to insert. Easy "wow" moment in a demo.

### Multi-language support — **S** (UI) + **M** (translate)
Whisper already supports 99 languages. We just need a language picker
in the transcribe dialog and a "translate transcript" toggle that runs
Whisper in `--translate` mode (English output).

---

## Tier 3 — platform plays (XL)

### Cloud sync / collaboration
Optional sync of the EDL (NOT the media) to a backend so two editors can
work on the same project. Keep it CRDT-friendly because the EDL is
already an immutable-style data structure. Stripe-priced subscription.

### Browser viewer (read-only)
Render the EDL + a public link to the underlying media as a streaming
HLS preview. Lets the editor share a "v2" with a client before exporting.
Bumps YusafCut from "tool" to "collaboration product".

### Plug-in API
Expose a small typescript hook surface (`useEDL`, `registerSidebarTool`)
so third parties can add things like accessibility checks, language
linters, AI features, etc. Becomes a marketplace later.

### Color / vision controls
LUT loading, basic three-way colour, vignette / film-grain. Apple's
`Core Image` filters can be wired through a metal shader on the preview
side. This is where YusafCut stops being "for talking-head content" and
starts being "for any video".

---

## Engineering hygiene to do *while* shipping the above

- Move the playerStore + projectStore into a single normalized shape.
  The current split is fine, but two stores firing reset/clear during
  load is brittle.
- Wrap the rVFC frame clock in a small test that drives a mock video
  element — currently sync correctness is asserted only by eyeball.
- Add a `tests/captions.ffmpeg.test.ts` (or Rust integration test) that
  pipes the generated chapter ffmetadata file through `ffmpeg -t 0` to
  ensure it's actually well-formed every commit.
- Promote `useUIStore.pushToast` to a proper notification centre with
  history; the current one-line toast scrolls away too quickly during
  long export jobs.

---

## How to read this doc

Each section is a real proposal — implementation paths, dependencies and
known risks called out. Pick the items that match the next release
theme; they're not in execution order.
