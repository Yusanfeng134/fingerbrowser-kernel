#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/chromium/src"
BUILD_DIR="${FINGERBROWSER_KERNEL_BUILD_DIR:-$SRC_DIR/out/FingerBrowserKernelLinuxX64}"
DIST_DIR="${FINGERBROWSER_KERNEL_DIST_DIR:-$ROOT_DIR/dist}"
BASE_REVISION="$(tr -d '[:space:]' < "$ROOT_DIR/CHROMIUM_BASE_REVISION")"
PATCHSET_VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/PATCHSET_VERSION")"
VERSION="0.1.1"
RUNTIME_NAME="fingerbrowser-kernel"
PACKAGE_ROOT="$DIST_DIR/runtime-linux-x64"
TARBALL_NAME="fingerbrowser-kernel-v${VERSION}-linux-x64.tar.gz"
TARBALL_PATH="$DIST_DIR/$TARBALL_NAME"
MANIFEST_PATH="$DIST_DIR/fingerbrowser-kernel-v${VERSION}-linux-x64.manifest.json"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    sha256sum "$@"
  fi
}

if [[ ! -x "$BUILD_DIR/chrome" ]]; then
  echo "Linux Chromium binary missing. Run scripts/build-linux-x64.sh first." >&2
  exit 1
fi

if [[ "$BASE_REVISION" == "stable" || "$BASE_REVISION" == "main" || "$BASE_REVISION" == refs/heads/* || "$BASE_REVISION" == origin/* ]]; then
  echo "CHROMIUM_BASE_REVISION must be an exact git sha or immutable release tag, not '$BASE_REVISION'" >&2
  exit 1
fi

rm -rf "$PACKAGE_ROOT"
mkdir -p "$PACKAGE_ROOT/$RUNTIME_NAME" "$DIST_DIR"

copy_runtime() {
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$BUILD_DIR/" "$PACKAGE_ROOT/$RUNTIME_NAME/"
  else
    (cd "$BUILD_DIR" && tar -cf - .) | (cd "$PACKAGE_ROOT/$RUNTIME_NAME" && tar -xf -)
  fi
}

copy_runtime
chmod +x "$PACKAGE_ROOT/$RUNTIME_NAME/chrome"

rm -f "$TARBALL_PATH"
(cd "$PACKAGE_ROOT" && tar -czf "$TARBALL_PATH" "$RUNTIME_NAME")

SHA256="$(sha256_file "$TARBALL_PATH" | awk '{print $1}')"
cat > "$MANIFEST_PATH" <<JSON
{
  "version": "$VERSION",
  "baseChromiumRevision": "$BASE_REVISION",
  "patchsetVersion": "$PATCHSET_VERSION",
  "platform": "linux",
  "arch": "x64",
  "artifactUrl": "file://$TARBALL_PATH",
  "sha256": "$SHA256",
  "executableRelativePath": "$RUNTIME_NAME/chrome",
  "policySchemaVersion": 1
}
JSON

sha256_file "$TARBALL_PATH" "$MANIFEST_PATH" > "$DIST_DIR/checksums-linux-x64.txt"
echo "Packaged $TARBALL_PATH"
echo "Wrote $MANIFEST_PATH"
