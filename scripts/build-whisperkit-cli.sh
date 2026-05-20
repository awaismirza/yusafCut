#!/usr/bin/env bash
# =============================================================================
# Build whisperkit-cli from Argmax's WhisperKit Swift package.
#
# Produces: src-tauri/binaries/whisperkit-cli-aarch64-apple-darwin
#
# Requirements:
#   - macOS 13+ Apple Silicon
#   - Xcode with Swift toolchain  (xcode-select --install)
#
# Usage:
#   bash scripts/build-whisperkit-cli.sh          # latest release tag
#   bash scripts/build-whisperkit-cli.sh v0.14.0  # specific tag
#
# The built binary is a self-contained Mach-O — no Swift runtime on the
# end-user's machine is required because Tauri bundles it as an externalBin.
# =============================================================================
set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()     { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()   { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
info()   { echo -e "  ${CYAN}→${RESET}  $*"; }
fail()   { echo -e "  ${RED}✗${RESET}  $*"; }
die()    { fail "$*"; exit 1; }

# ── paths ─────────────────────────────────────────────────────────────────────
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINS="$REPO/src-tauri/binaries"
ARCH_SUFFIX="aarch64-apple-darwin"
DEST="$BINS/whisperkit-cli-$ARCH_SUFFIX"

echo -e "\n${BOLD}Building whisperkit-cli from source${RESET}"
echo -e "Output: ${CYAN}$DEST${RESET}\n"

# ── 1. platform / toolchain guard ─────────────────────────────────────────────
[[ "$(uname -s)" == "Darwin" ]] || die "macOS required."
[[ "$(uname -m)" == "arm64"  ]] || die "Apple Silicon (arm64) required."

if ! command -v swift >/dev/null 2>&1; then
  die "swift not found.\nInstall Xcode from the App Store or run: xcode-select --install"
fi
SWIFT_VER=$(swift --version 2>&1 | head -1)
ok "Swift: $SWIFT_VER"

# ── 2. resolve tag ─────────────────────────────────────────────────────────────
TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  info "Fetching latest WhisperKit release tag from GitHub…"
  TAG=$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/argmaxinc/WhisperKit/releases/latest" \
    2>/dev/null | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

  if [[ -z "$TAG" ]]; then
    warn "Could not resolve latest tag (GitHub rate limit?). Falling back to v0.14.0"
    TAG="v0.14.0"
  fi
fi
ok "WhisperKit tag: $TAG"

# ── 3. clone & build in a temp directory ──────────────────────────────────────
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

info "Cloning argmaxinc/WhisperKit @ $TAG (depth 1)…"
git clone --quiet --depth 1 \
  --branch "$TAG" \
  "https://github.com/argmaxinc/WhisperKit.git" \
  "$BUILD_DIR/WhisperKit"
ok "Cloned to $BUILD_DIR/WhisperKit"

info "Building whisperkit-cli (release, ~5–15 minutes on first run)…"
cd "$BUILD_DIR/WhisperKit"
swift build -c release --product whisperkit-cli 2>&1

# ── 4. locate the binary ──────────────────────────────────────────────────────
# Swift PM may put it in .build/release/ or .build/arm64-apple-macosx/release/
BUILT=""
for candidate in \
    "$BUILD_DIR/WhisperKit/.build/release/whisperkit-cli" \
    "$BUILD_DIR/WhisperKit/.build/arm64-apple-macosx/release/whisperkit-cli"; do
  if [[ -f "$candidate" ]]; then
    BUILT="$candidate"
    break
  fi
done

if [[ -z "$BUILT" ]]; then
  # Last-resort find
  BUILT=$(find "$BUILD_DIR/WhisperKit/.build" \
    -name "whisperkit-cli" -type f -not -path "*checkouts*" 2>/dev/null | head -1)
fi

[[ -n "$BUILT" ]] || die "Build succeeded but whisperkit-cli binary not found under .build/"

# ── 5. install ────────────────────────────────────────────────────────────────
mkdir -p "$BINS"
cp "$BUILT" "$DEST"
chmod +x "$DEST"

BIN_SIZE=$(du -sh "$DEST" | awk '{print $1}')
ok "Installed: $DEST ($BIN_SIZE)"

# Tell git to ignore local changes to this file so the compiled Mach-O binary
# is never accidentally staged or committed.  The repo tracks the tiny stub;
# the real binary is ephemeral and rebuilt by this script when needed.
git -C "$REPO" update-index --skip-worktree \
    "src-tauri/binaries/whisperkit-cli-$ARCH_SUFFIX" 2>/dev/null || true
ok "git skip-worktree set on whisperkit-cli — won't appear in 'git status'"

# Quick smoke-test — just make sure it prints a help line instead of crashing.
if "$DEST" --help 2>&1 | grep -qi "whisper\|transcribe\|usage"; then
  ok "Smoke-test passed (--help responded)"
else
  warn "Smoke-test inconclusive — run '$DEST transcribe --help' to verify manually."
fi

echo ""
echo -e "  ${GREEN}Done!${RESET} whisperkit-cli $TAG installed."
echo -e "  Restart 'npm run dev:full' or run 'npm run build:production' to pick it up."
echo ""
