#!/bin/bash
# Builds dist/Playwriter Recorder.app (+ a zip) from the fork's extension and CLI.
#
#   apps/mac-recorder/build-app.sh [--rebuild-extension] [--no-binary]
#
#   --no-binary   skip Contents/Resources/bin even if playwriter/dist-bin has
#                 the CLI binary, so the app runs in development mode
#                 (tsx playwriter/src/cli.ts from this checkout)
#
# Bundle layout:
#   Contents/Info.plist
#   Contents/MacOS/launcher                  bash launcher (src/launcher.sh)
#   Contents/Resources/lib/common.sh         shared helpers
#   Contents/Resources/extension/            copy of extension/dist
#   Contents/Resources/bin/playwriter-recorder   single-file CLI+relay, when
#                                            playwriter/dist-bin/ has it
#   Contents/Resources/dev-repo-path         absolute repo path, for the
#                                            `tsx playwriter/src/cli.ts` fallback
#   Contents/Resources/ready.html            page opened on launch
#   Contents/Resources/install-relay-agent.sh, uninstall-relay-agent.sh
#   Contents/Resources/icon.icns
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
APP_NAME="Playwriter Recorder"
OUT_DIR="$HERE/dist"
EXTENSION_DIST="$REPO/extension/dist"
BINARY="$REPO/playwriter/dist-bin/playwriter-recorder"
VERSION=$(node -p "require('$REPO/playwriter/package.json').version" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/playwriter/package.json" | head -1)
BUILD_NUMBER=$(date +%Y%m%d%H%M)

REBUILD_EXTENSION=0
NO_BINARY=0
for arg in "$@"; do
  case "$arg" in
    --rebuild-extension) REBUILD_EXTENSION=1 ;;
    --no-binary) NO_BINARY=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$REBUILD_EXTENSION" = 1 ] || [ ! -f "$EXTENSION_DIST/manifest.json" ]; then
  echo "==> Building extension (extension/dist)"
  (cd "$REPO/extension" && pnpm build)
fi
[ -f "$EXTENSION_DIST/manifest.json" ] || { echo "extension/dist/manifest.json still missing" >&2; exit 1; }

# Stage in a temp dir; the previous dist app is only replaced after success.
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/playwriter-recorder-build.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/$APP_NAME.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/lib" "$RESOURCES/bin"

echo "==> Assembling $APP_NAME.app (version $VERSION, build $BUILD_NUMBER)"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUMBER/" "$HERE/src/Info.plist" > "$CONTENTS/Info.plist"
plutil -lint "$CONTENTS/Info.plist" >/dev/null

install -m 755 "$HERE/src/launcher.sh" "$CONTENTS/MacOS/launcher"
install -m 644 "$HERE/src/common.sh" "$RESOURCES/lib/common.sh"
install -m 755 "$HERE/src/install-relay-agent.sh" "$RESOURCES/install-relay-agent.sh"
install -m 755 "$HERE/src/uninstall-relay-agent.sh" "$RESOURCES/uninstall-relay-agent.sh"
install -m 644 "$HERE/src/ready.html" "$RESOURCES/ready.html"

echo "==> Copying extension from $EXTENSION_DIST"
ditto "$EXTENSION_DIST" "$RESOURCES/extension"

if [ "$NO_BINARY" = 1 ]; then
  echo "==> --no-binary: skipping the CLI binary; the app will run tsx $REPO/playwriter/src/cli.ts (development mode)"
elif [ -f "$BINARY" ]; then
  echo "==> Bundling CLI binary $BINARY"
  install -m 755 "$BINARY" "$RESOURCES/bin/playwriter-recorder"
  # `recorder start` prints the skill-authoring instructions from a sidecar
  # next to the executable (see cli.ts: PLAYWRITER_PROMPT_DIR / execPath lookup)
  install -m 644 "$(dirname "$BINARY")/recorder-prompt.md" "$RESOURCES/bin/recorder-prompt.md"
else
  echo "==> No CLI binary at $BINARY; the app will fall back to tsx $REPO/playwriter/src/cli.ts (development mode)"
fi
printf '%s' "$REPO" > "$RESOURCES/dev-repo-path"

echo "==> Building icon"
ICON_SRC="$EXTENSION_DIST/icons/playwriter-icon-black.png"
ICONSET="$STAGE/icon.iconset"
mkdir -p "$ICONSET"
if [ -f "$ICON_SRC" ]; then
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$RESOURCES/icon.icns" || echo "    (iconutil failed; app ships without an icon)"
else
  echo "    (no icon source at $ICON_SRC; app ships without an icon)"
fi

echo "==> Ad-hoc code signing (no Developer ID on this machine)"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

mkdir -p "$OUT_DIR"
rm -rf "$OUT_DIR/$APP_NAME.app"
ditto "$APP" "$OUT_DIR/$APP_NAME.app"
ZIP="$OUT_DIR/Playwriter-Recorder-$VERSION.zip"
rm -f "$ZIP"
(cd "$OUT_DIR" && ditto -c -k --sequesterRsrc --keepParent "$APP_NAME.app" "$ZIP")

echo
echo "Built:"
echo "  $OUT_DIR/$APP_NAME.app"
echo "  $ZIP"
echo "Run:   open \"$OUT_DIR/$APP_NAME.app\""
