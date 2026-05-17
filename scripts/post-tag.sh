#!/bin/sh
# .git/hooks/post-tag  — auto-push a lightweight project update when you run:
#   git tag v2.1.0 -m "Added system tray & auto-launch"
#
# INSTALL:
#   cp scripts/post-tag.sh .git/hooks/post-tag
#   chmod +x .git/hooks/post-tag

TAG_NAME="$1"
TAG_MSG="$2"

if [ -z "$TAG_NAME" ]; then
  # Try to get the latest tag if called without args (e.g. from post-commit hook)
  TAG_NAME=$(git describe --tags --abbrev=0 2>/dev/null)
fi

if [ -z "$TAG_NAME" ]; then
  echo "[post-tag] No tag name found — skipping dashboard push."
  exit 0
fi

if [ -z "$TAG_MSG" ]; then
  TAG_MSG=$(git tag -l --format='%(contents)' "$TAG_NAME" 2>/dev/null | head -1)
fi

echo "[post-tag] Pushing project update for $TAG_NAME: $TAG_MSG"

node "$(git rev-parse --show-toplevel)/scripts/push-project-update.js" \
  --version "$TAG_NAME" \
  --title   "$TAG_MSG" \
  --summary "Released $TAG_NAME of DailyUpdates xProfileScraperMailer." \
  --changes "chore:Tagged $TAG_NAME"

echo "[post-tag] Done."
