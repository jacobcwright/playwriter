#!/bin/bash
# Playwriter Recorder installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/jacobcwright/playwriter/codex/microphone-narration/apps/mac-recorder/install.sh | bash
#
# Downloads the latest release zip with curl (which does not add the
# quarantine flag browsers add, so Gatekeeper does not block an unnotarized
# build), unpacks it into /Applications (or ~/Applications), and opens it.
set -euo pipefail

REPO="${PLAYWRITER_RECORDER_REPO:-jacobcwright/playwriter}"
ASSET="${PLAYWRITER_RECORDER_ASSET:-Playwriter-Recorder.zip}"
URL="${PLAYWRITER_RECORDER_URL:-https://github.com/$REPO/releases/latest/download/$ASSET}"
APP_NAME="Playwriter Recorder.app"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Playwriter Recorder is a macOS app. This installer only runs on a Mac." >&2
  exit 1
fi

dest="/Applications"
if [ ! -w "$dest" ]; then
  dest="$HOME/Applications"
  mkdir -p "$dest"
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/playwriter-recorder.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "==> Downloading $URL"
curl -fL --progress-bar -o "$tmp/app.zip" "$URL"

echo "==> Unpacking"
ditto -x -k "$tmp/app.zip" "$tmp/unpacked"
src="$(find "$tmp/unpacked" -maxdepth 2 -name "$APP_NAME" -type d | head -1)"
if [ -z "$src" ]; then
  echo "The download did not contain $APP_NAME" >&2
  exit 1
fi

if [ -d "$dest/$APP_NAME" ]; then
  echo "==> Replacing the existing copy in $dest"
  osascript -e 'tell application "Playwriter Recorder" to quit' >/dev/null 2>&1 || true
  rm -rf "$dest/$APP_NAME"
fi
ditto "$src" "$dest/$APP_NAME"
# Belt and braces: curl does not set it, but clear it in case the zip came
# through a browser into this shell's hands.
xattr -dr com.apple.quarantine "$dest/$APP_NAME" 2>/dev/null || true

echo "==> Installed $dest/$APP_NAME"
echo "==> Opening it. The first run downloads its own Chrome (about 200 MB, once)."
open "$dest/$APP_NAME"
