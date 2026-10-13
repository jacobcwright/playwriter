#!/bin/bash
# Playwriter Recorder launcher (Contents/MacOS/launcher).
#
# Double-clicking the app runs this script. It:
#   1. makes sure the local relay is running on 127.0.0.1:19988
#   2. makes sure Chrome for Testing is installed (downloads it once)
#   3. opens Chrome for Testing with the bundled Playwriter extension and a
#      persistent profile, on the "ready" page
# Every failure is shown in a dialog; nothing fails silently.
#
# On the first launch (no $LOGINS_MARKER), once the extension is connected, it
# offers to copy the user's logins from their everyday Chrome (import_logins
# in common.sh).
#
# Flags: --install-login-item / --uninstall-login-item manage the LaunchAgent
# that keeps the relay alive at login (see install-relay-agent.sh).
# --import-logins runs the normal launch and then copies the Chrome logins
# again, without asking (open -a "Playwriter Recorder" --args --import-logins).

set -u

MACOS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONTENTS_DIR=$(dirname "$MACOS_DIR")
RESOURCES_DIR="$CONTENTS_DIR/Resources"
# shellcheck source=common.sh
. "$RESOURCES_DIR/lib/common.sh"

IMPORT_LOGINS=0
case "${1:-}" in
  --install-login-item)
    exec "$RESOURCES_DIR/install-relay-agent.sh"
    ;;
  --uninstall-login-item)
    exec "$RESOURCES_DIR/uninstall-relay-agent.sh"
    ;;
  --import-logins)
    IMPORT_LOGINS=1
    ;;
esac

log "---- launch ----"

if [ ! -f "$EXTENSION_DIR/manifest.json" ]; then
  die "The app bundle is incomplete: the Playwriter extension is missing from Contents/Resources/extension. Rebuild the app with build-app.sh."
fi
export PLAYWRITER_EXTENSION_PATH="$EXTENSION_DIR"

resolve_cli

# 1. Relay --------------------------------------------------------------------
if relay_is_up; then
  log "Relay already running on port $RELAY_PORT"
else
  start_relay_detached
  if ! wait_for_relay 20; then
    die "The Playwriter relay did not start on port $RELAY_PORT. See $RELAY_LOG_FILE for details."
  fi
  log "Relay started"
fi

# 2. Chrome for Testing -------------------------------------------------------
CHROME=$(find_chrome || true)
if [ -z "$CHROME" ]; then
  notify "First run: downloading Chrome for Testing (about 200 MB). This takes a minute."
  log "Installing Chrome for Testing: ${PW_CLI[*]} browser install"
  if ! "${PW_CLI[@]}" browser install >> "$LOG_FILE" 2>&1; then
    die "Downloading Chrome for Testing failed. Check your internet connection and try again."
  fi
  CHROME=$(find_chrome || true)
  if [ -z "$CHROME" ]; then
    die "Chrome for Testing was downloaded but its binary was not found under $BROWSERS_DIR."
  fi
fi
log "Browser: $CHROME"

# 3. Launch the browser --------------------------------------------------------
# Flags mirror playwriter/src/browser-launch.ts getBrowserLaunchArgs. The same
# command works on every click: Chrome forwards the URL to an instance that is
# already running on this profile and exits, so re-launching the app just opens
# a new tab in the existing window.
mkdir -p "$PROFILE_DIR"
READY_URL="file://$RESOURCES_DIR/ready.html"
CHROME_ARGS=(
  "--user-data-dir=$PROFILE_DIR"
  "--profile-directory=Default"
  "--no-first-run"
  "--no-default-browser-check"
  "--auto-accept-this-tab-capture"
  # EXTENSION_IDS from playwriter/src/utils.ts (the dev build's stable id is
  # pebbngnfojnignonigcnkdilknapkgid, derived from the manifest "key").
  "--allowlisted-extension-id=jfeammnjpkecdekppnclgkkffahnhfhe"
  "--allowlisted-extension-id=pebbngnfojnignonigcnkdilknapkgid"
  "--allowlisted-extension-id=laceiahnielojmkjcfpcjhjnnmjobckf"
  "--disable-extensions-except=$EXTENSION_DIR"
  "--load-extension=$EXTENSION_DIR"
  "$READY_URL"
)
log "Launching: $CHROME ${CHROME_ARGS[*]}"
nohup "$CHROME" "${CHROME_ARGS[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
disown 2>/dev/null || true

# Confirm the extension reached the relay (already true on a re-launch).
wait_for_extension() {
  local deadline=$(( $(date +%s) + ${1:-20} ))
  local status
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status=$(curl -s -m 2 "http://127.0.0.1:$RELAY_PORT/extensions/status" 2>/dev/null || true)
    case "$status" in
      *'"extensionId"'*) return 0 ;;
    esac
    sleep 0.5
  done
  return 1
}

# 4. Logins -------------------------------------------------------------------
# Runs only once the extension is connected: the import goes through the relay
# into this browser. --import-logins forces it; otherwise it is offered once.
after_extension_connected() {
  if [ "$IMPORT_LOGINS" = 1 ]; then
    import_logins run
  elif [ ! -e "$LOGINS_MARKER" ]; then
    import_logins offer
  else
    log "Logins already offered ($LOGINS_MARKER); delete it or use --import-logins to copy them again"
  fi
}

if wait_for_extension 20; then
  log "Extension connected to relay"
  after_extension_connected
else
  # Seen once on a first run: the relay answered GETs and curl, but the
  # extension's startup probe (HEAD /) hung until the relay was restarted.
  # One restart is cheap; the extension retries every few seconds.
  log "Extension not connected after 20s; restarting the relay once"
  lsof -ti ":$RELAY_PORT" 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1
  start_relay_detached
  if wait_for_relay 20 && wait_for_extension 20; then
    log "Extension connected to relay after relay restart"
    after_extension_connected
  else
    log "Logins import skipped: the extension is not connected"
    show_error "Chrome for Testing opened, but the Playwriter extension has not connected to the relay. If the toolbar says 'Relay not connected', quit the browser and open $APP_NAME again. Logs: $LOG_FILE and $HOME/.playwriter/relay-server.log"
  fi
fi
exit 0
