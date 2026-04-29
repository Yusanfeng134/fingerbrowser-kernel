#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/chromium/src"
BUILD_DIR="$SRC_DIR/out/FingerBrowserKernel"
DIST_DIR="$ROOT_DIR/dist"
BASE_REVISION="$(tr -d '[:space:]' < "$ROOT_DIR/CHROMIUM_BASE_REVISION")"
PATCHSET_VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/PATCHSET_VERSION")"
VERSION="0.1.0"
APP_SOURCE="$BUILD_DIR/Chromium.app"
APP_NAME="FingerBrowser Kernel.app"
PACKAGE_ROOT="$DIST_DIR/runtime"
ZIP_NAME="fingerbrowser-kernel-v${VERSION}-mac-arm64.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"
MANIFEST_PATH="$DIST_DIR/fingerbrowser-kernel-v${VERSION}-mac-arm64.manifest.json"

if [[ ! -d "$APP_SOURCE" ]]; then
  echo "Chromium.app missing. Run scripts/build-mac-arm64.sh first." >&2
  exit 1
fi

if [[ "$BASE_REVISION" == "stable" || "$BASE_REVISION" == "main" || "$BASE_REVISION" == refs/heads/* || "$BASE_REVISION" == origin/* ]]; then
  echo "CHROMIUM_BASE_REVISION must be an exact git sha or immutable release tag, not '$BASE_REVISION'" >&2
  exit 1
fi

rm -rf "$PACKAGE_ROOT"
mkdir -p "$PACKAGE_ROOT" "$DIST_DIR"
ditto "$APP_SOURCE" "$PACKAGE_ROOT/$APP_NAME"
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
