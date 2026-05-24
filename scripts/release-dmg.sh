#!/bin/bash
set -e

# Parse arguments
BUMP_TYPE="${1:-patch}"

if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo "Usage: npm run dmg:release [major|minor|patch]"
  echo "  Default: patch"
  exit 1
fi

# Extract current version
CURRENT_VERSION=$(jq -r '.version' package.json)
echo "Current version: $CURRENT_VERSION"

# Calculate next version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_TYPE" in
  major)
    NEW_VERSION="$((MAJOR + 1)).0.0"
    ;;
  minor)
    NEW_VERSION="$MAJOR.$((MINOR + 1)).0"
    ;;
  patch)
    NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
    ;;
esac

echo "New version: $NEW_VERSION"
echo ""

# Create release branch
BRANCH="chore/release-$NEW_VERSION"
echo "🌿 Creating branch: $BRANCH"
git checkout main
git pull origin main
git checkout -b "$BRANCH"

# Update package.json
echo "📝 Updating package.json..."
jq ".version = \"$NEW_VERSION\"" package.json > package.json.tmp
mv package.json.tmp package.json

# Update Cargo.toml
echo "📝 Updating src-tauri/Cargo.toml..."
sed -i '' "s/^version = \".*\"$/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml

# Update tauri.conf.json
echo "📝 Updating src-tauri/tauri.conf.json..."
jq ".version = \"$NEW_VERSION\"" src-tauri/tauri.conf.json > src-tauri/tauri.conf.json.tmp
mv src-tauri/tauri.conf.json.tmp src-tauri/tauri.conf.json

# Update Cargo.lock
echo "📝 Updating src-tauri/Cargo.lock..."
cd src-tauri && cargo update -p scribe 2>/dev/null || true && cd ..

# Commit version bump
echo "📦 Committing version bump..."
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock
git commit -m "chore: bump version to $NEW_VERSION"

# Push branch
echo "🚀 Pushing branch..."
git push -u origin "$BRANCH"

# Create PR
echo "📋 Creating pull request..."
PR_URL=$(gh pr create \
  --title "chore: release v$NEW_VERSION" \
  --body "Version bump to $NEW_VERSION. See CHANGELOG.md for details." | grep -oP 'https.*')

echo "PR created: $PR_URL"
echo ""

# Merge PR
echo "✅ Merging PR to main..."
gh pr merge "$BRANCH" --squash --auto 2>/dev/null || gh pr merge "$BRANCH" --squash
sleep 2

# Switch back to main and pull
echo "🔄 Switching to main and pulling..."
git checkout main
git pull origin main

# Build and release DMG
TAG="v$NEW_VERSION"
echo ""
echo "📦 Building notarized DMG for version $NEW_VERSION..."
npm run tauri:build:dmg

# Find the DMG file
DMG_FILE=$(ls -t src-tauri/target/release/bundle/macos/YusafCut_*.dmg 2>/dev/null | head -1)

if [ ! -f "$DMG_FILE" ]; then
  echo "❌ DMG file not found at src-tauri/target/release/bundle/macos/"
  exit 1
fi

echo "✅ DMG built: $DMG_FILE"
echo ""

# Create git tag
echo "🏷️  Creating release tag: $TAG"
git tag "$TAG"
git push origin "$TAG"

# Create GitHub release
echo "📝 Creating GitHub release..."
NOTES="YusafCut $NEW_VERSION release. See [CHANGELOG.md](https://github.com/awaismirza/yusafCut/blob/main/CHANGELOG.md) for details."

gh release create "$TAG" \
  --title "YusafCut $NEW_VERSION" \
  --notes "$NOTES" \
  "$DMG_FILE"

echo ""
echo "🎉 Release complete!"
echo "📲 Download: https://github.com/awaismirza/yusafCut/releases/tag/$TAG"
