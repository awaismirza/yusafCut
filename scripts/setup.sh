#!/usr/bin/env bash
# =============================================================================
# Scribe — one-shot dev setup script
#
# Run once after cloning, or any time you want to reset your environment:
#
#   npm run setup:all        (calls this script)
#
# After this completes you can run:
#   npm run start            → tauri dev (hot-reload)
#   npm run tauri:build:dmg  → production .dmg
#
# What this script does:
#   1. Guard — Apple Silicon only
#   2. Node dependencies  (npm install)
#   3. Python venv        (sidecars/mlx-llm/.venv)
#   4. FFmpeg / FFprobe   (downloads static builds from evermeet.cx)
#   5. whisper-cli        (check — must be built manually, see below)
#   6. whisperkit-cli     (stub is bundled — no action needed)
#   7. Final status table
# =============================================================================
set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
fail() { echo -e "  ${RED}✗${RESET}  $*"; }
header() { echo -e "\n${BOLD}$*${RESET}"; }

# ── repo root ─────────────────────────────────────────────────────────────────
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINS="$REPO/src-tauri/binaries"
SIDECAR="$REPO/sidecars/mlx-llm"
ARCH_SUFFIX="aarch64-apple-darwin"

echo -e "\n${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       Scribe — setup:all             ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════╝${RESET}"

# ── 1. Platform guard ─────────────────────────────────────────────────────────
header "1 / 6  Platform check"
if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "Scribe targets macOS only. Exiting."
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  warn "Detected Intel Mac. Binaries are compiled for Apple Silicon (aarch64)."
  warn "Transcription and MLX sidecar features will not work."
  warn "Continuing anyway — frontend dev still works."
else
  ok "Apple Silicon detected"
fi

# ── 2. Node / npm ─────────────────────────────────────────────────────────────
header "2 / 6  Node dependencies"
if ! command -v node >/dev/null 2>&1; then
  fail "node not found. Install from https://nodejs.org (v20+) and re-run."
  exit 1
fi
NODE_VER=$(node --version | sed 's/v//')
NODE_MAJOR="${NODE_VER%%.*}"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  warn "Node $NODE_VER found — v20+ recommended."
else
  ok "Node v$NODE_VER"
fi
info "Running npm install…"
npm install --prefix "$REPO" --silent
ok "npm packages installed"

# ── 3. Python venv for MLX sidecar ────────────────────────────────────────────
header "3 / 6  Python sidecar (mlx-llm)"
VENV="$SIDECAR/.venv"
if ! command -v python3 >/dev/null 2>&1; then
  warn "python3 not found — MLX AI features (chapter detection, b-roll) disabled."
  warn "Install Python 3.11+ from https://python.org to enable them."
else
  PY_VER=$(python3 --version 2>&1 | awk '{print $2}')
  PY_MAJOR="${PY_VER%%.*}"
  PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
  if [[ "$PY_MAJOR" -lt 3 ]] || { [[ "$PY_MAJOR" -eq 3 ]] && [[ "$PY_MINOR" -lt 11 ]]; }; then
    warn "Python $PY_VER found — 3.11+ required for mlx-lm."
    warn "MLX AI features will not work until Python is upgraded."
  else
    ok "Python $PY_VER"
    if [[ -x "$VENV/bin/python" ]]; then
      info "Venv already exists — upgrading packages…"
      "$VENV/bin/pip" install -q -e "$SIDECAR"
      ok "Python venv up to date"
    else
      info "Creating venv at sidecars/mlx-llm/.venv …"
      python3 -m venv "$VENV"
      info "Installing mlx_llm + dependencies (pydantic, mlx-lm)…"
      info "Note: mlx-lm is ~200 MB on first install."
      "$VENV/bin/pip" install -q --upgrade pip
      "$VENV/bin/pip" install -q -e "$SIDECAR"
      ok "Python venv created and packages installed"
    fi
  fi
fi

# ── 4. FFmpeg / FFprobe ───────────────────────────────────────────────────────
header "4 / 6  FFmpeg / FFprobe"
FFMPEG="$BINS/ffmpeg-$ARCH_SUFFIX"
FFPROBE="$BINS/ffprobe-$ARCH_SUFFIX"

download_ffmpeg() {
  local name="$1" url="$2" dest="$3" zipname="$4"
  if [[ -f "$dest" ]]; then
    ok "$name already present"
    return
  fi
  info "Downloading $name from evermeet.cx…"
  curl -fsSL -o "/tmp/$zipname" "$url"
  unzip -oq "/tmp/$zipname" -d "/tmp"
  mv "/tmp/${name}" "$dest"
  chmod +x "$dest"
  rm -f "/tmp/$zipname"
  ok "$name downloaded"
}

download_ffmpeg "ffmpeg"  "https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip"  "$FFMPEG"  "ffmpeg.zip"
download_ffmpeg "ffprobe" "https://evermeet.cx/ffmpeg/ffprobe-7.1.zip" "$FFPROBE" "ffprobe.zip"

# ── 5. whisper-cli ────────────────────────────────────────────────────────────
header "5 / 6  whisper-cli"
WHISPER="$BINS/whisper-cli-$ARCH_SUFFIX"
if [[ -f "$WHISPER" ]] && [[ -x "$WHISPER" ]]; then
  WSIZE=$(du -sh "$WHISPER" 2>/dev/null | awk '{print $1}')
  ok "whisper-cli present (${WSIZE})"
else
  warn "whisper-cli not found — transcription will not work."
  echo ""
  echo "      Build it from source (5–10 min):"
  echo "      ┌─────────────────────────────────────────────────────────┐"
  echo "      │  git clone https://github.com/ggerganov/whisper.cpp     │"
  echo "      │  cd whisper.cpp                                         │"
  echo "      │  WHISPER_COREML=1 WHISPER_METAL=1 make -j              │"
  echo "      │  cp main $BINS/whisper-cli-$ARCH_SUFFIX  │"
  echo "      └─────────────────────────────────────────────────────────┘"
fi

# ── 6. MLX sidecar binary ─────────────────────────────────────────────────────
header "6 / 6  MLX sidecar binary"
MLX_BIN="$BINS/mlx-sidecar-$ARCH_SUFFIX"
if [[ -f "$MLX_BIN" ]] && [[ -x "$MLX_BIN" ]]; then
  # If it's the dev shell-script launcher (not a PyInstaller binary), that's fine.
  if head -1 "$MLX_BIN" | grep -q "^#!/"; then
    ok "mlx-sidecar dev launcher present"
  else
    ok "mlx-sidecar binary present"
  fi
else
  warn "mlx-sidecar not found — AI features will fail at runtime."
  warn "Run: python sidecars/mlx-llm/build.py"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║           Setup complete!            ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""
echo "  Next steps:"
echo ""

if [[ -f "$WHISPER" ]] && [[ -x "$WHISPER" ]]; then
  echo -e "  ${GREEN}npm run start${RESET}              Start dev server (hot-reload)"
  echo -e "  ${GREEN}npm run tauri:build:dmg${RESET}    Build production .dmg"
else
  echo -e "  ${YELLOW}npm run start${RESET}              Start dev server"
  echo -e "                             ⚠  Build whisper-cli first for transcription"
  echo -e "  ${YELLOW}npm run tauri:build:dmg${RESET}    Build production .dmg"
  echo -e "                             ⚠  Build whisper-cli first"
fi
echo ""
