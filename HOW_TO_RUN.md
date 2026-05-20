# How to run Scribe on macOS (Apple Silicon)

> **TL;DR** — Install prereqs, run two commands.
>
> ```bash
> npm install
> npm run tauri dev
> ```

---

## 1. Prerequisites

Install these once. If you already have them, skip ahead.

### Xcode Command Line Tools
```bash
xcode-select --install
```

### Homebrew (if not installed)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Node.js 20+
```bash
brew install node
# or use nvm: nvm install 20 && nvm use 20
```
Verify: `node -v` should show v20 or higher.

### Rust
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```
Verify: `rustc --version`

### Tauri CLI (comes with the project — no global install needed)
The `@tauri-apps/cli` is a dev dependency in `package.json`, so `npm run tauri` works after `npm install`.

---

## 2. First-time setup

```bash
cd /path/to/scribe       # wherever you cloned/copied the project

# Install JavaScript dependencies (required after cloning)
npm install
```

---

## 3. Run in development mode

```bash
npm run tauri dev
```

This starts the Vite dev server AND the Tauri app simultaneously.
The app window will appear after a ~30–60 second first Rust compile.
Subsequent launches are much faster (Rust caches increments).

**What you'll see on first launch:**
- An empty editor with a toolbar (Open, New, Save, Transcribe, Export).
- No transcript — you need to open a video file first.

---

## 4. First use: Open a video and transcribe

1. Click **Open** in the toolbar → pick a `.mp4` or `.mov` file.
2. Click **Transcribe** → choose a Whisper model:
   - **Tiny** (75 MB) — fast, lower accuracy, good for testing.
   - **Large v3 Turbo** (1.6 GB) — best quality, default recommendation.
3. On first transcribe, the model downloads from Hugging Face (~75 MB to 1.6 GB). Progress shows in the toolbar.
4. Once complete, the transcript appears on the left. The video plays on the right.
5. **Click any word** to seek the video to that point.
6. **Select words → Delete** to cut them from the edit.
7. **Cmd+Z** / **Shift+Cmd+Z** to undo / redo.
8. **Cmd+S** to save the project as a `.scribe` file.
9. **Cmd+E** (or click Export) to render the final `.mp4`.

---

## 5. Build a distributable `.app`

```bash
npm run tauri build
```

The unsigned `.app` is placed in:
```
src-tauri/target/release/bundle/macos/Scribe.app
```

> **Note:** The app is unsigned so macOS will gatekeeper-block it on first open.
> Right-click → Open → Open anyway to bypass this during development.
> For distribution, you'd need an Apple Developer ID certificate and notarization.

---

## 6. Run tests

```bash
# TypeScript / React unit tests (Vitest)
npm test

# Rust unit tests
cd src-tauri && cargo test
```

---

## 7. Known issues and notes

### ffmpeg runs via Rosetta 2

The bundled `ffmpeg` and `ffprobe` in `src-tauri/binaries/` are Intel (x86_64) builds.
macOS Rosetta 2 runs them seamlessly on Apple Silicon — you won't notice unless you compare
export speed with native ARM64 builds.

**To upgrade to native ARM64 ffmpeg** (optional, faster exports):
```bash
cd src-tauri/binaries
# Remove old Intel builds
rm ffmpeg-aarch64-apple-darwin ffprobe-aarch64-apple-darwin

# Download native Apple Silicon builds from evermeet.cx
curl -L -o ffmpeg.zip  "https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip"
curl -L -o ffprobe.zip "https://evermeet.cx/ffmpeg/ffprobe-7.1.zip"
unzip -o ffmpeg.zip && unzip -o ffprobe.zip
mv ffmpeg  ffmpeg-aarch64-apple-darwin
mv ffprobe ffprobe-aarch64-apple-darwin
chmod +x   ffmpeg-aarch64-apple-darwin ffprobe-aarch64-apple-darwin
rm ffmpeg.zip ffprobe.zip

# Verify VideoToolbox hardware encoding is available
./ffmpeg-aarch64-apple-darwin -encoders 2>/dev/null | grep videotoolbox
```

### Whisper model storage

Models are downloaded to:
```
~/Library/Application Support/dev.scribe.app/models/
```

Delete models from there to free disk space.

### whisper-cli is native ARM64

The bundled `whisper-cli-aarch64-apple-darwin` is a real ARM64 binary — it runs natively
on the Neural Engine / Metal for fast transcription.

### Media files are referenced, not copied

Scribe stores the **path** to your original video, not a copy. Don't move or rename
your video file after opening it in Scribe — use the **Relink** flow if you do.

---

## 8. Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Space | Play / pause |
| J | Rewind (half speed) |
| K | Pause |
| L | Fast-forward (double speed) |
| Cmd+Z | Undo |
| Shift+Cmd+Z | Redo |
| Cmd+S | Save project |
| Cmd+E | Export video |
| Delete / Backspace | Cut selected words |

---

## 9. Troubleshooting

**App won't launch / Rust compile error on `tauri dev`**
- Make sure Xcode CLT is installed: `xcode-select -p` should return a path.
- Try `cargo build` inside `src-tauri/` to see raw Rust errors.

**"ffmpeg sidecar not available"**
- The binaries in `src-tauri/binaries/` must be executable: `chmod +x src-tauri/binaries/*`

**Transcription produces garbage / no words**
- The Whisper model might be corrupt — delete it from `~/Library/Application Support/dev.scribe.app/models/` and re-download.
- Try a smaller model (Tiny or Base) first.

**Export fails with "ffmpeg exited with code …"**
- Check that the source video still exists at the original path.
- If you edited the project across multiple machines, the path may differ — use Save + Relink.
