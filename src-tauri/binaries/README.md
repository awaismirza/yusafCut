# `src-tauri/binaries/` — bundled sidecar executables

This directory ships native binaries alongside the Tauri app. Tauri's
[external binary](https://v2.tauri.app/develop/sidecar/) pattern requires the
filename to end with the target triple suffix. For Apple Silicon, that's:

```
whisper-cli-aarch64-apple-darwin        # whisper.cpp transcription engine
ffmpeg-aarch64-apple-darwin             # video encode / export
ffprobe-aarch64-apple-darwin            # media probing
mlx-sidecar-aarch64-apple-darwin        # on-device LLM via Apple MLX (PyInstaller bundle)
whisperkit-cli-aarch64-apple-darwin     # WhisperKit transcription (Tier 2, stub for now)
```

(With an additional `-x86_64-apple-darwin` set if you ever ship Intel/universal
binaries.)

`tauri.conf.json` declares the *unsuffixed* names under `bundle.externalBin`:

```json
"externalBin": [
  "binaries/whisper-cli",
  "binaries/ffmpeg",
  "binaries/ffprobe",
  "binaries/mlx-sidecar",
  "binaries/whisperkit-cli"
]
```

Tauri resolves each entry to the suffixed file at build time.

---

## How to obtain the binaries

> **None of these are committed.** They're added to `.gitignore` because they
> are too large and licensing varies per build. Run the script below or pull
> from the project's GitHub Releases (which CI will publish, once signing is set
> up).

### 1. `ffmpeg` and `ffprobe`

Easiest: download the static Apple Silicon builds from
[evermeet.cx/ffmpeg](https://evermeet.cx/ffmpeg/) (or build from source).

```bash
cd src-tauri/binaries
curl -L -o ffmpeg.zip   https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip
curl -L -o ffprobe.zip  https://evermeet.cx/ffmpeg/ffprobe-7.1.zip
unzip -o ffmpeg.zip && unzip -o ffprobe.zip
mv ffmpeg  ffmpeg-aarch64-apple-darwin
mv ffprobe ffprobe-aarch64-apple-darwin
chmod +x  ffmpeg-aarch64-apple-darwin ffprobe-aarch64-apple-darwin
rm ffmpeg.zip ffprobe.zip
```

Verify VideoToolbox is enabled:

```bash
./ffmpeg-aarch64-apple-darwin -encoders 2>/dev/null | grep videotoolbox
```

You should see `h264_videotoolbox` and `hevc_videotoolbox`.

### 2. `whisper-cli` (whisper.cpp with Core ML + Metal)

Build from source per the [whisper.cpp README](https://github.com/ggerganov/whisper.cpp):

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
# Core ML + Metal
WHISPER_COREML=1 WHISPER_METAL=1 make -j
cp main ../scribe/src-tauri/binaries/whisper-cli-aarch64-apple-darwin
chmod +x ../scribe/src-tauri/binaries/whisper-cli-aarch64-apple-darwin
```

Note that the binary is called `main` in the upstream Makefile; we rename it.

### 3. `mlx-sidecar` (on-device LLM via Apple MLX)

Build with PyInstaller from the sidecar source:

```bash
# Activate a venv with mlx-lm and PyInstaller installed first.
python sidecars/mlx-llm/build.py
# Writes: src-tauri/binaries/mlx-sidecar-aarch64-apple-darwin
```

A dev stub (`#!/bin/sh … exit 1`) is committed so `cargo build` doesn't fail
for developers who haven't run the PyInstaller step yet.

### 4. `whisperkit-cli` (WhisperKit — Tier 2 roadmap)

Not yet implemented. A dev stub is committed so `cargo build` doesn't fail.
Replace with the real WhisperKit CLI binary when that feature lands.

---

## Why a stub directory?

Tauri's bundler will refuse to build if `bundle.externalBin` references missing
files. To let the project clone + run tests + typecheck without forcing every
developer to download multi-hundred-megabyte tools, we keep this README and a
`.gitkeep` in source control and treat the actual binaries as a separate build
step. CI will populate them before running `pnpm tauri build`.

If you only want to run the frontend (`pnpm dev`) and unit tests, the binaries
are not required.
