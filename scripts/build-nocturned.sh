#!/usr/bin/env bash
set -euo pipefail

# Builds a nocturned that forwards claude.* to the Mac, without a full Buildroot
# firmware run. Works on a copy of a nocturned checkout, so yours is untouched.
#
# Usage:
#   scripts/build-nocturned.sh [--src <path>] [--keep]
#
#   --src <path>  an existing nocturned checkout (default: clone
#                 https://github.com/usenocturne/nocturned)
#   --keep        reuse a previous build/nocturned copy and its cargo cache
#
# Output: dist/nocturned, plus a pre-flight report. Feed it to
# `node scripts/inject-firmware.js --nocturned dist/nocturned`.
#
# Requires: Docker.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC=""
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

BUILD_DIR="${REPO_ROOT}/build/nocturned"
DIST_DIR="${REPO_ROOT}/dist"
TARGET=armv7-unknown-linux-gnueabihf
IMAGE=claude-thing/nocturned-builder

fail() { echo "ERROR: $*" >&2; exit 1; }

# Docker Desktop doesn't always put its CLI on PATH.
DOCKER="$(command -v docker || true)"
if [ -z "$DOCKER" ] || ! "$DOCKER" version >/dev/null 2>&1; then
  for c in /Applications/Docker.app/Contents/Resources/bin/docker \
           "$HOME/.docker/bin/docker" /opt/homebrew/bin/docker; do
    if [ -x "$c" ] && "$c" version >/dev/null 2>&1; then DOCKER="$c"; break; fi
  done
fi
[ -n "$DOCKER" ] && "$DOCKER" version >/dev/null 2>&1 || fail "Docker isn't running"

if [ "$KEEP" -eq 0 ] || [ ! -d "$BUILD_DIR" ]; then
  rm -rf "$BUILD_DIR"
  mkdir -p "$(dirname "$BUILD_DIR")"
  if [ -n "$SRC" ]; then
    [ -d "$SRC" ] || fail "no nocturned checkout at ${SRC}"
    echo ">> copying ${SRC}"
    cp -R "$SRC" "$BUILD_DIR"
    rm -rf "${BUILD_DIR}/.git" "${BUILD_DIR}/target"
  else
    echo ">> cloning usenocturne/nocturned"
    git clone --depth 1 https://github.com/usenocturne/nocturned.git "$BUILD_DIR"
  fi
fi

HANDLER="${BUILD_DIR}/src/app/websocket_handler.rs"
[ -f "$HANDLER" ] || fail "${BUILD_DIR} doesn't look like nocturned (no ${HANDLER#$BUILD_DIR/})"

echo ">> adding the claude.* forwarding arm"
HANDLER="$HANDLER" python3 <<'PY'
import os, sys, pathlib

path = pathlib.Path(os.environ["HANDLER"])
text = path.read_text()

if 'starts_with("claude.")' in text:
    print("   = already patched")
    raise SystemExit

anchor = '                _ => {\n                    warn!("Unknown WebSocket method: {}", method);'
if anchor not in text:
    sys.exit("ERROR: couldn't find the default match arm in websocket_handler.rs")

# Same body the spotify.* allow-list arm uses to hand a request to the phone;
# the only difference is matching on a prefix instead of exact method names.
arm = '''                m if m.starts_with("claude.") => {
                    let claude_request = serde_json::json!({
                        "method": method,
                        "params": data.get("params").unwrap_or(&serde_json::Value::Null)
                    });

                    info!("Routing WebSocket Claude request to connector: {}", method);

                    return Ok(Some(AppMessage {
                        id: message.id,
                        protocol: "com.usenocturne.daemon".to_string(),
                        session_id: message.session_id,
                        data: Bytes::from(serde_json::to_vec(&claude_request)?),
                    }));
                }
'''
path.write_text(text.replace(anchor, arm + anchor, 1))
print("   + claude.* arm inserted before the default arm")
PY

# Upstream registers its RFCOMM profiles once and never notices when BlueZ drops
# them, which strands the Mac connector on "could not open RFCOMM channel 2"
# until the device reboots. See patches/nocturned-spp-reregister.patch.
echo ">> adding the RFCOMM profile re-registration"
BLUETOOTH="${BUILD_DIR}/src/bluetooth.rs"
[ -f "$BLUETOOTH" ] || fail "${BUILD_DIR} doesn't look like nocturned (no ${BLUETOOTH#$BUILD_DIR/})"
if grep -q PROFILE_REREGISTER_MAX_BACKOFF "$BLUETOOTH"; then
  echo "   = already patched"
else
  # -p1 strips the a/ b/ prefixes; run from BUILD_DIR so the patch cannot reach
  # outside the nocturned copy even though build/ sits inside this repo.
  (cd "$BUILD_DIR" && git apply -p1 "${REPO_ROOT}/patches/nocturned-spp-reregister.patch") \
    || fail "patches/nocturned-spp-reregister.patch no longer applies to this nocturned — upstream moved, rebase it"
  echo "   + profile supervisor loops applied"
fi

echo ">> building the cross-compile image"
"$DOCKER" build -q -f "${REPO_ROOT}/scripts/nocturned.Dockerfile" -t "$IMAGE" "${REPO_ROOT}/scripts" >/dev/null

echo ">> cargo build --release --target ${TARGET}"
"$DOCKER" run --rm \
  -v "${BUILD_DIR}:/src" \
  -v "claude-thing-cargo-registry:/usr/local/cargo/registry" \
  "$IMAGE"

BIN="${BUILD_DIR}/target/${TARGET}/release/nocturned"
[ -f "$BIN" ] || fail "the build produced no binary at ${BIN}"

mkdir -p "$DIST_DIR"
cp "$BIN" "${DIST_DIR}/nocturned"

# Stock nocturned ships stripped; cargo doesn't strip by default, and debug
# symbols are ~8 MB of rootfs the device has no use for.
echo ">> stripping"
"$DOCKER" run --rm -v "${DIST_DIR}:/out" "$IMAGE" \
  arm-linux-gnueabihf-strip /out/nocturned

# Pre-flight: everything that has to line up with the device, checked here so a
# mismatch surfaces now instead of after a flash.
echo
echo ">> pre-flight"
"$DOCKER" run --rm -v "${DIST_DIR}:/out" "$IMAGE" bash -c '
  set -e
  file /out/nocturned
  echo "--- needed libraries (device has all of these) ---"
  arm-linux-gnueabihf-readelf -d /out/nocturned | grep NEEDED
  echo "--- highest glibc symbol required (device has 2.42) ---"
  arm-linux-gnueabihf-readelf -V /out/nocturned \
    | grep -oE "GLIBC_[0-9]+\.[0-9]+" | sort -uV | tail -1
  echo "--- runs under qemu-arm? ---"
  # Sysroot is / so the loader picks up the multiarch armhf runtime libraries.
  # Pointing it at /usr/arm-linux-gnueabihf instead mixes those with the cross
  # toolchain stubs and segfaults before main, which says nothing about the
  # binary. There is no bluetoothd or system bus in here, so it gets a few log
  # lines in and stops; that is enough to prove the ELF loaded, the dynamic
  # links resolved, and armv7 instructions actually executed.
  timeout 10 qemu-arm-static -L / /out/nocturned 2>&1 | head -4 || true
'

echo
echo "binary: ${DIST_DIR}/nocturned"
echo "inject: node scripts/inject-firmware.js --nocturned ${DIST_DIR}/nocturned"
