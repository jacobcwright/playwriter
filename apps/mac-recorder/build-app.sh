#!/bin/bash
# Builds dist/Playwriter Recorder.app (+ a zip) from the fork's extension and CLI.
#
#   apps/mac-recorder/build-app.sh [--rebuild-extension] [--no-binary]
#
#   --no-binary   skip Contents/Resources/bin even if playwriter/dist-bin has
#                 the CLI binary, so the app runs in development mode
#                 (tsx playwriter/src/cli.ts from this checkout)
#
# Signing (default: ad-hoc, no Apple account needed). See README
# "Signing and notarizing".
#   PLAYWRITER_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"
#                 sign with that identity, hardened runtime, timestamp and
#                 src/entitlements.plist on the Bun binary
#   PLAYWRITER_NOTARY_PROFILE=<name>      notarize with `xcrun notarytool`
#                 credentials stored by `xcrun notarytool store-credentials`
#   PLAYWRITER_NOTARY_APPLE_ID + PLAYWRITER_NOTARY_PASSWORD +
#   PLAYWRITER_NOTARY_TEAM_ID             the same, with inline credentials
#                 Notarization requires PLAYWRITER_SIGN_IDENTITY. On success
#                 the ticket is stapled to the app and the zip is rebuilt.
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

# NUL-separated list of the Mach-O files under $1 (everything codesign must
# sign individually before the bundle).
list_macho_files() {
  find "$1" -type f -print0 | while IFS= read -r -d '' f; do
    if file -b "$f" 2>/dev/null | grep -q '^Mach-O'; then
      printf '%s\0' "$f"
    fi
  done
}
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
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Signing / notarization configuration. Validated before anything is built so
# a typo in an env var fails in a second, not after the extension build.
SIGN_IDENTITY=${PLAYWRITER_SIGN_IDENTITY:-}
ENTITLEMENTS="$HERE/src/entitlements.plist"
NOTARY_ARGS=()
if [ -n "$SIGN_IDENTITY" ]; then
  IDENTITIES=$(security find-identity -v -p codesigning 2>/dev/null || true)
  if ! printf '%s\n' "$IDENTITIES" | grep -F -q -- "$SIGN_IDENTITY"; then
    {
      echo "error: PLAYWRITER_SIGN_IDENTITY=\"$SIGN_IDENTITY\" is not a code-signing identity in your keychain."
      echo "       'security find-identity -v -p codesigning' lists:"
      printf '%s\n' "${IDENTITIES:-       (nothing)}" | sed 's/^/       /'
      echo "       Create a 'Developer ID Application' certificate in Xcode > Settings > Accounts > Manage Certificates."
    } >&2
    exit 1
  fi
  [ -f "$ENTITLEMENTS" ] || { echo "error: $ENTITLEMENTS is missing" >&2; exit 1; }
  plutil -lint "$ENTITLEMENTS" >/dev/null
fi
if [ -n "${PLAYWRITER_NOTARY_PROFILE:-}" ]; then
  NOTARY_ARGS=(--keychain-profile "$PLAYWRITER_NOTARY_PROFILE")
elif [ -n "${PLAYWRITER_NOTARY_APPLE_ID:-}${PLAYWRITER_NOTARY_PASSWORD:-}${PLAYWRITER_NOTARY_TEAM_ID:-}" ]; then
  if [ -z "${PLAYWRITER_NOTARY_APPLE_ID:-}" ] || [ -z "${PLAYWRITER_NOTARY_PASSWORD:-}" ] || [ -z "${PLAYWRITER_NOTARY_TEAM_ID:-}" ]; then
    echo "error: set all three of PLAYWRITER_NOTARY_APPLE_ID, PLAYWRITER_NOTARY_PASSWORD and PLAYWRITER_NOTARY_TEAM_ID (or PLAYWRITER_NOTARY_PROFILE instead)." >&2
    exit 1
  fi
  NOTARY_ARGS=(--apple-id "$PLAYWRITER_NOTARY_APPLE_ID" --password "$PLAYWRITER_NOTARY_PASSWORD" --team-id "$PLAYWRITER_NOTARY_TEAM_ID")
fi
if [ "${#NOTARY_ARGS[@]}" -gt 0 ]; then
  if [ -z "$SIGN_IDENTITY" ]; then
    echo "error: notarization needs a Developer ID signature; set PLAYWRITER_SIGN_IDENTITY too." >&2
    exit 1
  fi
  xcrun --find notarytool >/dev/null 2>&1 || { echo "error: 'xcrun notarytool' not found; install Xcode or the Command Line Tools (Xcode 13+)." >&2; exit 1; }
  xcrun --find stapler >/dev/null 2>&1 || { echo "error: 'xcrun stapler' not found; install Xcode or the Command Line Tools." >&2; exit 1; }
fi

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

if [ -z "$SIGN_IDENTITY" ]; then
  echo "==> Ad-hoc code signing (set PLAYWRITER_SIGN_IDENTITY for Developer ID signing)"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
else
  # Developer ID: sign inner-first (nested code before the bundle), never
  # --deep. The Bun binary gets the JIT entitlements; everything else just
  # the hardened runtime. A secure timestamp needs network access.
  echo "==> Code signing with \"$SIGN_IDENTITY\" (hardened runtime, timestamp)"
  SIGN=(codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY")
  BUN_BINARY="$RESOURCES/bin/playwriter-recorder"
  if [ -f "$BUN_BINARY" ]; then
    echo "    $BUN_BINARY (entitlements: $(basename "$ENTITLEMENTS"))"
    "${SIGN[@]}" --entitlements "$ENTITLEMENTS" "$BUN_BINARY"
  fi
  while IFS= read -r -d '' macho; do
    [ "$macho" = "$BUN_BINARY" ] && continue
    echo "    $macho"
    "${SIGN[@]}" "$macho"
  done < <(list_macho_files "$APP")
  echo "    $APP"
  "${SIGN[@]}" "$APP"

  echo "==> Verifying signature"
  codesign --verify --deep --strict --verbose=2 "$APP"
  codesign --display --verbose=2 "$APP" 2>&1 | sed -E -n 's/^(Identifier|Authority|TeamIdentifier|Timestamp)=/    &/p'
  # Gatekeeper: before notarization this reports "rejected, source=Unnotarized
  # Developer ID" on macOS 10.15+, which is expected, so it is informational
  # here and enforced after stapling below.
  if spctl --assess --type execute --verbose=2 "$APP" 2>&1 | sed 's/^/    spctl: /'; then
    echo "    spctl: accepted"
  elif [ "${#NOTARY_ARGS[@]}" -eq 0 ]; then
    echo "    spctl rejected the app: expected for a Developer ID app that is not notarized (set PLAYWRITER_NOTARY_PROFILE to notarize)."
  fi
fi

if [ "${#NOTARY_ARGS[@]}" -gt 0 ]; then
  echo "==> Notarizing: uploading to Apple (this takes a few minutes)"
  NOTARIZE_ZIP="$STAGE/notarize.zip"
  ditto -c -k --keepParent "$APP" "$NOTARIZE_ZIP"
  set +e
  SUBMIT_OUT=$(xcrun notarytool submit "$NOTARIZE_ZIP" "${NOTARY_ARGS[@]}" --wait 2>&1)
  SUBMIT_STATUS=$?
  set -e
  printf '%s\n' "$SUBMIT_OUT" | sed 's/^/    /'
  SUBMISSION_ID=$(printf '%s\n' "$SUBMIT_OUT" | sed -n 's/^ *id: *//p' | head -1)
  NOTARY_STATUS=$(printf '%s\n' "$SUBMIT_OUT" | sed -n 's/^ *status: *//p' | tail -1)
  if [ "$SUBMIT_STATUS" -ne 0 ] || [ "$NOTARY_STATUS" != "Accepted" ]; then
    echo "==> Notarization failed (status: ${NOTARY_STATUS:-no status, notarytool exit $SUBMIT_STATUS})" >&2
    if [ -n "$SUBMISSION_ID" ]; then
      echo "==> notarytool log $SUBMISSION_ID:" >&2
      xcrun notarytool log "$SUBMISSION_ID" "${NOTARY_ARGS[@]}" >&2 || true
    fi
    exit 1
  fi
  echo "==> Notarization accepted (submission $SUBMISSION_ID); stapling the ticket"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  echo "==> Gatekeeper assessment of the stapled app"
  if ! spctl --assess --type execute --verbose=2 "$APP" 2>&1 | sed 's/^/    /'; then
    echo "error: spctl rejected the notarized, stapled app; see the lines above." >&2
    exit 1
  fi
fi

mkdir -p "$OUT_DIR"
rm -rf "$OUT_DIR/$APP_NAME.app"
ditto "$APP" "$OUT_DIR/$APP_NAME.app"
ZIP="$OUT_DIR/Playwriter-Recorder-$VERSION.zip"
rm -f "$ZIP"
echo "==> Zipping $(basename "$ZIP")"
(cd "$OUT_DIR" && ditto -c -k --sequesterRsrc --keepParent "$APP_NAME.app" "$ZIP")

echo
echo "Built:"
echo "  $OUT_DIR/$APP_NAME.app"
echo "  $ZIP"
if [ -z "$SIGN_IDENTITY" ]; then
  echo "Signed: ad-hoc (recipients must use right-click > Open or System Settings > Open Anyway)"
elif [ "${#NOTARY_ARGS[@]}" -gt 0 ]; then
  echo "Signed: $SIGN_IDENTITY, notarized and stapled"
else
  echo "Signed: $SIGN_IDENTITY, NOT notarized (recipients still see a Gatekeeper warning)"
fi
echo "Run:   open \"$OUT_DIR/$APP_NAME.app\""
