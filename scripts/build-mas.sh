#!/usr/bin/env bash
# =============================================================================
# YusafCut — Mac App Store build script
#
# Builds a signed .app bundle for Mac App Store submission.
# The resulting app is NOT notarised (Apple handles that after upload).
#
# Usage:
#   npm run build:mas
#
# Prerequisites:
#   1. All five sidecar binaries built and present in src-tauri/binaries/.
#      If any are missing or stubs, run `npm run build:production` first —
#      it builds the binaries as a side-effect of the DMG build.
#   2. Apple Distribution certificate installed in your login keychain.
#      (Xcode → Settings → Accounts → Manage Certificates → + → Apple Distribution)
#   3. Mac App Store provisioning profile downloaded from developer.apple.com
#      and saved as src-tauri/YusafCut_MAS.provisionprofile.
#
# After this script:
#   Run `npm run xcarchive` to create a YusafCut.xcarchive and open it in
#   Xcode Organizer for upload to App Store Connect.
# =============================================================================
set -euo pipefail

# ── colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()     { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()   { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
info()   { echo -e "  ${CYAN}→${RESET}  $*"; }
fail()   { echo -e "  ${RED}✗${RESET}  $*"; }
header() { echo -e "\n${BOLD}$*${RESET}"; }
die()    { fail "$*"; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINS="$REPO/src-tauri/binaries"
ARCH_SUFFIX="aarch64-apple-darwin"
BUILD_START=$(date +%s)

echo -e "\n${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║    YusafCut — Mac App Store build          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"

# ── 1. Platform guard ─────────────────────────────────────────────────────────
header "1 / 4  Platform"
[[ "$(uname -s)" == "Darwin" ]] || die "macOS required."
[[ "$(uname -m)" == "arm64"  ]] || die "Apple Silicon (arm64) required."
ok "Apple Silicon Mac"

# ── 2. Verify all five sidecar binaries are real compiled binaries ─────────────
header "2 / 4  Sidecar binaries"

MISSING=()
for bin in whisper-cli whisperkit-cli ffmpeg ffprobe mlx-sidecar; do
  f="$BINS/${bin}-$ARCH_SUFFIX"
  if [[ ! -x "$f" ]]; then
    MISSING+=("$bin (missing)")
  elif head -c2 "$f" 2>/dev/null | grep -q '^#!'; then
    MISSING+=("$bin (dev stub — not a compiled binary)")
  else
    BIN_SIZE=$(du -sh "$f" | awk '{print $1}')
    ok "$bin  (${BIN_SIZE})"
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  fail "The following binaries are missing or not yet compiled:"
  for m in "${MISSING[@]}"; do
    fail "  • $m"
  done
  echo ""
  echo -e "  Run ${BOLD}npm run build:production${RESET} first."
  echo -e "  That script builds all binaries as part of the DMG build."
  echo -e "  The binaries are then reused here for the MAS build."
  exit 1
fi

# ── 3. Provisioning profile ────────────────────────────────────────────────────
header "3 / 4  Provisioning profile"

PROFILE="$REPO/src-tauri/YusafCut_MAS.provisionprofile"
if [[ ! -f "$PROFILE" ]]; then
  die "Provisioning profile not found at src-tauri/YusafCut_MAS.provisionprofile

  To create one:
    1. Go to developer.apple.com → Certificates, Identifiers & Profiles → Profiles
    2. Create a new profile: Mac App Store Distribution
    3. Select App ID: dev.yusafcut.app
    4. Select your Apple Distribution certificate
    5. Download it and save to: src-tauri/YusafCut_MAS.provisionprofile"
fi
ok "Provisioning profile found"

# Check Apple Distribution cert is in keychain
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Apple Distribution"; then
  warn "No 'Apple Distribution' certificate found in keychain."
  warn "The build may fail during signing."
  warn "Add it via: Xcode → Settings → Accounts → Manage Certificates → + → Apple Distribution"
fi

# ── 4. Build MAS .app ─────────────────────────────────────────────────────────
header "4 / 4  Building MAS .app"
info "Running: tauri build --bundles app --config src-tauri/tauri.mas.conf.json"
info "This compiles Rust in release mode and signs the app bundle."
info "Expect 5–15 minutes."

cd "$REPO"
npx tauri build --bundles app --config src-tauri/tauri.mas.conf.json

APP=$(find "$REPO/src-tauri/target/release/bundle/macos" -name "*.app" 2>/dev/null | head -1)

BUILD_END=$(date +%s)
ELAPSED=$(( BUILD_END - BUILD_START ))
MINS=$(( ELAPSED / 60 ))
SECS=$(( ELAPSED % 60 ))

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║         MAS build complete! ✓           ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Time elapsed:  ${BOLD}${MINS}m ${SECS}s${RESET}"

if [[ -n "$APP" ]]; then
  APP_SIZE=$(du -sh "$APP" | awk '{print $1}')
  echo -e "  Output .app:   ${GREEN}${BOLD}$APP${RESET}"
  echo -e "  Size:          ${APP_SIZE}"
  echo ""
  echo -e "  ${CYAN}Verify signing:${RESET}  codesign --verify --deep --strict \"$APP\""
  echo -e "  ${CYAN}Next step:${RESET}       npm run xcarchive"
else
  warn "Could not locate .app — check src-tauri/target/release/bundle/macos/"
fi
echo ""
