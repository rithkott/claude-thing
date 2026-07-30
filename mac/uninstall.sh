#!/usr/bin/env bash
# Removes everything mac/install.sh added: the LaunchAgent, the Claude Code
# hooks (a backup of settings.json is written first), and the emulator's Chrome
# profile. Leaves the checkout and node_modules alone.
set -uo pipefail
cd "$(dirname "$0")/.."

LABEL="com.claudething.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }

printf '\n\033[1mStopping the daemon\033[0m\n'
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  ok "LaunchAgent removed"
else
  ok "no LaunchAgent installed"
fi
if [ -f daemon/.daemon.pid ]; then
  kill "$(cat daemon/.daemon.pid)" 2>/dev/null || true
  rm -f daemon/.daemon.pid
  ok "running daemon stopped"
fi

printf '\n\033[1mClaude Code hooks\033[0m\n'
node daemon/scripts/uninstall-hooks.js | sed 's/^/  /'

printf '\n\033[1mEmulator leftovers\033[0m\n'
rm -rf "$HOME/.cache/carthing-emulator-chrome"
ok "Chrome profile removed"
rm -rf emulator/.cache
ok "extracted firmware cache removed"

printf '\nDone. Your Claude Code settings backup is listed above.\n'
