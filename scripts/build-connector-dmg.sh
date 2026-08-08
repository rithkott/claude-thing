#!/usr/bin/env bash
set -euo pipefail

# Builds the Nocturne.app DMG with the claude-thing relay in it.
#
# The app source is vendored at mac/Nocturne/ — see mac/Nocturne/README.md for
# where it came from and why it is not fetched. Nothing is cloned or patched at
# build time any more; the relay and its call sites are ordinary tracked source.
#
# Usage:
#   scripts/build-connector-dmg.sh                  # Developer ID DMG + notarization
#   scripts/build-connector-dmg.sh --skip-notarize  # Developer ID DMG, no notary submit
#   scripts/build-connector-dmg.sh --local          # ad-hoc signed DMG, no notary submit
#
# Env overrides:
#   SCHEME                   Xcode scheme (default: Nocturne)
#   TEAM_ID                  Apple Developer team ID (default: A8CCNQDH4A)
#   NOTARY_PROFILE           notarytool keychain profile (default: nocturne-notary)
#   CLAUDE_THING_BUILD_DIR   where to build (default: a temp dir — see below)
#
# Requires: macOS, Xcode, python3. The DMG lands in dist/.
#
# Derived from nocturne-connector's scripts/build-macos-dmg.sh (Apache-2.0),
# adapted to the vendored tree's layout and output naming.

SKIP_NOTARIZE=0
LOCAL_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --local) LOCAL_BUILD=1; SKIP_NOTARIZE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_SRC="${REPO_ROOT}/mac/Nocturne"

PROJECT="${APP_SRC}/Nocturne.xcodeproj"
SCHEME="${SCHEME:-Nocturne}"
APP_NAME="Nocturne"
TEAM_ID="${TEAM_ID:-A8CCNQDH4A}"
EXPORT_OPTIONS="${APP_SRC}/ExportOptions.plist"
DMG_ASSETS_DIR="${APP_SRC}/dmg-assets"
DMG_BACKGROUND="${DMG_ASSETS_DIR}/background.png"
DMG_SETTINGS="${DMG_ASSETS_DIR}/dmg-settings.py"
NOTARY_PROFILE="${NOTARY_PROFILE:-nocturne-notary}"

# Built outside the repo on purpose. A repo under ~/Desktop or ~/Documents is
# typically an iCloud-synced folder, and the sync daemon stamps
# com.apple.fileprovider / com.apple.FinderInfo onto files as they are written.
# Those attributes land on the .app mid-build and codesign refuses it with
# "resource fork, Finder information, or similar detritus not allowed" — a
# failure that has nothing to do with the code.
BUILD_DIR="${CLAUDE_THING_BUILD_DIR:-${TMPDIR:-/tmp/}claude-thing-connector}"
DIST_DIR="${REPO_ROOT}/dist"
ARCHIVE_PATH="${BUILD_DIR}/${APP_NAME}.xcarchive"
EXPORT_PATH="${BUILD_DIR}/export"
APP_PATH="${EXPORT_PATH}/${APP_NAME}.app"
DERIVED_DATA="${BUILD_DIR}/DerivedData"
DMG_VENV="${BUILD_DIR}/dmgvenv"

color() { printf "\033[0;36m%s\033[0m\n" "$1"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

require_tool() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

has_developer_id() {
  security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"
}

check_notary_profile() {
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1
}

prepare_dmgbuild() {
  if [ ! -x "${DMG_VENV}/bin/dmgbuild" ]; then
    color "   (setting up dmgbuild venv)"
    python3 -m venv "$DMG_VENV"
    "${DMG_VENV}/bin/pip" install --quiet --upgrade pip dmgbuild
  fi
}

build_developer_id_app() {
  color ">> Archiving '${SCHEME}' (Release, Developer ID)"
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=macOS' \
    -archivePath "$ARCHIVE_PATH" \
    -derivedDataPath "$DERIVED_DATA" \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="Developer ID Application" \
    CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
    ENABLE_HARDENED_RUNTIME=YES \
    archive

  color ">> Exporting Developer ID app"
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_PATH" \
    -exportOptionsPlist "$EXPORT_OPTIONS"
}

build_local_app() {
  color ">> Building '${SCHEME}' (Release, local ad-hoc signing)"
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" \
    -configuration Release \
    -destination 'platform=macOS' \
    -derivedDataPath "$DERIVED_DATA" \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="-" \
    CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
    DEVELOPMENT_TEAM="" \
    ENABLE_HARDENED_RUNTIME=YES \
    build

  local built_app="${DERIVED_DATA}/Build/Products/Release/${APP_NAME}.app"
  [ -d "$built_app" ] || fail "build produced no ${APP_NAME}.app at ${built_app}"
  mkdir -p "$EXPORT_PATH"
  ditto "$built_app" "$APP_PATH"
}

# The connector names its own build Nocturne-<ver>.dmg, which on a release page
# is indistinguishable from stock Nocturne. This one carries the Claude relay,
# so it says so: Nocturne-claude-<app version>.dmg.
build_dmg() {
  [ -d "$APP_PATH" ] || fail "no ${APP_NAME}.app found at ${APP_PATH}"

  local version
  version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "${APP_PATH}/Contents/Info.plist")"
  local suffix=""
  [ "$LOCAL_BUILD" -eq 1 ] && suffix="-local"
  DMG_PATH="${DIST_DIR}/${APP_NAME}-claude-${version}${suffix}.dmg"
  rm -f "$DMG_PATH"

  color ">> Building DMG: $(basename "$DMG_PATH")"
  prepare_dmgbuild

  local bg_define=()
  if [ -f "$DMG_BACKGROUND" ]; then
    local bg_width
    bg_width="$(sips -g pixelWidth "$DMG_BACKGROUND" 2>/dev/null | awk '/pixelWidth/{print $2}')"
    if [ "${bg_width:-0}" -ge 1000 ]; then
      sips -z 400 660 "$DMG_BACKGROUND" --out "${BUILD_DIR}/dmg-bg-1x.png" >/dev/null 2>&1
      tiffutil -cathidpicheck "${BUILD_DIR}/dmg-bg-1x.png" "$DMG_BACKGROUND" \
        -out "${BUILD_DIR}/dmg-bg.tiff" >/dev/null 2>&1
      bg_define=(-D "bg=${BUILD_DIR}/dmg-bg.tiff")
    else
      bg_define=(-D "bg=${DMG_BACKGROUND}")
    fi
  else
    echo "  (no background.png in mac/Nocturne/dmg-assets/; building a plain window)" >&2
  fi

  "${DMG_VENV}/bin/dmgbuild" -s "$DMG_SETTINGS" \
    -D "app=${APP_PATH}" "${bg_define[@]}" \
    "$APP_NAME" "$DMG_PATH"
}

require_tool python3
require_tool xcodebuild
require_tool xcrun
require_tool security
[ -d "$PROJECT" ] || fail "no Xcode project at ${PROJECT} — is mac/Nocturne/ checked out?"
[ -f "$DMG_SETTINGS" ] || fail "missing DMG settings at ${DMG_SETTINGS}"
[ -f "${APP_SRC}/Nocturne/Services/ClaudeRelayService.swift" ] \
  || fail "the vendored tree has no ClaudeRelayService.swift — this would build stock Nocturne"

if [ "$LOCAL_BUILD" -eq 0 ]; then
  has_developer_id \
    || fail "no 'Developer ID Application' certificate found. Install one, or use --local for a non-notarizable test DMG."
  if [ "$SKIP_NOTARIZE" -eq 0 ] && ! check_notary_profile; then
    fail "no notarytool keychain profile '${NOTARY_PROFILE}'. Run: xcrun notarytool store-credentials ${NOTARY_PROFILE}"
  fi
fi

# The source now lives in the repo, so iCloud may have stamped xattrs onto it
# since the last build; they ride resource copies into the .app and fail
# codesign. Clearing them touches nothing git tracks.
xattr -cr "$APP_SRC" 2>/dev/null || true

mkdir -p "$BUILD_DIR" "$DIST_DIR"
rm -rf "$ARCHIVE_PATH" "$EXPORT_PATH" "$DERIVED_DATA"

if [ "$LOCAL_BUILD" -eq 1 ]; then
  build_local_app
else
  build_developer_id_app
fi

build_dmg

if [ "$SKIP_NOTARIZE" -eq 1 ]; then
  color ">> Skipping notarization"
  if [ "$LOCAL_BUILD" -eq 1 ]; then
    echo "Local DMG ready (NOT Developer ID signed, NOT notarized): $DMG_PATH"
  else
    echo "Developer ID DMG ready (NOT notarized): $DMG_PATH"
  fi
  exit 0
fi

color ">> Notarizing (profile: ${NOTARY_PROFILE})"
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait

color ">> Stapling ticket"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

color ">> Finished"
echo "Notarized DMG: $DMG_PATH"
