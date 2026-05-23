#!/usr/bin/env bash
# =============================================================================
# YusafCut — full dev launcher
#
#   npm run dev:full        (calls this script)
#
# What it does:
#   1. Preflight — checks node_modules, Python venv, key binaries
#   2. Sets RUST_LOG so Tauri + sidecar output is readable
#   3. Tails the MLX sidecar log in a background process with a [sidecar] prefix
#   4. Starts `tauri dev` (manages sidecar subprocess automatically)
#
# Ctrl-C cleanly kills everything.
# =============================================================================
set -euo pipefail

# ── colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

ok()     { echo -e "${GREEN}  ✓${RESET}  $*"; }
warn()   { echo -e "${YELLOW}  ⚠${RESET}  $*"; }
info()   { echo -e "${CYAN}  →${RESET}  $*"; }
fail()   { echo -e "${RED}  ✗${RESET}  $*"; }
header() { echo -e "\n${BOLD}$*${RESET}"; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINS="$REPO/src-tauri/binaries"
SIDECAR="$REPO/sidecars/mlx-llm"
ARCH_SUFFIX="aarch64-apple-darwin"
SIDECAR_LOG="$REPO/.sidecar.log"
TAURI_BIN="$REPO/node_modules/.bin/tauri"

# ── cleanup on exit ───────────────────────────────────────────────────────────
TAIL_PID=""
cleanup() {
  echo ""
  info "Shutting down…"
  [[ -n "$TAIL_PID" ]] && kill "$TAIL_PID" 2>/dev/null || true
  rm -f "$SIDECAR_LOG"
}
trap cleanup EXIT INT TERM

# ── banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}┌──────────────────────────────────────────────┐${RESET}"
echo -e "${BOLD}${CYAN}│   YusafCut  ·  dev:full                        │${RESET}"
echo -e "${BOLD}${CYAN}└──────────────────────────────────────────────┘${RESET}"
echo ""

# ── 1. Preflight ──────────────────────────────────────────────────────────────
header "Preflight checks"

# node_modules
if [[ ! -d "$REPO/node_modules/.bin/tauri" ]] && [[ ! -f "$TAURI_BIN" ]]; then
  warn "node_modules not found — running npm install…"
  npm install --prefix "$REPO" --silent
  ok "npm install done"
else
  ok "node_modules present"
fi

# Python venv
VENV_PY="$SIDECAR/.venv/bin/python"
if [[ -x "$VENV_PY" ]] && "$VENV_PY" -c "import mlx_llm" 2>/dev/null; then
  ok "Python venv ready  (${SIDECAR}/.venv)"
else
  warn "Python venv missing or incomplete"
  warn "AI features (chapters, b-roll) won't work. Fix with: npm run sidecar:setup"
fi

# ffmpeg
if [[ -x "$BINS/ffmpeg-$ARCH_SUFFIX" ]]; then
  ok "ffmpeg present"
else
  warn "ffmpeg not found — export will fail. Fix with: npm run setup:all"
fi

# whisper-cli
if [[ -x "$BINS/whisper-cli-$ARCH_SUFFIX" ]]; then
  ok "whisper-cli present"
else
  warn "whisper-cli not found — transcription will fail"
  warn "Build from: https://github.com/ggerganov/whisper.cpp (WHISPER_COREML=1 WHISPER_METAL=1 make -j)"
fi

# mlx-sidecar dev launcher
if [[ -x "$BINS/mlx-sidecar-$ARCH_SUFFIX" ]]; then
  ok "mlx-sidecar launcher present"
else
  warn "mlx-sidecar binary missing — AI features won't work"
fi

# ── 2. Environment ────────────────────────────────────────────────────────────
header "Environment"

# Surface Rust + sidecar logs clearly, suppress noisy crate spam
export RUST_LOG="${RUST_LOG:-yusafcut=debug,tauri=info,wry=warn,warn}"
# Surface Python sidecar stderr (Tauri pipes it as CommandEvent::Stderr)
export RUST_BACKTRACE="${RUST_BACKTRACE:-1}"
# Ensure mlx-lm can find the Hugging Face cache
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"

info "RUST_LOG=$RUST_LOG"
info "HF_HOME=$HF_HOME"
info "Sidecar log: $SIDECAR_LOG (shown below with ${MAGENTA}[sidecar]${RESET} prefix)"

# ── 3. Sidecar log watcher ────────────────────────────────────────────────────
# Tauri writes the sidecar's stderr to its own stdout mixed with Rust logs.
# We also create a named pipe so if someone runs the sidecar standalone
# (during the session) its output is captured and prefixed for readability.
touch "$SIDECAR_LOG"
(tail -F "$SIDECAR_LOG" 2>/dev/null | while IFS= read -r line; do
  echo -e "${MAGENTA}[sidecar]${RESET} ${DIM}$line${RESET}"
done) &
TAIL_PID=$!

# ── 4. Start tauri dev ────────────────────────────────────────────────────────
header "Starting tauri dev"
echo ""
echo -e "  ${DIM}Hot-reload is active for both Vite (TS/React) and Rust.${RESET}"
echo -e "  ${DIM}The MLX sidecar spawns lazily on first AI call.${RESET}"
echo -e "  ${DIM}Press Ctrl-C to stop everything.${RESET}"
echo ""

cd "$REPO"
exec npx tauri dev 2>&1 | while IFS= read -r line; do
  # Prefix sidecar stderr lines (Tauri forwards them with a recognisable pattern)
  if echo "$line" | grep -q "\[mlx-sidecar\]"; then
    echo -e "${MAGENTA}[sidecar]${RESET} ${DIM}${line}${RESET}"
    echo "${line}" >> "$SIDECAR_LOG"
  else
    echo "$line"
  fi
done
