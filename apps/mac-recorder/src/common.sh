#!/bin/bash
# Shared helpers for the Playwriter Recorder launcher and the LaunchAgent
# install/uninstall scripts. This file is sourced, never executed.
#
# The caller must set RESOURCES_DIR (the app's Contents/Resources) before
# sourcing. Everything else is derived from it.

APP_NAME="Playwriter Recorder"
RELAY_PORT=19988
STATE_DIR="$HOME/Library/Application Support/Playwriter Recorder"
PROFILE_DIR="$STATE_DIR/profile"
LOG_FILE="$STATE_DIR/launcher.log"
RELAY_LOG_FILE="$STATE_DIR/relay.log"
LAUNCH_AGENT_LABEL="com.playwriter.recorder.relay"
LAUNCH_AGENT_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_LABEL.plist"
EXTENSION_DIR="$RESOURCES_DIR/extension"
BUNDLED_CLI="$RESOURCES_DIR/bin/playwriter-recorder"
BROWSERS_DIR="$HOME/.playwriter/browsers"
RECORDINGS_DIR="$HOME/.playwriter/recordings"

mkdir -p "$STATE_DIR"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

# Escape a string for use inside a double-quoted AppleScript literal.
applescript_quote() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# Modal error dialog. Never fails silently: the message also goes to the log.
show_error() {
  local message=$1
  log "ERROR: $message"
  local quoted
  quoted=$(applescript_quote "$message")
  local choice
  choice=$(osascript -e "display dialog \"$quoted\" with title \"$APP_NAME\" buttons {\"Show Log\", \"OK\"} default button \"OK\" with icon stop" 2>/dev/null | sed 's/^button returned://')
  if [ "$choice" = "Show Log" ]; then
    open -a Console "$LOG_FILE" 2>/dev/null || open "$LOG_FILE" 2>/dev/null || true
  fi
}

die() {
  show_error "$1"
  exit 1
}

notify() {
  local message=$1
  log "$message"
  osascript -e "display notification \"$(applescript_quote "$message")\" with title \"$APP_NAME\"" >/dev/null 2>&1 || true
}

# Put a Node.js install on PATH when launched from Finder (PATH is then just
# /usr/bin:/bin:/usr/sbin:/sbin). Only needed for the development fallback.
add_node_to_path() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi
  local candidates=()
  if [ -n "${PLAYWRITER_NODE_BIN:-}" ]; then
    candidates+=("$PLAYWRITER_NODE_BIN")
  fi
  candidates+=(
    /opt/homebrew/bin
    /usr/local/bin
    "$HOME/.volta/bin"
  )
  local dir
  while IFS= read -r dir; do
    [ -n "$dir" ] && candidates+=("$dir")
  done < <(ls -1d "$HOME/.local/share/fnm/node-versions"/*/installation/bin \
                  "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin \
                  "$HOME/.nvm/versions/node"/*/bin \
                  "$HOME/.fnm/node-versions"/*/installation/bin 2>/dev/null | sort -rV)
  for dir in "${candidates[@]}"; do
    if [ -x "$dir/node" ]; then
      export PATH="$dir:$PATH"
      log "Using Node.js from $dir"
      return 0
    fi
  done
  return 1
}

# Sets PW_CLI (array: the command prefix for the playwriter CLI), PW_MODE
# (bundled|dev) and, in dev mode, PW_REPO.
#
# Preferred: the single-file binary at Contents/Resources/bin/playwriter-recorder.
# Fallback for development: `tsx <repo>/playwriter/src/cli.ts`, where <repo>
# comes from $PLAYWRITER_REPO, then Contents/Resources/dev-repo-path (written
# by build-app.sh), then a few conventional locations.
resolve_cli() {
  if [ -x "$BUNDLED_CLI" ]; then
    PW_CLI=("$BUNDLED_CLI")
    PW_MODE=bundled
    log "Using bundled CLI: $BUNDLED_CLI"
    return 0
  fi

  local repo_candidates=()
  if [ -n "${PLAYWRITER_REPO:-}" ]; then
    repo_candidates+=("$PLAYWRITER_REPO")
  fi
  if [ -f "$RESOURCES_DIR/dev-repo-path" ]; then
    repo_candidates+=("$(cat "$RESOURCES_DIR/dev-repo-path")")
  fi
  repo_candidates+=("$HOME/playwriter" "$HOME/dev/playwriter" "$HOME/dev/work/playwriter" "$HOME/code/playwriter")

  local repo=""
  local candidate
  for candidate in "${repo_candidates[@]}"; do
    if [ -f "$candidate/playwriter/src/cli.ts" ]; then
      repo=$candidate
      break
    fi
  done
  if [ -z "$repo" ]; then
    die "No Playwriter CLI found. The app has no bundled binary (Contents/Resources/bin/playwriter-recorder) and no playwriter checkout was found. Set PLAYWRITER_REPO or rebuild the app with build-app.sh."
  fi

  if ! add_node_to_path; then
    die "Node.js was not found. The app is running in development mode (no bundled binary) and needs Node.js on this Mac. Install Node.js, or rebuild the app with the playwriter-recorder binary."
  fi

  export PATH="$repo/node_modules/.bin:$PATH"
  if [ -x "$repo/node_modules/.bin/tsx" ]; then
    PW_CLI=("$repo/node_modules/.bin/tsx" "$repo/playwriter/src/cli.ts")
  else
    PW_CLI=(npx tsx "$repo/playwriter/src/cli.ts")
  fi
  PW_MODE=dev
  PW_REPO=$repo
  log "Using development CLI: ${PW_CLI[*]}"
}

relay_is_up() {
  curl -s -m 2 "http://127.0.0.1:$RELAY_PORT/version" >/dev/null 2>&1
}

# Wait up to $1 seconds for the relay to answer.
wait_for_relay() {
  local deadline=$(( $(date +%s) + ${1:-20} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if relay_is_up; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# Start the relay detached from this process so it outlives the launcher.
start_relay_detached() {
  log "Starting relay: ${PW_CLI[*]} serve --host 127.0.0.1"
  nohup "${PW_CLI[@]}" serve --host 127.0.0.1 >> "$RELAY_LOG_FILE" 2>&1 < /dev/null &
  disown 2>/dev/null || true
}

# Prints the path of the Chrome for Testing binary, or nothing.
# Same search order as playwriter's resolveBrowserExecutablePath on macOS.
find_chrome() {
  if [ -n "${PLAYWRITER_BROWSER_PATH:-}" ] && [ -x "$PLAYWRITER_BROWSER_PATH" ]; then
    printf '%s' "$PLAYWRITER_BROWSER_PATH"
    return 0
  fi
  local dir candidate
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    for candidate in \
      "$dir/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
      "$dir/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
      "$dir/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"; do
      if [ -x "$candidate" ]; then
        printf '%s' "$candidate"
        return 0
      fi
    done
  done < <(ls -1d "$BROWSERS_DIR"/chrome-* 2>/dev/null | sort -r)
  for candidate in \
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    "$HOME/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}
