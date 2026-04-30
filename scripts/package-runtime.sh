#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/chromium/src"
BUILD_DIR="${FINGERBROWSER_KERNEL_BUILD_DIR:-$SRC_DIR/out/FingerBrowserKernel}"
DIST_DIR="${FINGERBROWSER_KERNEL_DIST_DIR:-$ROOT_DIR/dist}"
BASE_REVISION="$(tr -d '[:space:]' < "$ROOT_DIR/CHROMIUM_BASE_REVISION")"
PATCHSET_VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/PATCHSET_VERSION")"
VERSION="0.1.1"
APP_SOURCE="$BUILD_DIR/Chromium.app"
APP_NAME="FingerBrowser Kernel.app"
APP_DISPLAY_NAME="FingerBrowser Kernel"
APP_BUNDLE_ID="com.fingerbrowser.kernel"
ICON_BASENAME="FingerBrowserKernel"
ICON_FILE="${ICON_BASENAME}.icns"
ICON_SOURCE="$ROOT_DIR/assets/macos/$ICON_FILE"
PACKAGE_ROOT="$DIST_DIR/runtime"
ZIP_NAME="fingerbrowser-kernel-v${VERSION}-mac-arm64.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"
MANIFEST_PATH="$DIST_DIR/fingerbrowser-kernel-v${VERSION}-mac-arm64.manifest.json"

set_plist_value() {
  local plist_path="$1"
  local key="$2"
  local type="$3"
  local value="$4"
  if /usr/libexec/PlistBuddy -c "Print :$key" "$plist_path" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Set :$key $value" "$plist_path"
  else
    /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$plist_path"
  fi
}

if [[ ! -d "$APP_SOURCE" ]]; then
  echo "Chromium.app missing. Run scripts/build-mac-arm64.sh first." >&2
  exit 1
fi

if [[ ! -f "$ICON_SOURCE" ]]; then
  echo "Kernel icon missing: $ICON_SOURCE" >&2
  exit 1
fi

if [[ "$BASE_REVISION" == "stable" || "$BASE_REVISION" == "main" || "$BASE_REVISION" == refs/heads/* || "$BASE_REVISION" == origin/* ]]; then
  echo "CHROMIUM_BASE_REVISION must be an exact git sha or immutable release tag, not '$BASE_REVISION'" >&2
  exit 1
fi

rm -rf "$PACKAGE_ROOT"
mkdir -p "$PACKAGE_ROOT" "$DIST_DIR"
ditto "$APP_SOURCE" "$PACKAGE_ROOT/$APP_NAME"

APP_PACKAGE="$PACKAGE_ROOT/$APP_NAME"
RESOURCES_DIR="$APP_PACKAGE/Contents/Resources"
PLIST_PATH="$APP_PACKAGE/Contents/Info.plist"
if [[ ! -f "$PLIST_PATH" ]]; then
  echo "Info.plist missing in $APP_PACKAGE" >&2
  exit 1
fi
mkdir -p "$RESOURCES_DIR"
find "$RESOURCES_DIR" -maxdepth 1 -name '*.icns' -delete
ditto "$ICON_SOURCE" "$RESOURCES_DIR/$ICON_FILE"
set_plist_value "$PLIST_PATH" "CFBundleName" "string" "$APP_DISPLAY_NAME"
set_plist_value "$PLIST_PATH" "CFBundleDisplayName" "string" "$APP_DISPLAY_NAME"
set_plist_value "$PLIST_PATH" "CFBundleIconFile" "string" "$ICON_BASENAME"
set_plist_value "$PLIST_PATH" "CFBundleIdentifier" "string" "$APP_BUNDLE_ID"

rm -f "$ZIP_PATH"
(cd "$PACKAGE_ROOT" && ditto -c -k --sequesterRsrc --keepParent "$APP_NAME" "$ZIP_PATH")

SHA256="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
cat > "$MANIFEST_PATH" <<JSON
{
  "version": "$VERSION",
  "baseChromiumRevision": "$BASE_REVISION",
  "patchsetVersion": "$PATCHSET_VERSION",
  "platform": "darwin",
  "arch": "arm64",
  "artifactUrl": "file://$ZIP_PATH",
  "sha256": "$SHA256",
  "executableRelativePath": "$APP_NAME/Contents/MacOS/Chromium",
  "policySchemaVersion": 1
}
JSON

shasum -a 256 "$ZIP_PATH" "$MANIFEST_PATH" > "$DIST_DIR/checksums.txt"
echo "Packaged $ZIP_PATH"
echo "Wrote $MANIFEST_PATH"
