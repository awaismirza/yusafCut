#!/usr/bin/env bash
# =============================================================================
# Scribe — standalone MLX sidecar dev runner
#
#   npm run dev:sidecar     (calls this script)
#
# Starts the Python sidecar in isolation — no Tauri, no Rust.
# Useful for:
#   • Testing new commands / prompts quickly
#   • Inspecting model output without launching the full app
#   • Checking that mlx_llm imports and model loads correctly
#
# Usage:
#   npm run dev:sidecar
#   → Type JSON request lines directly, see JSON responses.
#   → Example:
#       {"id":"1","command":"summarise","payload":{"transcript":"Hello world","n_chapters":3,"model":"mlx-community/Llama-3.2-3B-Instruct-4bit"}}
#
# To pipe a test file:
#   npm run dev:sidecar < sidecars/mlx-llm/tests/fixtures/sample_request.json
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

ok()     { echo -e "${GREEN}  ✓${RESET}  $*" >&2; }
warn()   { echo -e "${YELLOW}  ⚠${RESET}  $*" >&2; }
info()   { echo -e "${CYAN}  →${RESET}  $*" >&2; }
fail()   { echo -e "${RED}  ✗${RESET}  $*" >&2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR="$REPO/sidecars/mlx-llm"
VENV_PY="$SIDECAR/.venv/bin/python"

# ── banner ────────────────────────────────────────────────────────────────────
echo "" >&2
echo -e "${BOLD}${MAGENTA}┌──────────────────────────────────────────────┐${RESET}" >&2
echo -e "${BOLD}${MAGENTA}│   Scribe  ·  MLX sidecar  ·  dev mode       │${RESET}" >&2
echo -e "${BOLD}${MAGENTA}└──────────────────────────────────────────────┘${RESET}" >&2
echo "" >&2

# ── pick Python ──────────────────────────────────────────────────────────────
if [[ -x "$VENV_PY" ]]; then
  PYTHON="$VENV_PY"
  ok "Using venv Python: $VENV_PY"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
  warn "Venv not found — using system python3. Run 'npm run sidecar:setup' for a proper env."
else
  fail "No Python found. Run: npm run sidecar:setup"
  exit 1
fi

# ── check imports ─────────────────────────────────────────────────────────────
if ! "$PYTHON" -c "import mlx_llm" 2>/dev/null; then
  fail "mlx_llm not importable. Run: npm run sidecar:setup"
  exit 1
fi
ok "mlx_llm importable"

# ── check mlx-lm ─────────────────────────────────────────────────────────────
if "$PYTHON" -c "import mlx_lm" 2>/dev/null; then
  ok "mlx_lm importable (Apple MLX backend ready)"
else
  warn "mlx_lm not installed — AI inference will fail."
  warn "Fix: ${VENV_PY} -m pip install mlx-lm"
fi

# ── Hugging Face cache ────────────────────────────────────────────────────────
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
info "HF_HOME=$HF_HOME  (models cached here)"

# ── interactive hint ──────────────────────────────────────────────────────────
if [[ -t 0 ]]; then
  # stdin is a terminal → interactive mode
  echo "" >&2
  echo -e "  ${BOLD}Interactive mode${RESET} — type a JSON request and press Enter:" >&2
  echo "" >&2
  echo -e "  ${DIM}Chapter detection:${RESET}" >&2
  printf '  %s\n' \
    '{"id":"1","command":"summarise","payload":{"transcript":"[0.0] Hello [1.0] world [2.0] this is a test transcript","n_chapters":2,"model":"mlx-community/Llama-3.2-3B-Instruct-4bit"}}' >&2
  echo "" >&2
  echo -e "  ${DIM}B-roll suggestions:${RESET}" >&2
  printf '  %s\n' \
    '{"id":"2","command":"broll","payload":{"transcript":"[0.0] We built a new AI video editor","start_seconds":0,"end_seconds":5,"n_suggestions":2,"model":"mlx-community/Llama-3.2-3B-Instruct-4bit"}}' >&2
  echo "" >&2
  echo -e "  ${DIM}Ctrl-D or Ctrl-C to exit.${RESET}" >&2
  echo "" >&2
fi

# ── run ───────────────────────────────────────────────────────────────────────
# Route Python logging to stderr (colored) and JSON responses to stdout.
exec "$PYTHON" -u -m mlx_llm
