#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BUILD_DIR="$TMP_DIR/build"
DIST_DIR="$TMP_DIR/dist"
APP_SOURCE="$BUILD_DIR/Chromium.app"

mkdir -p "$APP_SOURCE/Contents/MacOS" "$APP_SOURCE/Contents/Resources"
printf '#!/usr/bin/env bash\nexit 0\n' > "$APP_SOURCE/Contents/MacOS/Chromium"
chmod +x "$APP_SOURCE/Contents/MacOS/Chromium"
printf 'old icon placeholder' > "$APP_SOURCE/Contents/Resources/app.icns"
cat > "$APP_SOURCE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Chromium</string>
  <key>CFBundleDisplayName</key>
  <string>Chromium</string>
  <key>CFBundleIconFile</key>
  <string>app</string>
  <key>CFBundleIdentifier</key>
  <string>org.chromium.Chromium</string>
</dict>
</plist>
PLIST

FINGERBROWSER_KERNEL_BUILD_DIR="$BUILD_DIR" \
FINGERBROWSER_KERNEL_DIST_DIR="$DIST_DIR" \
  "$ROOT_DIR/scripts/package-runtime.sh"

MANIFEST_PATH="$DIST_DIR/fingerbrowser-kernel-v0.1.0-mac-arm64.manifest.json"
"$ROOT_DIR/scripts/verify-runtime-manifest.sh" "$MANIFEST_PATH"

UNPACK_DIR="$TMP_DIR/unpack"
mkdir -p "$UNPACK_DIR"
ditto -x -k "$DIST_DIR/fingerbrowser-kernel-v0.1.0-mac-arm64.zip" "$UNPACK_DIR"

APP_ROOT="$UNPACK_DIR/FingerBrowser Kernel.app"
PLIST_PATH="$APP_ROOT/Contents/Info.plist"
test -f "$APP_ROOT/Contents/Resources/FingerBrowserKernel.icns"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$PLIST_PATH")" = "FingerBrowserKernel"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST_PATH")" = "FingerBrowser Kernel"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$PLIST_PATH")" = "FingerBrowser Kernel"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST_PATH")" = "com.fingerbrowser.kernel"

echo "Kernel icon packaging test passed"
