#!/bin/bash
# Install a LaunchAgent that keeps the Playwriter relay running at login, so
# the toolbar's Record Skill works even when the app has not been opened in
# this session. Run it directly, or:
#   open -a "Playwriter Recorder" --args --install-login-item
set -u
RESOURCES_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$RESOURCES_DIR/lib/common.sh"

resolve_cli

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# launchd gives the agent a bare environment; only development mode needs
# more than the system PATH (node + the repo's tsx shim).
AGENT_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
if [ "$PW_MODE" = dev ]; then
  AGENT_PATH="$(dirname "$(command -v node)"):$PW_REPO/node_modules/.bin:$AGENT_PATH"
fi

mkdir -p "$HOME/Library/LaunchAgents"

{
  printf '<?xml version="1.0" encoding="UTF-8"?>\n'
  printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  printf '<plist version="1.0">\n<dict>\n'
  printf '  <key>Label</key><string>%s</string>\n' "$LAUNCH_AGENT_LABEL"
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  for arg in "${PW_CLI[@]}" serve --host 127.0.0.1 --replace; do
    printf '    <string>%s</string>\n' "$(xml_escape "$arg")"
  done
  printf '  </array>\n'
  printf '  <key>EnvironmentVariables</key>\n  <dict>\n'
  printf '    <key>PATH</key><string>%s</string>\n' "$(xml_escape "$AGENT_PATH")"
  printf '    <key>PLAYWRITER_EXTENSION_PATH</key><string>%s</string>\n' "$(xml_escape "$EXTENSION_DIR")"
  printf '  </dict>\n'
  printf '  <key>RunAtLoad</key><true/>\n'
  printf '  <key>KeepAlive</key><true/>\n'
  printf '  <key>ThrottleInterval</key><integer>10</integer>\n'
  printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$STATE_DIR/relay-agent.log")"
  printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$STATE_DIR/relay-agent.log")"
  printf '</dict>\n</plist>\n'
} > "$LAUNCH_AGENT_PLIST"

launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true

# Hand the port to the agent: stop any relay the launcher started and wait for
# the port to be released, so the agent's first start binds cleanly. (`serve
# --replace` also kills a port holder, but can lose the race to re-bind; with
# KeepAlive launchd retries 10s later, so the agent still converges.)
existing=$(lsof -ti ":$RELAY_PORT" 2>/dev/null || true)
if [ -n "$existing" ]; then
  log "Stopping existing relay (pid $existing) before starting the agent"
  echo "$existing" | xargs kill 2>/dev/null || true
  for _ in $(seq 1 20); do
    lsof -ti ":$RELAY_PORT" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

if launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PLIST"; then
  msg="Relay login item installed: $LAUNCH_AGENT_PLIST. The Playwriter relay now starts at login and restarts if it stops."
  echo "$msg"
  log "$msg"
  [ -t 1 ] || notify "Relay login item installed."
else
  die "Could not load the LaunchAgent $LAUNCH_AGENT_PLIST (launchctl bootstrap failed)."
fi
