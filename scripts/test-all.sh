#!/usr/bin/env bash
# Whole-project test run: unit tests, then integration against a live daemon +
# emulator, then a build of every front end.
#
#   ./scripts/test-all.sh            # unit + build (fast, no servers)
#   ./scripts/test-all.sh --full     # also boots a daemon and runs the WS smoke test
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
FAILED=0
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '   \033[31m✗\033[0m %s\n' "$1"; FAILED=$((FAILED+1)); }

run() { # run <label> <cmd...>
  local label="$1"; shift
  if "$@" > /tmp/claude-thing-test.log 2>&1; then
    ok "$label"
  else
    bad "$label"
    tail -20 /tmp/claude-thing-test.log | sed 's/^/       /'
  fi
}

step "Dependencies"
for dir in daemon device-app webpage; do
  if [ ! -d "$dir/node_modules" ]; then
    run "install $dir" npm --prefix "$dir" install --no-audit --no-fund
  else
    ok "$dir deps present"
  fi
done

step "Unit tests — daemon"
if (cd daemon && CLAUDE_THING_HOLD_MS=200 node --test "test/*.test.js" > /tmp/claude-thing-daemon-test.log 2>&1); then
  ok "$(grep -E '^# pass' /tmp/claude-thing-daemon-test.log | head -1 | tr -d '#') assertions"
else
  bad "daemon tests"
  grep -E "^not ok|AssertionError|expected|actual" /tmp/claude-thing-daemon-test.log | head -20 | sed 's/^/       /'
fi

step "Unit tests — device app screens"
if (cd device-app && node --test "test/*.test.js" > /tmp/claude-thing-device-test.log 2>&1); then
  ok "$(grep -E '^# pass' /tmp/claude-thing-device-test.log | head -1 | tr -d '#') assertions"
else
  bad "device-app tests"
  grep -E "^not ok|AssertionError|expected|actual" /tmp/claude-thing-device-test.log | head -20 | sed 's/^/       /'
fi

step "Builds"
run "device app builds for Chrome 69" npm --prefix device-app run build
run "sprites regenerate" npm --prefix device-app run sprites
run "webpage builds" npm --prefix webpage run build

step "Firmware tooling"
if node emulator/src/firmware.js --check > /tmp/claude-thing-fw.log 2>&1; then
  ok "firmware extraction ($(grep -oE 'v[0-9.]+[^ ]*' /tmp/claude-thing-fw.log | head -1))"
else
  bad "firmware extraction"
  tail -5 /tmp/claude-thing-fw.log | sed 's/^/       /'
fi

if [ "$FULL" = "1" ]; then
  step "Integration — live daemon"
  (cd daemon && CLAUDE_THING_MOCK=1 CLAUDE_THING_HOLD_MS=4000 node src/index.js > /tmp/claude-thing-daemon.log 2>&1 &)
  for _ in $(seq 1 40); do
    curl -sf http://127.0.0.1:8790/status > /dev/null && break
    sleep 0.25
  done
  if curl -sf http://127.0.0.1:8790/status > /dev/null; then
    ok "daemon answers /status"
    run "WS hub semantics + permission round trip" node daemon/scripts/smoke-hub.js
  else
    bad "daemon did not start"
    tail -10 /tmp/claude-thing-daemon.log | sed 's/^/       /'
  fi
  if [ -f daemon/.daemon.pid ]; then
    kill "$(cat daemon/.daemon.pid)" 2>/dev/null || true
    rm -f daemon/.daemon.pid
  fi
fi

printf '\n'
if [ "$FAILED" = "0" ]; then
  printf '\033[32mall checks passed\033[0m\n'
else
  printf '\033[31m%s check(s) failed\033[0m\n' "$FAILED"
fi
exit "$FAILED"
