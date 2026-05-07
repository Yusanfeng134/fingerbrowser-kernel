#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BUILD_DIR="$TMP_DIR/build"
DIST_DIR="$TMP_DIR/dist"
CHROME_PATH="$BUILD_DIR/chrome"

mkdir -p "$BUILD_DIR/locales"
printf '#!/usr/bin/env bash\nexit 0\n' > "$CHROME_PATH"
chmod +x "$CHROME_PATH"
printf 'linux resources' > "$BUILD_DIR/locales/en-US.pak"

FINGERBROWSER_KERNEL_BUILD_DIR="$BUILD_DIR" \
FINGERBROWSER_KERNEL_DIST_DIR="$DIST_DIR" \
  "$ROOT_DIR/scripts/package-runtime-linux-x64.sh"

MANIFEST_PATH="$DIST_DIR/fingerbrowser-kernel-v0.1.1-linux-x64.manifest.json"
"$ROOT_DIR/scripts/verify-runtime-manifest.sh" "$MANIFEST_PATH"

UNPACK_DIR="$TMP_DIR/unpack"
mkdir -p "$UNPACK_DIR"
tar -xzf "$DIST_DIR/fingerbrowser-kernel-v0.1.1-linux-x64.tar.gz" -C "$UNPACK_DIR"

test -x "$UNPACK_DIR/fingerbrowser-kernel/chrome"
test -f "$UNPACK_DIR/fingerbrowser-kernel/locales/en-US.pak"

if grep -Eiq 'password|token|secret|cookie|cache' "$MANIFEST_PATH"; then
  echo "Linux manifest contains forbidden sensitive text" >&2
  exit 1
fi

echo "Linux runtime packaging test passed"
