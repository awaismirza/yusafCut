#!/bin/bash
set -e

# Extract version from package.json
VERSION=$(jq -r '.version' package.json)
TAG="v$VERSION"

echo "📦 Building notarized DMG for version $VERSION..."
npm run tauri:build:dmg

# Find the DMG file
DMG_FILE=$(ls -t src-tauri/target/release/bundle/macos/YusafCut_*.dmg 2>/dev/null | head -1)

if [ ! -f "$DMG_FILE" ]; then
  echo "❌ DMG file not found at src-tauri/target/release/bundle/macos/"
  exit 1
fi

echo "✅ DMG built: $DMG_FILE"
echo ""
echo "📝 Creating GitHub release $TAG..."

# Get release notes from CHANGELOG.md (section for this version)
NOTES=$(awk "/^\[${VERSION}\]/,/^\[/" CHANGELOG.md | head -n -1 | tail -n +2)

if [ -z "$NOTES" ]; then
  NOTES="YusafCut $VERSION release. See CHANGELOG.md for details."
fi

# Create GitHub release
gh release create "$TAG" \
  --title "YusafCut $VERSION" \
  --notes "$NOTES" \
  "$DMG_FILE"

echo ""
echo "🎉 Release published!"
echo "📲 Download: https://github.com/awaismirza/yusafCut/releases/tag/$TAG"
