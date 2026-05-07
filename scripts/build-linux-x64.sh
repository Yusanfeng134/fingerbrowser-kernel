#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/chromium/src"
BUILD_DIR="out/FingerBrowserKernelLinuxX64"

gn_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

google_api_key="${FINGERBROWSER_GOOGLE_API_KEY:-${GOOGLE_API_KEY:-}}"
google_client_id="${FINGERBROWSER_GOOGLE_DEFAULT_CLIENT_ID:-${GOOGLE_DEFAULT_CLIENT_ID:-}}"
google_client_secret="${FINGERBROWSER_GOOGLE_DEFAULT_CLIENT_SECRET:-${GOOGLE_DEFAULT_CLIENT_SECRET:-}}"
google_value_count=0
[[ -n "$google_api_key" ]] && google_value_count=$((google_value_count + 1))
[[ -n "$google_client_id" ]] && google_value_count=$((google_value_count + 1))
[[ -n "$google_client_secret" ]] && google_value_count=$((google_value_count + 1))

if [[ "$google_value_count" -ne 0 && "$google_value_count" -ne 3 ]]; then
  echo "Google API credentials must be provided together: API key, OAuth client ID, and OAuth client secret" >&2
  exit 1
fi

GN_ARGS='target_os="linux" target_cpu="x64" is_debug=false is_component_build=false symbol_level=0 enable_nacl=false proprietary_codecs=false'
if [[ "$google_value_count" -eq 3 ]]; then
  GN_ARGS+=" google_api_key=\"$(gn_escape "$google_api_key")\""
  GN_ARGS+=" google_default_client_id=\"$(gn_escape "$google_client_id")\""
  GN_ARGS+=" google_default_client_secret=\"$(gn_escape "$google_client_secret")\""
fi

if [[ "${FINGERBROWSER_KERNEL_PRINT_GN_ARGS:-0}" == "1" ]]; then
  printf '%s\n' "$GN_ARGS"
  exit 0
fi

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This build script is pinned to a dedicated Linux x86_64 builder" >&2
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
gn gen "$BUILD_DIR" --args="$GN_ARGS"
autoninja -C "$BUILD_DIR" chrome

echo "Built Chromium runtime at $SRC_DIR/$BUILD_DIR/chrome"
