#!/bin/bash
# Remove the relay LaunchAgent installed by install-relay-agent.sh.
set -u
RESOURCES_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$RESOURCES_DIR/lib/common.sh"

launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
if [ -f "$LAUNCH_AGENT_PLIST" ]; then
  rm -f "$LAUNCH_AGENT_PLIST"
  msg="Relay login item removed ($LAUNCH_AGENT_PLIST). A relay that is still running keeps running until you quit it or log out."
else
  msg="No relay login item was installed."
fi
echo "$msg"
log "$msg"
[ -t 1 ] || notify "$msg"
