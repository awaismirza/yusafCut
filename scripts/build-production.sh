#!/usr/bin/env bash
# =============================================================================
# YusafCut — production build script
#
# Builds a fully self-contained .dmg for distribution on Apple Silicon Macs.
# Python and all AI code (mlx-lm) are compiled into a single binary via
# PyInstaller, so end-users do NOT need Python installed.
#
# Usage:
#   npm run build:production
#
# Steps:
#   1. Platform guard — Apple Silicon only
#   2. Prerequisites check (node, python 3.11+, cargo/rustup, Xcode CLT)
#   2b. Download ffmpeg + ffprobe if missing
#   3. Python venv — install/update all sidecar dependencies
#   4. Build PyInstaller binary — bundles Python + mlx-lm into one executable
#   5. Sanity-check & build sidecars (mlx-sidecar, whisper-cli, whisperkit-cli)
#   6. tauri build --bundles dmg
#   7. Print the .dmg path
#
# ─── AI model weights ────────────────────────────────────────────────────────
# The LLM used for chapter detection (mlx-community/Llama-3.2-3B-Instruct-4bit,
# ~2 GB) is NOT bundled into the .dmg.  It is downloaded automatically to
# ~/Library/Caches/huggingface/ on first use.  Subsequent runs use the cache.
#
# Whisper / WhisperKit transcription models are downloaded on demand via the
# in-app model manager (Settings → Download Model).
#
# Bundling all models would add 10+ GB to the .dmg and is impractical for
# distribution.  The download-on-demand approach is standard for AI apps.
# =============================================================================
set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()     { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()   { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
info()   { echo -e "  ${CYAN}→${RESET}  $*"; }
fail()   { echo -e "  ${RED}✗${RESET}  $*"; }
header() { echo -e "\n${BOLD}$*${RESET}"; }
die()    { fail "$*"; exit 1; }

# ── paths ─────────────────────────────────────────────────────────────────────
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$REPO/sidecars/mlx-llm"
BINS="$REPO/src-tauri/binaries"
ARCH_SUFFIX="aarch64-apple-darwin"
SIDECAR_BIN="$BINS/mlx-sidecar-$ARCH_SUFFIX"
VENV="$SIDECAR_DIR/.venv"

BUILD_START=$(date +%s)

echo -e "\n${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║      YusafCut — production build           ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"

# ── 1. Platform guard ─────────────────────────────────────────────────────────
header "1 / 7  Platform"
[[ "$(uname -s)" == "Darwin" ]] || die "macOS required."
[[ "$(uname -m)" == "arm64"  ]] || die "Apple Silicon (arm64) required for this build."
ok "Apple Silicon Mac"

# ── 2. Prerequisites ──────────────────────────────────────────────────────────
header "2 / 7  Prerequisites"

# Node
if ! command -v node >/dev/null 2>&1; then
  die "node not found. Install from https://nodejs.org (v20+)"
fi
NODE_VER=$(node --version | sed 's/v//')
NODE_MAJOR="${NODE_VER%%.*}"
[[ "$NODE_MAJOR" -ge 20 ]] || warn "Node $NODE_VER found — v20+ recommended."
ok "Node v$NODE_VER"

# Python 3.11+
if ! command -v python3 >/dev/null 2>&1; then
  die "python3 not found. Install Python 3.11+ from https://python.org"
fi
PY_VER=$(python3 --version 2>&1 | awk '{print $2}')
PY_MAJOR="${PY_VER%%.*}"
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [[ "$PY_MAJOR" -lt 3 ]] || { [[ "$PY_MAJOR" -eq 3 ]] && [[ "$PY_MINOR" -lt 11 ]]; }; then
  die "Python $PY_VER is too old — 3.11+ required. Install from https://python.org"
fi
ok "Python $PY_VER"

# Rust / cargo
if ! command -v cargo >/dev/null 2>&1; then
  # Try rustup path
  if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  else
    die "cargo not found. Install Rust from https://rustup.rs"
  fi
fi
RUST_VER=$(cargo --version | awk '{print $2}')
ok "Rust $RUST_VER"

# Xcode Command Line Tools (needed by cargo for linking)
if ! xcode-select -p >/dev/null 2>&1; then
  die "Xcode Command Line Tools not installed. Run: xcode-select --install"
fi
ok "Xcode CLT $(xcode-select -p)"

# npm packages
info "Running npm install…"
npm install --prefix "$REPO" --silent
ok "npm packages up to date"

# ── 2b. FFmpeg / FFprobe binaries ─────────────────────────────────────────────
FFMPEG="$BINS/ffmpeg-$ARCH_SUFFIX"
FFPROBE="$BINS/ffprobe-$ARCH_SUFFIX"

_download_ffmpeg() {
  local name="$1" url="$2" dest="$3" zipname="$4"
  if [[ -f "$dest" ]] && [[ -x "$dest" ]]; then
    return 0
  fi
  info "Downloading $name from evermeet.cx…"
  curl -fsSL -o "/tmp/$zipname" "$url" || die "Failed to download $name"
  unzip -oq "/tmp/$zipname" -d "/tmp" || die "Failed to extract $name"
  [[ -f "/tmp/$name" ]] || die "$name not found in archive"
  mv "/tmp/$name" "$dest"
  chmod +x "$dest"
  rm -f "/tmp/$zipname"
}

if [[ ! -f "$FFMPEG" ]] || [[ ! -x "$FFMPEG" ]]; then
  _download_ffmpeg "ffmpeg" "https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip" "$FFMPEG" "ffmpeg.zip"
  ok "ffmpeg downloaded and installed"
else
  FMSIZE=$(du -sh "$FFMPEG" | awk '{print $1}')
  ok "ffmpeg present (${FMSIZE})"
fi

if [[ ! -f "$FFPROBE" ]] || [[ ! -x "$FFPROBE" ]]; then
  _download_ffmpeg "ffprobe" "https://evermeet.cx/ffmpeg/ffprobe-7.1.zip" "$FFPROBE" "ffprobe.zip"
  ok "ffprobe downloaded and installed"
else
  FPSIZE=$(du -sh "$FFPROBE" | awk '{print $1}')
  ok "ffprobe present (${FPSIZE})"
fi

# ── 3. Python venv + dependencies ─────────────────────────────────────────────
header "3 / 7  Python sidecar dependencies"

if [[ ! -x "$VENV/bin/python" ]]; then
  info "Creating venv at sidecars/mlx-llm/.venv …"
  python3 -m venv "$VENV"
  ok "venv created"
fi

info "Upgrading pip…"
"$VENV/bin/pip" install -q --upgrade pip

info "Installing mlx_llm + mlx-lm (may take a few minutes on first run)…"
"$VENV/bin/pip" install -q -e "$SIDECAR_DIR"
ok "Python dependencies installed"

# PyInstaller — needed to compile the sidecar binary
if ! "$VENV/bin/python" -c "import PyInstaller" 2>/dev/null; then
  info "Installing PyInstaller…"
  "$VENV/bin/pip" install -q pyinstaller
fi
PYINST_VER=$("$VENV/bin/python" -m PyInstaller --version 2>/dev/null)
ok "PyInstaller $PYINST_VER"

# ── 4. Build PyInstaller sidecar binary ───────────────────────────────────────
header "4 / 7  Building MLX sidecar binary (PyInstaller)"
info "This bundles Python + mlx-lm into a single self-contained executable."
info "Expect 2–5 minutes on first run; subsequent runs are faster."

# Run build.py with the venv Python so PyInstaller can find all installed deps.
"$VENV/bin/python" "$SIDECAR_DIR/build.py"

# ── 5. Sanity-check the binary ────────────────────────────────────────────────
header "5 / 7  Verifying sidecar binary + building missing binaries"

if [[ ! -f "$SIDECAR_BIN" ]]; then
  die "sidecar binary not found at $SIDECAR_BIN — PyInstaller may have failed."
fi

# The dev launcher starts with #!/bin/sh; a PyInstaller ELF/Mach-O does not.
FIRST_BYTE=$(head -c 2 "$SIDECAR_BIN" 2>/dev/null || true)
if [[ "$FIRST_BYTE" == "#!" ]]; then
  die "mlx-sidecar is still the dev shell-script launcher — PyInstaller did not produce a binary.\nCheck PyInstaller output above for errors."
fi

# Ensure it is executable.
chmod +x "$SIDECAR_BIN"

BIN_SIZE=$(du -sh "$SIDECAR_BIN" | awk '{print $1}')
ok "sidecar binary verified (${BIN_SIZE})"

# Tell git to ignore local changes to this file so the 60 MB PyInstaller
# binary is never accidentally staged or committed.  The repo tracks the
# 1 KB dev shell-script launcher; the production binary is ephemeral.
git -C "$REPO" update-index --skip-worktree \
    "src-tauri/binaries/mlx-sidecar-$ARCH_SUFFIX" 2>/dev/null || true
ok "git skip-worktree set on mlx-sidecar — won't appear in 'git status'"

# ── 5a. whisper-cli — build from source if missing or stub ─────────────────────
WHISPER_BIN="$BINS/whisper-cli-$ARCH_SUFFIX"
_ws_is_stub() {
  [[ -f "$WHISPER_BIN" ]] && head -1 "$WHISPER_BIN" 2>/dev/null | grep -q "^#!"
}
if [[ -f "$WHISPER_BIN" ]] && [[ -x "$WHISPER_BIN" ]] && ! _ws_is_stub; then
  WSSIZE=$(du -sh "$WHISPER_BIN" | awk '{print $1}')
  ok "whisper-cli present (${WSSIZE})"
else
  if _ws_is_stub; then
    info "whisper-cli is a dev stub — replacing with real binary…"
  else
    info "whisper-cli not found — building from source…"
  fi

  # Build whisper.cpp from source (static binary)
  WHISPER_TMP="/tmp/whisper.cpp.build.$$"
  mkdir -p "$WHISPER_TMP"

  info "Cloning whisper.cpp v1.7.5…"
  git clone --depth 1 --branch v1.7.5 https://github.com/ggerganov/whisper.cpp "$WHISPER_TMP" 2>/dev/null || die "Failed to clone whisper.cpp"

  info "Building with Core ML + Metal (static binary - no dynamic libs)…"
  cd "$WHISPER_TMP"
  GGML_STATIC=1 WHISPER_COREML=1 WHISPER_METAL=1 make -j$(sysctl -n hw.logicalcpu) main 2>/dev/null || die "Failed to build whisper-cli"

  info "Installing whisper-cli…"
  cp main "$WHISPER_BIN"
  chmod +x "$WHISPER_BIN"
  cd "$REPO"
  rm -rf "$WHISPER_TMP"

  WSSIZE=$(du -sh "$WHISPER_BIN" | awk '{print $1}')
  ok "whisper-cli built and installed (${WSSIZE})"
fi

# ── 5b. whisperkit-cli — build from source if stub or missing ─────────────────
header "5b / 7  WhisperKit CLI (optional)"
WHISPERKIT_BIN="$BINS/whisperkit-cli-$ARCH_SUFFIX"
_wk_is_stub() {
  [[ -f "$WHISPERKIT_BIN" ]] && head -1 "$WHISPERKIT_BIN" 2>/dev/null | grep -q "^#!"
}
if [[ -f "$WHISPERKIT_BIN" ]] && [[ -x "$WHISPERKIT_BIN" ]] && ! _wk_is_stub; then
  WKSIZE=$(du -sh "$WHISPERKIT_BIN" | awk '{print $1}')
  ok "whisperkit-cli present (${WKSIZE})"
else
  if _wk_is_stub; then
    info "whisperkit-cli is a dev stub — replacing with real binary…"
  else
    info "whisperkit-cli not found — building from source…"
  fi
  if ! command -v swift >/dev/null 2>&1; then
    die "Swift not found — cannot build whisperkit-cli.\nInstall Xcode from the App Store (full Xcode, not just CLT)."
  fi
  bash "$REPO/scripts/build-whisperkit-cli.sh"
  WKSIZE=$(du -sh "$WHISPERKIT_BIN" | awk '{print $1}')
  ok "whisperkit-cli built and installed (${WKSIZE})"
fi

# ── 6. tauri build --bundles dmg ──────────────────────────────────────────────
header "6 / 7  Building production .dmg (Rust release + bundled sidecars)"
info "Running: tauri build --bundles dmg"
info "This compiles Rust in release mode and bundles all sidecars. Expect 5–15 minutes."

cd "$REPO"
npx tauri build --bundles dmg

# Find the .dmg
DMG=$(find "$REPO/src-tauri/target/release/bundle/dmg" -name "*.dmg" 2>/dev/null | head -1)

BUILD_END=$(date +%s)
ELAPSED=$(( BUILD_END - BUILD_START ))
MINS=$(( ELAPSED / 60 ))
SECS=$(( ELAPSED % 60 ))

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║         Build complete! ✓               ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Time elapsed:  ${BOLD}${MINS}m ${SECS}s${RESET}"

if [[ -n "$DMG" ]]; then
  DMG_SIZE=$(du -sh "$DMG" | awk '{print $1}')
  echo -e "  Output .dmg:   ${GREEN}${BOLD}$DMG${RESET}"
  echo -e "  Size:          ${DMG_SIZE}"
  echo ""
  echo -e "  ${CYAN}Open in Finder:${RESET}  open \"$(dirname "$DMG")\""
  echo -e "  ${CYAN}Install locally:${RESET} open \"$DMG\""
else
  warn "Could not locate .dmg file — check src-tauri/target/release/bundle/dmg/"
fi

echo ""
echo -e "  ${YELLOW}Note on AI models:${RESET}"
echo -e "  • Whisper / WhisperKit models → downloaded in-app via Settings > Download Model"
echo -e "  • LLM model (chapter detection) → downloaded on first use to ~/Library/Caches/huggingface/"
echo -e "    Model: mlx-community/Llama-3.2-3B-Instruct-4bit  (~2 GB, cached after first download)"
echo ""
