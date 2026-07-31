#!/usr/bin/env bash
set -euo pipefail

# Builds a Nocturne.app DMG with the claude-thing relay in it.
#
# Works on a *copy* of a nocturne-connector checkout, so your own checkout is
# never modified. The copy lands in build/connector/ and is reused between runs
# only if you pass --keep.
#
# Usage:
#   scripts/build-connector-dmg.sh [--connector <path>] [--keep] [-- <dmg args>]
#
#   --connector <path>  an existing nocturne-connector checkout (default: clone
#                       https://github.com/usenocturne/nocturne-connector)
#   --keep              don't delete a previous build/connector copy first
#   everything after -- is passed to the connector's own
#   scripts/build-macos-dmg.sh (default: --local, an ad-hoc signed DMG; use
#   --skip-notarize or nothing at all if you have a Developer ID cert)
#
# Requires: macOS, Xcode, python3. The DMG lands in dist/.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONNECTOR_SRC=""
KEEP=0
DMG_ARGS=(--local)

while [ $# -gt 0 ]; do
  case "$1" in
    --connector) CONNECTOR_SRC="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --) shift; DMG_ARGS=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Built outside the repo on purpose. A repo under ~/Desktop or ~/Documents is
# typically an iCloud-synced folder, and the sync daemon stamps
# com.apple.fileprovider / com.apple.FinderInfo onto files as they are written.
# Those attributes land on the .app mid-build and codesign refuses it with
# "resource fork, Finder information, or similar detritus not allowed" — a
# failure that has nothing to do with the code. Override with
# CLAUDE_THING_BUILD_DIR if you want it somewhere specific.
BUILD_DIR="${CLAUDE_THING_BUILD_DIR:-${TMPDIR:-/tmp}claude-thing-connector}"
DIST_DIR="${REPO_ROOT}/dist"
RELAY_SRC="${REPO_ROOT}/patches/swift/ClaudeRelayService.swift"

fail() { echo "ERROR: $*" >&2; exit 1; }

command -v xcodebuild >/dev/null || fail "Xcode is required"
command -v python3 >/dev/null || fail "python3 is required"
[ -f "$RELAY_SRC" ] || fail "missing ${RELAY_SRC}"

if [ "$KEEP" -eq 0 ] || [ ! -d "$BUILD_DIR" ]; then
  rm -rf "$BUILD_DIR"
  mkdir -p "$(dirname "$BUILD_DIR")"
  if [ -n "$CONNECTOR_SRC" ]; then
    [ -d "$CONNECTOR_SRC" ] || fail "no connector checkout at ${CONNECTOR_SRC}"
    echo ">> copying ${CONNECTOR_SRC}"
    # -X drops extended attributes. Copying them in makes codesign fail the
    # build with "resource fork, Finder information, or similar detritus not
    # allowed", because they ride along into the built .app.
    cp -RX "$CONNECTOR_SRC" "$BUILD_DIR"
    rm -rf "${BUILD_DIR}/.git" "${BUILD_DIR}/build" "${BUILD_DIR}/output" "${BUILD_DIR}/cache"
  else
    echo ">> cloning usenocturne/nocturne-connector"
    git clone --depth 1 https://github.com/usenocturne/nocturne-connector.git "$BUILD_DIR"
  fi
  # Belt and braces: a clone can still pick up quarantine/provenance attributes
  # depending on how the machine is configured.
  xattr -cr "$BUILD_DIR" 2>/dev/null || true
fi

APP="${BUILD_DIR}/macos/Nocturne"
[ -d "$APP" ] || fail "${BUILD_DIR} doesn't look like nocturne-connector (no macos/Nocturne)"

echo ">> adding ClaudeRelayService.swift"
cp "$RELAY_SRC" "${APP}/Services/ClaudeRelayService.swift"

# Each edit is anchored on a distinctive line of upstream source. A missing
# anchor means the connector moved out from under us — stop rather than ship a
# half-patched app. Re-running is a no-op: every edit checks for its own result.
echo ">> patching call sites"
APP="$APP" python3 <<'PY'
import os, sys, pathlib

app = pathlib.Path(os.environ["APP"])
edits = 0

def patch(relpath, anchor, replacement, marker):
    global edits
    path = app / relpath
    text = path.read_text()
    if marker in text:
        print(f"   = {relpath} (already patched)")
        return
    if anchor not in text:
        sys.exit(f"ERROR: anchor not found in {relpath}:\n{anchor}")
    path.write_text(text.replace(anchor, replacement, 1))
    edits += 1
    print(f"   + {relpath}")

# 1. SessionStore — persisted toggle
patch(
    "Services/SessionStore.swift",
    '    private let systemMediaEnabledKey = "nocturne.systemMediaEnabled"',
    '    private let systemMediaEnabledKey = "nocturne.systemMediaEnabled"\n'
    '    private let claudeRelayEnabledKey = "nocturne.claudeRelayEnabled"',
    "claudeRelayEnabledKey",
)
patch(
    "Services/SessionStore.swift",
    "    private func readKeychain(account: String) -> Data? {",
    "    var claudeRelayEnabled: Bool {\n"
    "        get { UserDefaults.standard.bool(forKey: claudeRelayEnabledKey) }\n"
    "        set { UserDefaults.standard.set(newValue, forKey: claudeRelayEnabledKey) }\n"
    "    }\n\n"
    "    private func readKeychain(account: String) -> Data? {",
    "var claudeRelayEnabled",
)

# 2. RPCManager — hold the relay, forward events, route claude.* calls
patch(
    "Services/RPCManager.swift",
    "    private let ota = OTAService()",
    "    private let ota = OTAService()\n"
    "    let claudeRelay: ClaudeRelayService",
    "let claudeRelay: ClaudeRelayService",
)
patch(
    "Services/RPCManager.swift",
    "        currentUserID: @escaping () -> String? = { nil }\n"
    "    ) {",
    "        currentUserID: @escaping () -> String? = { nil },\n"
    "        claudeRelay: ClaudeRelayService\n"
    "    ) {",
    "claudeRelay: ClaudeRelayService\n    ) {",
)
patch(
    "Services/RPCManager.swift",
    "        self.currentUserID = currentUserID\n",
    "        self.currentUserID = currentUserID\n"
    "        self.claudeRelay = claudeRelay\n\n"
    "        // Daemon events arrive on the relay's socket and go straight out to\n"
    "        // every paired Car Thing, same path the spotify.* broadcasts take.\n"
    "        claudeRelay.onEvent = { [weak self] topic, data in\n"
    "            Task { @MainActor [weak self] in\n"
    "                await self?.broadcastToDevices(topic: topic, data: RPCValueBridge.pack(data))\n"
    "            }\n"
    "        }\n",
    "self.claudeRelay = claudeRelay",
)
patch(
    "Services/RPCManager.swift",
    '            if method.hasPrefix("spotify.") {\n'
    "                let result = try await spotify.dispatch(method, params: RPCValueBridge.dictionary(params))\n"
    "                return RPCValueBridge.pack(result)\n"
    "            }\n",
    '            if method.hasPrefix("spotify.") {\n'
    "                let result = try await spotify.dispatch(method, params: RPCValueBridge.dictionary(params))\n"
    "                return RPCValueBridge.pack(result)\n"
    "            }\n"
    '            if method.hasPrefix("claude.") {\n'
    "                let result = try await claudeRelay.call(method, params: RPCValueBridge.dictionary(params))\n"
    "                return RPCValueBridge.pack(result)\n"
    "            }\n",
    'method.hasPrefix("claude.")',
)

# 3. NocturneApp — construct, describe the link, start
patch(
    "NocturneApp.swift",
    "        let rpcManager = RPCManager(\n"
    "            spotify: spotify,\n"
    "            nowPlaying: nowPlaying,\n"
    "            analytics: analytics,\n"
    "            currentUserID: { auth.status.user?.id }\n"
    "        )",
    "        let claudeRelay = ClaudeRelayService()\n"
    "        let rpcManager = RPCManager(\n"
    "            spotify: spotify,\n"
    "            nowPlaying: nowPlaying,\n"
    "            analytics: analytics,\n"
    "            currentUserID: { auth.status.user?.id },\n"
    "            claudeRelay: claudeRelay\n"
    "        )",
    "let claudeRelay = ClaudeRelayService()",
)
patch(
    "NocturneApp.swift",
    "        rpcManager.onStaleConnection = { [weak bluetooth] address in\n"
    "            bluetooth?.teardownStaleLink(address: address)\n"
    "        }\n",
    "        rpcManager.onStaleConnection = { [weak bluetooth] address in\n"
    "            bluetooth?.teardownStaleLink(address: address)\n"
    "        }\n\n"
    "        // The daemon's control page renders this; weak on both sides because\n"
    "        // rpcManager owns the relay that owns this closure.\n"
    "        claudeRelay.statusProvider = { [weak bluetooth, weak rpcManager] in\n"
    "            guard let conn = bluetooth?.carThingConnections.first else {\n"
    '                return ["connected": false]\n'
    "            }\n"
    "            let info = rpcManager?.deviceInfo(for: conn.address)\n"
    "            return [\n"
    '                "connected": true,\n'
    '                "device": conn.name ?? "Car Thing",\n'
    '                "address": conn.address,\n'
    '                "serial": info?.serialNumber ?? "",\n'
    '                "firmware": info?.version ?? ""\n'
    "            ]\n"
    "        }\n"
    "        claudeRelay.start()\n",
    "claudeRelay.statusProvider",
)

# 4. SettingsView — the toggle
patch(
    "Views/Pages/SettingsView.swift",
    "    @EnvironmentObject var loginItem: LoginItemService\n",
    "    @EnvironmentObject var loginItem: LoginItemService\n"
    "    @EnvironmentObject var rpc: RPCManager\n",
    "@EnvironmentObject var rpc: RPCManager",
)
patch(
    "Views/Pages/SettingsView.swift",
    "    @State private var deleteError: String? = nil\n",
    "    @State private var deleteError: String? = nil\n"
    "    @State private var claudeRelayOn = SessionStore.shared.claudeRelayEnabled\n",
    "claudeRelayOn = SessionStore.shared",
)
patch(
    "Views/Pages/SettingsView.swift",
    '                section("Privacy") {',
    '                section("Claude Mode") {\n'
    "                    Card {\n"
    "                        HStack(alignment: .center) {\n"
    "                            VStack(alignment: .leading, spacing: 2) {\n"
    '                                Text("Claude Code relay")\n'
    "                                    .font(Theme.font(16, .medium))\n"
    "                                    .foregroundStyle(Theme.fg)\n"
    "                                Text(rpc.claudeRelay.connected\n"
    '                                     ? "Relaying — the claude-thing daemon on this Mac is connected."\n'
    '                                     : "Relay Claude Code sessions to the Car Thing. Needs the claude-thing daemon running on 127.0.0.1:8790.")\n'
    "                                    .font(Theme.font(14))\n"
    "                                    .foregroundStyle(Theme.secondary)\n"
    "                                    .fixedSize(horizontal: false, vertical: true)\n"
    "                            }\n"
    "                            Spacer()\n"
    '                            Toggle("", isOn: Binding(\n'
    "                                get: { claudeRelayOn },\n"
    "                                set: { on in\n"
    "                                    claudeRelayOn = on\n"
    "                                    SessionStore.shared.claudeRelayEnabled = on\n"
    "                                    if on { rpc.claudeRelay.start() } else { rpc.claudeRelay.stop() }\n"
    "                                }\n"
    "                            ))\n"
    "                            .toggleStyle(WebSwitchStyle())\n"
    "                            .labelsHidden()\n"
    "                        }\n"
    "                    }\n"
    "                }\n\n"
    '                section("Privacy") {',
    'section("Claude Mode")',
)

print(f">> {edits} edit(s) applied")
PY

echo ">> building DMG (${DMG_ARGS[*]})"
(cd "$BUILD_DIR" && scripts/build-macos-dmg.sh "${DMG_ARGS[@]}")

mkdir -p "$DIST_DIR"
DMG="$(ls -t "${BUILD_DIR}/output"/*.dmg 2>/dev/null | head -1)"
[ -n "$DMG" ] || fail "the connector's DMG script produced nothing in ${BUILD_DIR}/output"
cp "$DMG" "${DIST_DIR}/$(basename "$DMG")"

echo
echo "DMG: ${DIST_DIR}/$(basename "$DMG")"
