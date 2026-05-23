#!/usr/bin/env bash
# =============================================================================
# YusafCut — create Xcode archive for App Store Connect upload
#
# Wraps the MAS-signed .app into a YusafCut.xcarchive bundle that Xcode
# Organizer understands. Opening the archive launches Xcode Organizer,
# where you click "Distribute App → App Store Connect → Upload".
#
# Usage:
#   npm run xcarchive
#
# Prerequisites:
#   npm run build:mas  (must run first)
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
die()  { echo -e "  ${RED}✗${RESET}  $*"; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=$(find "$REPO/src-tauri/target/release/bundle/macos" -name "*.app" 2>/dev/null | head -1)
VERSION=$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo "unknown")
ARCHIVE="$REPO/YusafCut.xcarchive"

[[ -n "$APP" ]] || die "No .app found. Run 'npm run build:mas' first."

echo -e "\n${BOLD}Creating YusafCut.xcarchive${RESET}"
info "Source: $APP"
info "Target: $ARCHIVE"

# Build the archive directory structure Xcode Organizer expects
rm -rf "$ARCHIVE"
mkdir -p "$ARCHIVE/Products/Applications"
cp -R "$APP" "$ARCHIVE/Products/Applications/"

# Write the Info.plist that Xcode Organizer uses to identify the archive
cat > "$ARCHIVE/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ApplicationProperties</key>
  <dict>
    <key>ApplicationPath</key>
    <string>Products/Applications/YusafCut.app</string>
    <key>CFBundleIdentifier</key>
    <string>dev.yusafcut.app</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>SigningIdentity</key>
    <string>Apple Distribution</string>
  </dict>
  <key>ArchiveVersion</key>
  <integer>2</integer>
  <key>CreationDate</key>
  <string>$(date -u +"%Y-%m-%dT%H:%M:%SZ")</string>
  <key>Name</key>
  <string>YusafCut</string>
  <key>SchemeName</key>
  <string>YusafCut</string>
</dict>
</plist>
PLIST

ok "Archive created: $ARCHIVE"

echo ""
echo -e "  ${BOLD}Opening in Xcode Organizer...${RESET}"
echo -e "  In Xcode, click ${BOLD}Distribute App${RESET} → ${BOLD}App Store Connect${RESET} → ${BOLD}Upload${RESET}"
echo ""

open "$ARCHIVE"
