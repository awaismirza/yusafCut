# Scribe — Local-First Text-Based Video Editor for Apple Silicon

> **Hand this entire document to Claude Code as the project brief.** It is structured so you can paste it whole, or paste it phase-by-phase as you build.

---

## 1. What we're building

An open-source desktop video editor for macOS (Apple Silicon) where **the transcript IS the timeline**. Delete words in the transcript, the corresponding video disappears. Reorder paragraphs, the video reorders. Everything runs **100% locally** using the Mac's CPU/GPU/Neural Engine — no cloud, no telemetry, no API keys required.

**Product name (working):** Scribe
**License:** AGPL-3.0 (or MIT — decide before first public release)
**Target user:** Podcasters, YouTubers, course creators, journalists, anyone who edits talking-head or interview video.

### Core value proposition

- **Edit video like a Google Doc.** The transcript is the primary editing surface.
- **Fully local.** Works on a plane. Your footage never leaves your machine.
- **Apple Silicon native.** Whisper runs on Metal/ANE. LLM features use MLX. Video uses VideoToolbox hardware encode/decode.
- **Open source.** Anyone can audit, fork, or self-host.

### Explicit non-goals (v1)

- No multi-camera / multi-track NLE features (Premiere/Resolve territory).
- No color grading, no VFX, no motion graphics.
- No Windows / Linux build for v1 (Apple Silicon optimization is the moat).
- No collaboration / cloud sync.
- No mobile app.

---

## 2. Tech stack (locked decisions)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2.x** | Native macOS feel, small binary, Rust core, web frontend. Lighter than Electron. |
| Frontend | **React + TypeScript + Vite** | Standard, fast, good ecosystem for the transcript UI. |
| UI components | **shadcn/ui + Tailwind CSS** | Composable, themeable, ships nothing you don't use. |
| Transcript editor | **TipTap (ProseMirror)** | Battle-tested rich-text editor; perfect fit for word-timestamp metadata on nodes. |
| State | **Zustand** | Minimal, no boilerplate, works great with undo middleware. |
| Backend (in-process) | **Rust** (Tauri commands) | FFI to whisper.cpp, FFmpeg, MLX via sidecar. |
| Transcription | **whisper.cpp** with Core ML + Metal | Fastest local Whisper on Apple Silicon. |
| Video processing | **FFmpeg** with VideoToolbox | Hardware H.264/HEVC encode/decode. |
| Local LLM (optional) | **MLX (Python sidecar)** or **llama.cpp** | MLX is Apple-native; llama.cpp is more portable. Start with MLX. |
| Player | **HTML5 `<video>`** driven by an EDL | Simpler than embedding AVPlayer; good enough for v1. Re-evaluate for v2. |
| Waveform | **WaveSurfer.js** | Mature, performant, integrates with our timestamp model. |
| Packaging | **Tauri bundler** → `.dmg` | Universal binary, code-signed, notarized. |

### Project layout

```
scribe/
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/       # Tauri command handlers
│   │   ├── transcribe.rs   # whisper.cpp FFI
│   │   ├── media.rs        # FFmpeg wrapper
│   │   ├── edl.rs          # Edit Decision List logic
│   │   ├── project.rs      # Project file I/O
│   │   └── llm.rs          # Sidecar process management
│   ├── binaries/           # Bundled whisper-cli, ffmpeg, mlx-sidecar
│   └── Cargo.toml
├── src/                    # React frontend
│   ├── components/
│   │   ├── TranscriptEditor/
│   │   ├── VideoPreview/
│   │   ├── Waveform/
│   │   ├── Toolbar/
│   │   └── ui/             # shadcn components
│   ├── stores/             # Zustand stores
│   ├── lib/
│   │   ├── edl.ts          # EDL types & helpers
│   │   ├── ipc.ts          # Tauri invoke wrappers
│   │   └── timecode.ts
│   ├── App.tsx
│   └── main.tsx
├── sidecars/
│   └── mlx-llm/            # Python MLX sidecar (packaged as binary)
├── docs/
├── tests/
└── package.json
```

---

## 3. The Edit Decision List (EDL) — central data model

Everything in the editor is a thin layer over a single immutable data structure: the **EDL**. Get this right and the rest is plumbing.

```ts
// src/lib/edl.ts

export type MediaId = string; // UUID for an imported source file

export interface SourceMedia {
  id: MediaId;
  path: string;              // absolute path on disk
  duration: number;          // seconds
  fps: number;
  width: number;
  height: number;
  audioSampleRate: number;
  sha256: string;            // for project integrity
}

export interface Word {
  id: string;                // stable UUID — survives edits
  text: string;
  start: number;             // seconds, relative to source media
  end: number;
  confidence: number;        // 0..1 from Whisper
  speaker?: string;          // optional speaker label
}

export interface Segment {
  id: string;
  mediaId: MediaId;
  words: Word[];             // contiguous slice of original transcription
  // Derived: segment in/out come from words[0].start and words[-1].end
  // BUT we store explicit `sourceIn`/`sourceOut` to support trimming
  // beyond word boundaries (e.g. preserving breath room).
  sourceIn: number;
  sourceOut: number;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  media: Record<MediaId, SourceMedia>;
  segments: Segment[];       // ORDER MATTERS — this is the timeline
  settings: {
    exportPreset: "youtube-1080p" | "podcast-audio" | "custom";
    paddingMs: number;       // default audio padding around cuts, e.g. 80ms
  };
}
```

### Key invariants

1. **Words are never mutated.** Deletes remove words from a segment (or split a segment). Words never have their `start`/`end` rewritten.
2. **Source timecodes are immutable.** A word's `start`/`end` always refers to the original source media. The "output" timeline is derived by concatenating segments in order.
3. **Segments are the unit of cut.** Deleting a range of words splits the segment at the boundary and drops the middle segment.
4. **All edits are EDL transformations.** No edit ever touches a video file until export.

### Derived: output timeline

```ts
// Pure function — given an EDL, compute the output time of each word
export function computeTimeline(project: Project): TimelineEntry[] {
  let outputCursor = 0;
  const result: TimelineEntry[] = [];
  for (const seg of project.segments) {
    const segDuration = seg.sourceOut - seg.sourceIn;
    result.push({
      segmentId: seg.id,
      mediaId: seg.mediaId,
      sourceIn: seg.sourceIn,
      sourceOut: seg.sourceOut,
      outputStart: outputCursor,
      outputEnd: outputCursor + segDuration,
    });
    outputCursor += segDuration;
  }
  return result;
}
```

---

## 4. MVP scope (Phase 1 — ship in ~4–6 weeks of focused work)

**Definition of MVP:** A single-user can open a `.mp4`, get a transcript, delete words, preview the cut, and export a new `.mp4`. That's it.

### MVP feature list

- [ ] Open a single video file (`.mp4`, `.mov`)
- [ ] Transcribe with Whisper (`large-v3-turbo` default, model picker in settings)
- [ ] Display transcript with word-level highlighting synced to playback
- [ ] Click any word → seek video to that timestamp
- [ ] Select word range → delete → segment splits, preview reflects cut
- [ ] Undo / redo (50 steps)
- [ ] Save / load project file (`.scribe` — JSON + media references)
- [ ] Export cut video as `.mp4` (H.264, AAC, hardware-accelerated)
- [ ] First-run flow: download Whisper model on demand, show progress

### Out of MVP scope (Phase 2+)

- Multiple source files / multi-clip projects
- Filler word detection ("um", "uh", "you know")
- Speaker diarization
- LLM-powered editing ("cut this to 90 seconds", "remove tangents")
- Subtitle/caption export (SRT, VTT)
- Custom export presets
- Reorder paragraphs by drag
- Search & replace in transcript
- B-roll / overlay tracks

---

## 5. Build plan — phase by phase

### Phase 0 — Project scaffolding (Day 1)

**Goal:** Empty Tauri app launches, shows "Hello Scribe", builds to a `.dmg`.

Tasks for Claude Code:
1. `npm create tauri-app@latest scribe` — React + TypeScript template.
2. Add Tailwind, shadcn/ui, Zustand, TipTap, WaveSurfer.js.
3. Configure `tauri.conf.json` for macOS-only build, set bundle identifier `dev.scribe.app`.
4. Set up `pnpm` (preferred) or `npm` scripts: `dev`, `build`, `lint`, `test`.
5. Add Vitest + React Testing Library.
6. Add Rust test scaffolding (`cargo test` working).
7. Set up GitHub Actions CI: lint, typecheck, test, build (don't sign yet).
8. Write a one-page `CONTRIBUTING.md`.

**Acceptance:** `pnpm tauri dev` launches a window. `pnpm tauri build` produces an unsigned `.app`.

---

### Phase 1 — Media import + FFprobe (Day 2–3)

**Goal:** User drags a video in, we extract metadata and show it.

Tasks:
1. Bundle a static `ffmpeg` and `ffprobe` binary for `arm64-apple-darwin` into `src-tauri/binaries/`. Use the Tauri "external binary" pattern with the `-aarch64-apple-darwin` suffix so they ship correctly.
2. Rust command `import_media(path) -> SourceMedia`:
   - Run `ffprobe -v error -print_format json -show_format -show_streams`.
   - Parse duration, fps, dimensions, audio sample rate.
   - Compute SHA-256 of file (streaming, don't load into memory).
   - Return `SourceMedia` struct.
3. Frontend: drag-and-drop zone, file picker, recent-files list (stored in Tauri's `appDataDir`).
4. Show imported media info in a sidebar.

**Acceptance:** Drag in `test.mp4`, see filename, duration, resolution displayed correctly.

---

### Phase 2 — Whisper transcription pipeline (Day 4–8)

**This is the hardest phase. Get it right.**

**Goal:** Click "Transcribe" → see progress → get word-level JSON back.

Tasks:
1. **Bundle whisper.cpp.** Build `whisper-cli` from source with Core ML and Metal flags:
   ```
   WHISPER_COREML=1 WHISPER_METAL=1 make -j
   ```
   Ship the binary in `src-tauri/binaries/`. Also ship the Core ML model conversion script.

2. **Model management.** On first transcribe:
   - Show model picker: `tiny`, `base`, `small`, `medium`, `large-v3-turbo` (default).
   - Download from Hugging Face: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin`.
   - Also download the Core ML companion: `ggml-{model}-encoder.mlmodelc.zip`, unzip.
   - Store in `~/Library/Application Support/dev.scribe.app/models/`.
   - Show download progress, support resume, verify SHA-256.

3. **Audio extraction.** Before transcribing, extract 16kHz mono WAV from the video:
   ```
   ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le tmp.wav
   ```

4. **Run whisper-cli** with word-level timestamps:
   ```
   whisper-cli -m model.bin -f tmp.wav --output-json-full --word-thold 0.01 -ml 1
   ```
   `-ml 1` forces max 1 token per segment (gives word-level segments). Parse the JSON.

5. **Stream progress.** whisper-cli writes progress to stderr — parse lines like `[00:00:30.000 --> 00:00:32.500]` and emit Tauri events to the frontend so the UI can show a progress bar.

6. **Convert to our `Word[]` schema.** Generate stable UUIDs. Drop tokens that are pure whitespace/punctuation artifacts.

7. **Build initial EDL.** One segment containing all words, `sourceIn=0`, `sourceOut=duration`.

**Acceptance:** Transcribe a 5-minute video, get accurate word-level JSON, total time under 60 seconds on M2 Pro with `large-v3-turbo`.

**Gotchas:**
- Core ML model conversion happens once at first-load and takes 30–60s — show a "Optimizing model for your Mac" message.
- whisper.cpp's word timestamps are approximate. Don't promise frame-accuracy; promise ~50ms accuracy.
- Some users will have files in formats ffmpeg can't decode without extra codecs — catch and show a friendly error.

---

### Phase 3 — Transcript editor UI (Day 9–14)

**Goal:** Render the transcript. Click to seek. Select to highlight.

Tasks:
1. **TipTap setup with custom Word node.** Each word is a TipTap node with attributes `{ wordId, start, end, confidence }`. Words are inline nodes inside paragraph nodes.
2. **Render strategy.** Paragraphs are grouped by speaker (later) or by sentence-end punctuation + pause heuristics (now). A pause > 750ms starts a new paragraph.
3. **Playback sync.** Subscribe to `<video>` `timeupdate`. Find the word whose `[start, end]` brackets `currentTime`. Add a CSS class `is-playing` to that word. Smooth-scroll if it goes off-screen.
4. **Click to seek.** Click a word → set `video.currentTime = word.start`.
5. **Selection.** Standard text selection works because TipTap is just contenteditable underneath. Track which words are selected via ProseMirror's selection state.
6. **Low-confidence styling.** Words with `confidence < 0.6` get a subtle yellow underline so the user knows to verify them.

**Acceptance:** Open a transcribed video. Words highlight as it plays. Click any word, it seeks. Drag-select a range, see selection.

---

### Phase 4 — The actual editing (Day 15–18)

**Goal:** Delete selected words → video plays without that part.

Tasks:
1. **Delete operation.** When user presses Delete/Backspace with a word selection:
   - Find the segment(s) containing the selected words.
   - Split each affected segment at the selection boundaries (creating up to 3 segments per original).
   - Remove the middle segment(s) — the ones fully inside the selection.
   - Apply `paddingMs` (default 80ms) — keep that much audio before/after each surviving segment edge to avoid clipped consonants.
   - Recompute output timeline.
2. **Player playback over the EDL.** This is subtle. Options:
   - **Option A (chosen for MVP):** Use a single `<video>` element. On `timeupdate`, check if `currentTime` is inside a "deleted" range; if so, jump to the next surviving segment's `sourceIn`. Coarse but works.
   - **Option B (defer):** Pre-render a low-quality proxy of the cut version. Smoother but adds latency.
3. **Undo/redo.** Wrap the Zustand store with an undo middleware (e.g. `zundo`). Snapshot the EDL on every edit. Cap at 50 steps.
4. **Visual feedback.** Deleted words don't disappear from the transcript — they get struck-through and greyed out. The user can re-select and "restore" them (which un-deletes the corresponding segment).

**Acceptance:** Delete a sentence, hit play, the audio/video skips that sentence cleanly. Undo brings it back.

**Critical:** The transcript view and the video view must never drift out of sync. The single source of truth is the EDL.

---

### Phase 5 — Project save/load (Day 19–20)

**Goal:** Quit the app, come back, pick up exactly where you left off.

Tasks:
1. **`.scribe` file format.** A folder (presented as a single file via macOS bundle, like `.app`) containing:
   ```
   MyProject.scribe/
   ├── project.json        # the Project struct
   ├── transcripts/        # raw whisper output per media
   └── media-refs.json     # original paths + SHA-256 for relinking
   ```
2. **Don't copy media into the project.** Reference by absolute path. If the file moves, show a "relink media" dialog using SHA-256 to confirm matches.
3. **Auto-save.** Every 30 seconds + on every edit (debounced 2s). Write atomically (write to `.tmp`, then rename).
4. **Recent files menu.** Standard macOS recent items.

**Acceptance:** Edit a project, quit, reopen, every edit is preserved.

---

### Phase 6 — Export (Day 21–24)

**Goal:** Render the EDL to a final `.mp4`.

Tasks:
1. **Generate FFmpeg concat filter.** For each segment in order, build an `-ss <sourceIn> -to <sourceOut> -i <media>` plus a `concat` filter graph.
2. **Hardware-accelerated encode:**
   ```
   ffmpeg -hwaccel videotoolbox \
     [inputs and concat filter] \
     -c:v h264_videotoolbox -b:v 8M \
     -c:a aac -b:a 192k \
     -movflags +faststart \
     output.mp4
   ```
3. **Progress.** Parse ffmpeg's `out_time_ms=` from `-progress pipe:1`. Emit Tauri events. Show a progress bar with ETA.
4. **Cancellation.** Send SIGTERM to the ffmpeg child process.
5. **Export presets.**
   - **YouTube 1080p:** H.264, 8 Mbps, AAC 192k, faststart.
   - **Podcast audio:** strip video, AAC 128k, output `.m4a`.
   - **Custom:** expose bitrate, codec.

**Acceptance:** Export a 5-minute edit, get a clean `.mp4` that plays in QuickTime, takes under 30s on M2 Pro.

**Critical:** Use stream-copy (`-c copy`) when no re-encoding is needed (e.g. cuts on keyframes only) — drops export time to seconds. For frame-accurate cuts, you must re-encode the cut boundaries; do a "smart cut" where most of the video is copied and only the few seconds around each cut are re-encoded. This is the killer feature for export speed. Implement re-encode-all for v1, smart-cut for v1.1.

---

### Phase 7 — Polish for MVP release (Day 25–30)

- [ ] App icon, About dialog, version info
- [ ] Keyboard shortcuts: Space (play/pause), J/K/L (transport), Cmd+Z/Shift+Cmd+Z (undo), Cmd+S (save), Cmd+E (export), Delete (cut selection)
- [ ] Dark mode (follow system)
- [ ] Error boundaries — never show a white screen of death
- [ ] Crash reporter (local file only — no telemetry)
- [ ] First-run onboarding: 30-second tour with a sample video
- [ ] Code-sign with Developer ID, notarize, staple
- [ ] DMG with background image and Applications symlink
- [ ] Auto-update via Tauri's updater (signed manifest hosted on GitHub Releases)
- [ ] README with screenshot, install instructions, build-from-source instructions
- [ ] CHANGELOG.md, SECURITY.md, CODE_OF_CONDUCT.md

---

## 6. Phase 2 features (post-MVP, prioritized)

Each of these is a 2–5 day feature on its own branch.

### 6.1 Filler word detection (high value, low effort)

Run a regex pass over the transcript for `\b(um|uh|like|you know|so|right)\b` plus pause-length heuristics. Show them in a sidebar with a "remove all" button. Bonus: a small classifier model (or LLM call) for context-aware detection ("like" as filler vs. "like" as a verb).

### 6.2 Speaker diarization

Use `pyannote-audio` via a Python sidecar, or `whisper-diarization` which combines Whisper + pyannote. Annotate each word with `speaker`. Color-code paragraphs by speaker. Allow renaming speakers.

### 6.3 Local LLM editing (the headline feature)

**MLX sidecar.** Bundle a Python sidecar using PyInstaller that loads an MLX model (start with `mlx-community/Llama-3.2-3B-Instruct-4bit` — small, fast, runs on 8GB Macs).

Commands the LLM can produce (structured output via JSON schema):
- `cut_to_duration(targetSeconds)` — pick which segments to keep to hit a target.
- `remove_tangents()` — identify off-topic asides.
- `find_quote(description)` — locate a specific moment by meaning.
- `summarize_chapters()` — generate chapter markers.

The LLM never edits directly. It returns a list of `wordId` ranges to delete, which the user reviews and accepts. **Human in the loop, always.**

### 6.4 Caption / subtitle export

Generate SRT and VTT from the post-edit EDL. The hard part is re-mapping word timestamps from source-time to output-time. We already have `computeTimeline()` — just need to chunk into subtitle-friendly lines.

### 6.5 Multi-clip projects

Allow multiple source videos in one project. Reorder via drag in a clip-bin. Each clip has its own transcript. The output timeline concatenates segments across clips.

### 6.6 Reorder by drag

Let users grab a paragraph and drop it elsewhere in the transcript. This rearranges segments in the EDL. Trivial once the segment model is solid — UX is the hard part.

### 6.7 Smart-cut export

As described in Phase 6 — copy most of the stream, only re-encode the few seconds around each cut. Use `ffmpeg`'s `-c copy` with careful keyframe detection (`ffprobe -select_streams v -show_frames`).

---

## 7. Risks and how to handle them

| Risk | Likelihood | Mitigation |
|---|---|---|
| Whisper accuracy too low on accented speech | Medium | Default to `large-v3-turbo`; allow user-correctable transcript with edits preserved across re-transcription. |
| Word timestamps drift on long files | Medium | Re-anchor to forced-alignment in v2 (use `whisperX`-style approach with `wav2vec2` for alignment). |
| Export quality degrades vs original | Low | Default to high bitrate (8 Mbps for 1080p); show bitrate in export dialog. |
| Tauri sidecar process management gets gnarly | Medium | Use Tauri 2's `Command` API; ensure children die when app quits (`kill_on_drop`). |
| Bundle size explodes with models | High | Don't bundle models. Download on demand. Show sizes upfront. |
| Code signing / notarization breaks builds | Certain | Set up signing in CI early (Phase 0), not late. |
| User has Intel Mac | Low | Show a clear "Apple Silicon required" message on launch. Universal binary is possible but not worth the perf hit. |

---

## 8. Testing strategy

- **Unit tests (Vitest):** EDL operations (split, merge, delete, undo). Pure functions, 100% coverage target.
- **Unit tests (Rust):** FFprobe parser, EDL serialization, Whisper JSON parser.
- **Integration tests:** A 30-second test video committed to the repo (creative-commons sample). Tests run the full pipeline: import → transcribe → edit → export → verify output duration.
- **E2E (manual checklist for now):** Open app, import, transcribe, delete, export. Document in `docs/manual-test.md`.
- **Performance tests:** Track transcribe-time-per-minute-of-audio and export-time-per-minute across CI runs (M-series GitHub runner once available, else local).

---

## 9. Open questions to resolve before Phase 1

1. **License.** AGPL-3.0 (copyleft, protects against closed-source forks) or MIT (maximum adoption)? Recommendation: **AGPL-3.0** for the app, MIT for any reusable libraries we split out.
2. **Telemetry.** None in v1. Decide later whether to add opt-in crash reports.
3. **Name.** "Scribe" works but check trademark conflicts in the macOS App Store and video software space before launch.
4. **Distribution.** Direct download from GitHub Releases is fine for v1. Mac App Store distribution is more work (sandboxing constraints around sidecars).
5. **Funding model.** Pure FOSS? GitHub Sponsors? "Pro" features (cloud sync, team features) as a separate paid tier later? Decide before community traction makes the choice for you.

---

## 10. First commands for Claude Code

When you start, run these in order:

```bash
# 1. Scaffold
pnpm create tauri-app@latest scribe --template react-ts
cd scribe

# 2. Core dependencies
pnpm add zustand zundo @tiptap/react @tiptap/pm @tiptap/starter-kit \
  wavesurfer.js @radix-ui/react-slot class-variance-authority clsx tailwind-merge

# 3. Dev dependencies
pnpm add -D tailwindcss @tailwindcss/typography postcss autoprefixer \
  vitest @testing-library/react @testing-library/jest-dom @types/node

# 4. Tailwind init
pnpm tailwindcss init -p

# 5. shadcn/ui
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button dialog progress slider toast

# 6. Tauri sidecar binaries directory
mkdir -p src-tauri/binaries

# 7. Confirm it builds
pnpm tauri dev
```

Then start on **Phase 0** above.

---

## 11. How to use this document with Claude Code

- **Paste sections 1–3 first** as the project context.
- **Then paste Phase 0** and let Claude Code complete it before moving on.
- **Review each phase's "Acceptance" criterion** before starting the next.
- When stuck, paste section 7 (Risks) — many problems are anticipated there.
- This document is the spec, not the implementation. Push back on Claude Code if it suggests deviations from the architecture without justification.

---

**End of spec.** Ship it.
