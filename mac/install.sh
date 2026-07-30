#!/usr/bin/env bash
# Installs the Mac side of claude-thing:
#   • node dependencies for the daemon and the control page
#   • the control page build
#   • Claude Code hooks (a backup of settings.json is written)
#   • a LaunchAgent so the daemon starts at login and restarts if it dies
#
#   ./mac/install.sh              # install everything
#   ./mac/install.sh --no-agent   # skip the LaunchAgent (run the daemon manually)
#
# Everything here is reversible with ./mac/uninstall.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

LABEL="com.claudething.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WANT_AGENT=1
[ "${1:-}" = "--no-agent" ] && WANT_AGENT=0

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

say "Checking prerequisites"
command -v node >/dev/null || die "node not found — install Node 18 or newer"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR is too old — need 18 or newer"
ok "node $(node -v)"

command -v claude >/dev/null || die "the 'claude' CLI is not on PATH — install Claude Code first"
ok "claude $(claude --version 2>/dev/null | head -1)"

if command -v /opt/homebrew/opt/e2fsprogs/sbin/debugfs >/dev/null 2>&1 \
   || command -v debugfs >/dev/null 2>&1; then
  ok "e2fsprogs present (needed to read firmware images)"
else
  warn "e2fsprogs not found — 'brew install e2fsprogs' if you want the emulator or firmware injection"
fi

say "Installing dependencies"
npm --prefix daemon install --no-audit --no-fund >/dev/null
ok "daemon"
npm --prefix webpage install --no-audit --no-fund >/dev/null
ok "control page"
npm --prefix device-app install --no-audit --no-fund >/dev/null
ok "device app"

say "Building"
npm --prefix webpage run build >/dev/null
ok "control page → webpage/dist"
npm --prefix device-app run build >/dev/null
ok "device app → device-app/dist"

say "Claude Code hooks"
node daemon/scripts/install-hooks.js | sed 's/^/  /'

if [ "$WANT_AGENT" = "1" ]; then
  say "LaunchAgent"
  mkdir -p "$HOME/Library/LaunchAgents" daemon/logs
  # A LaunchAgent inherits almost no PATH, so bake in the directories that hold
  # node and claude on this machine.
  AGENT_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v claude)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  sed -e "s|__NODE__|$(command -v node)|g" \
      -e "s|__ROOT__|$ROOT|g" \
      -e "s|__PATH__|$AGENT_PATH|g" \
      mac/com.claudething.daemon.plist.template > "$PLIST"
  ok "wrote $PLIST"

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  ok "loaded — the daemon now starts at login"

  for _ in $(seq 1 40); do
    curl -sf http://127.0.0.1:8790/status >/dev/null && break
    sleep 0.25
  done
  if curl -sf http://127.0.0.1:8790/status >/dev/null; then
    ok "daemon answering on http://127.0.0.1:8790"
  else
    warn "daemon did not answer yet — check daemon/logs/launchd.err.log"
  fi
else
  say "LaunchAgent skipped"
  echo "  start the daemon yourself with: npm --prefix daemon start"
fi

say "Done"
cat <<EOF
  Control page:  http://127.0.0.1:8790
  Emulator:      say "deploy to dev" to Claude Code, or
                 node emulator/scripts/deploy-dev.js

  For the hardware path, see README.md → "Flashing the firmware".
EOF
