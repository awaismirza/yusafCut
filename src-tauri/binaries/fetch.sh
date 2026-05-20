#!/usr/bin/env bash
# Convenience script: download ffmpeg/ffprobe for aarch64 Apple Silicon and
# rename them with the Tauri-required suffix. whisper-cli must be built locally
# (see README.md).
#
# Run from anywhere; the script always cd's into its own directory.

set -euo pipefail
cd "$(dirname "$0")"

ARCH_SUFFIX="aarch64-apple-darwin"

if [[ "$(uname -s)" != "Darwin" ]] || [[ "$(uname -m)" != "arm64" ]]; then
  echo "Refusing to run: this script is for Apple Silicon Macs only." >&2
  exit 1
fi

if [[ ! -f "ffmpeg-${ARCH_SUFFIX}" ]]; then
  echo "Downloading ffmpeg..."
  curl -L -o ffmpeg.zip https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip
  unzip -o ffmpeg.zip
  mv ffmpeg "ffmpeg-${ARCH_SUFFIX}"
  chmod +x "ffmpeg-${ARCH_SUFFIX}"
  rm ffmpeg.zip
fi

if [[ ! -f "ffprobe-${ARCH_SUFFIX}" ]]; then
  echo "Downloading ffprobe..."
  curl -L -o ffprobe.zip https://evermeet.cx/ffmpeg/ffprobe-7.1.zip
  unzip -o ffprobe.zip
  mv ffprobe "ffprobe-${ARCH_SUFFIX}"
  chmod +x "ffprobe-${ARCH_SUFFIX}"
  rm ffprobe.zip
fi

if [[ ! -f "whisper-cli-${ARCH_SUFFIX}" ]]; then
  echo "whisper-cli-${ARCH_SUFFIX} not found. Build from source:"
  echo "  https://github.com/ggerganov/whisper.cpp"
  echo "  WHISPER_COREML=1 WHISPER_METAL=1 make -j"
  echo "  cp main <here>/whisper-cli-${ARCH_SUFFIX}"
fi

echo "Done. Files in $(pwd):"
ls -la *-${ARCH_SUFFIX} 2>/dev/null || true
