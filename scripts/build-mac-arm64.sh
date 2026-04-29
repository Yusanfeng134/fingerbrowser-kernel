#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/chromium/src"
BUILD_DIR="out/FingerBrowserKernel"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This build script is pinned to a dedicated macOS arm64 builder" >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Chromium source missing. Run scripts/apply-patches.sh first." >&2
  exit 1
fi

if ! command -v gn >/dev/null 2>&1 || ! command -v autoninja >/dev/null 2>&1; then
  echo "depot_tools must provide gn and autoninja on PATH" >&2
  exit 1
fi

cd "$SRC_DIR"
gn gen "$BUILD_DIR" --args='target_os="mac" target_cpu="arm64" is_debug=false is_component_build=false symbol_level=0 enable_nacl=false proprietary_codecs=false'
autoninja -C "$BUILD_DIR" chrome

echo "Built Chromium runtime at $SRC_DIR/$BUILD_DIR/Chromium.app"

