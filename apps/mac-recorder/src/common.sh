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
# Exists once the "copy your logins from Chrome" question has been asked
# (answered either way). Delete it to be asked again on the next launch.
LOGINS_MARKER="$STATE_DIR/logins-offered"

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

# Informational dialog with a single OK button.
show_info() {
  local message=$1
  log "INFO: $message"
  osascript -e "display dialog \"$(applescript_quote "$message")\" with title \"$APP_NAME\" buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1 || true
}

# Two-button question. Prints the label of the clicked button, or nothing if
# the dialog could not be shown (osascript missing, no GUI session).
#   ask_dialog <message> <cancel label> <confirm label (default button)>
ask_dialog() {
  local message=$1 cancel_label=$2 confirm_label=$3
  osascript -e "display dialog \"$(applescript_quote "$message")\" with title \"$APP_NAME\" buttons {\"$(applescript_quote "$cancel_label")\", \"$(applescript_quote "$confirm_label")\"} default button \"$(applescript_quote "$confirm_label")\"" 2>/dev/null \
    | sed 's/^button returned://'
}

# Copies the user's logins (cookies) from their everyday Chrome into the
# recorder browser with `playwriter cookies import`. Needs PW_CLI (resolve_cli)
# and a running relay with the extension connected, because the import talks
# to the browser through the relay.
#
#   import_logins offer   first launch: ask first, then import if accepted
#   import_logins run     `launcher --import-logins`: import right away
#
# $LOGINS_MARKER is written as soon as the question has been answered (or the
# import requested), whatever the outcome, so the question is asked once.
#
# Test hook, so the flow can be exercised without a screen and without
# touching the browser: PLAYWRITER_RECORDER_AUTOANSWER=copy|skip answers the
# question without a dialog, replaces the result dialog with a log line, and
# runs the import with --dry-run. Note that --dry-run still decrypts the
# cookies (that is what it checks), so it still reads the Chrome Safe Storage
# key from the Keychain.
import_logins() {
  local mode=${1:-offer}
  local autoanswer=${PLAYWRITER_RECORDER_AUTOANSWER:-}
  local answer=copy

  if [ "$mode" = offer ]; then
    if [ -n "$autoanswer" ]; then
      answer=$autoanswer
      log "Logins: PLAYWRITER_RECORDER_AUTOANSWER=$autoanswer (test hook, question dialog skipped)"
    else
      local clicked
      clicked=$(ask_dialog "Copy your logins from Chrome into $APP_NAME?

This copies all the logins (cookies) currently in your Chrome profile, so the sites you are signed in to in Chrome are signed in here as well. macOS will ask once to allow access to your Chrome keychain item: click Always Allow. Nothing leaves this computer." "Not now" "Copy logins")
      if [ -z "$clicked" ]; then
        log "Logins: the question dialog could not be shown; asking again on the next launch"
        return 0
      fi
      log "Logins: question answered with '$clicked'"
      case "$clicked" in
        "Copy logins") answer=copy ;;
        *) answer=skip ;;
      esac
    fi
  else
    log "Logins: import requested (--import-logins)"
  fi

  mkdir -p "$STATE_DIR"
  date '+%Y-%m-%d %H:%M:%S' > "$LOGINS_MARKER"

  if [ "$answer" != copy ]; then
    log "Logins: not copied (marker written: $LOGINS_MARKER)"
    return 0
  fi

  local cmd=("${PW_CLI[@]}" cookies import --from chrome --profile Default --all)
  log "Logins: would run: ${cmd[*]}"
  if [ -n "$autoanswer" ]; then
    cmd+=(--dry-run)
    log "Logins: test hook active, running with --dry-run: ${cmd[*]}"
  fi

  local output status esc
  output=$("${cmd[@]}" 2>&1 < /dev/null)
  status=$?
  esc=$(printf '\033')
  output=$(printf '%s\n' "$output" | sed -E "s/${esc}\[[0-9;]*m//g")
  log "Logins: cookies import exited $status"
  printf '%s\n' "$output" | sed 's/^/    | /' >> "$LOG_FILE"

  local summary
  if [ "$status" -eq 0 ]; then
    summary=$(printf '%s\n' "$output" | grep -E '^(Imported|Would import) ' | tail -1)
    [ -n "$summary" ] || summary=$(printf '%s\n' "$output" | grep -v '^[[:space:]]*$' | tail -1)
    summary=${summary%:}
    log "Logins: $summary"
    if [ -n "$autoanswer" ]; then
      log "Logins: test hook active, result dialog skipped"
    else
      show_info "$summary

This browser is now signed in where Chrome was. Logins that live outside cookies (some passkeys and app-specific storage) are not copied; sign in to those sites once here."
    fi
  else
    summary=$(printf '%s\n' "$output" | sed -n '/^Error: /,$p' | sed 's/^Error: //' | head -4)
    [ -n "$summary" ] || summary=$(printf '%s\n' "$output" | grep -v '^[[:space:]]*$' | tail -4)
    if [ -n "$autoanswer" ]; then
      log "Logins: copy failed: $summary"
    else
      show_error "Copying logins from Chrome did not work.

$summary

You can sign in to sites in this browser by hand instead, or try again by opening $APP_NAME with the --import-logins option (see the README)."
    fi
    return 1
  fi
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
