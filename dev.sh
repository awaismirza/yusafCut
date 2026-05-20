#!/usr/bin/env bash
# dev.sh — clean slate dev launch for Scribe
#
# Usage:
#   ./dev.sh          # normal dev launch (incremental)
#   ./dev.sh --clean  # wipe Vite cache + Rust build cache first, then launch
#   ./dev.sh --fresh  # also reinstall node_modules (slowest, fully clean)
#
# On first run after cloning, use:  ./dev.sh --fresh
# If you get mysterious build errors: ./dev.sh --clean

set -euo pipefail
cd "$(dirname "$0")"

CLEAN=false
FRESH=false

for arg in "$@"; do
  case $arg in
    --clean) CLEAN=true ;;
    --fresh) CLEAN=true; FRESH=true ;;
  esac
done

echo "▶ Scribe dev launcher"

# -- Check prerequisites --
if ! command -v cargo &>/dev/null; then
  echo ""
  echo "✗  Rust/Cargo not found. Install it with:"
  echo "   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "   source \"\$HOME/.cargo/env\""
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "✗  Node.js not found. Install it with: brew install node"
  exit 1
fi

# -- Optional clean --
if $CLEAN; then
  echo "→ Cleaning Rust build cache..."
  (cd src-tauri && cargo clean --quiet)
  rm -rf dist
  echo "  Done."
fi

if $FRESH; then
  echo "→ Removing node_modules..."
  rm -rf node_modules
fi

# -- Install JS deps if missing --
if [ ! -d "node_modules" ]; then
  echo "→ Installing JS dependencies (npm install)..."
  npm install
fi

echo "→ Starting Scribe in dev mode..."
echo "  (First Rust compile takes 5-15 min. Subsequent launches are fast.)"
echo ""
npm run tauri:dev
