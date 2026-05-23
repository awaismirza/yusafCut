#!/usr/bin/env bash
# build.sh — produce a distributable .app / .dmg
#
# Usage:
#   ./build.sh          # build .app + .dmg (release mode)
#   ./build.sh --clean  # wipe Rust cache first, then build (fixes stale-cache errors)
#   ./build.sh --dmg    # build only the .dmg installer (skips other bundle types)
#
# Output:
#   src-tauri/target/release/bundle/macos/YusafCut.app
#   src-tauri/target/release/bundle/dmg/YusafCut_*.dmg

set -euo pipefail
cd "$(dirname "$0")"

CLEAN=false
DMG_ONLY=false

for arg in "$@"; do
  case $arg in
    --clean)    CLEAN=true ;;
    --dmg)      DMG_ONLY=true ;;
  esac
done

echo "▶ YusafCut production build"

# -- Check prerequisites --
if ! command -v cargo &>/dev/null; then
  echo ""
  echo "✗  Rust/Cargo not found. Install it with:"
  echo "   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "   source \"\$HOME/.cargo/env\""
  exit 1
fi

# -- Optional clean --
if $CLEAN; then
  echo "→ Cleaning Rust build cache..."
  (cd src-tauri && cargo clean --quiet)
  rm -rf dist
  echo "  Done."
fi

# -- Install JS deps if missing --
if [ ! -d "node_modules" ]; then
  echo "→ Installing JS dependencies..."
  npm install
fi

# -- Build --
if $DMG_ONLY; then
  echo "→ Building .dmg installer..."
  npm run tauri:build:dmg
else
  echo "→ Building .app + .dmg (release)..."
  npm run tauri:build
fi

echo ""
echo "✓ Build complete!"
echo ""
echo "  App:  src-tauri/target/release/bundle/macos/YusafCut.app"
echo "  DMG:  src-tauri/target/release/bundle/dmg/"
echo ""
echo "  Note: The app is unsigned. On first open, right-click → Open → Open anyway"
echo "  to bypass macOS Gatekeeper."
