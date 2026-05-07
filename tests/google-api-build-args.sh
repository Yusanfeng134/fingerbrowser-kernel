#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

complete_args="$(
  FINGERBROWSER_KERNEL_PRINT_GN_ARGS=1 \
  FINGERBROWSER_GOOGLE_API_KEY="api-key" \
  FINGERBROWSER_GOOGLE_DEFAULT_CLIENT_ID="client-id.apps.googleusercontent.com" \
  FINGERBROWSER_GOOGLE_DEFAULT_CLIENT_SECRET="client-secret" \
    "$ROOT_DIR/scripts/build-mac-arm64.sh"
)"

[[ "$complete_args" == *'google_api_key="api-key"'* ]]
[[ "$complete_args" == *'google_default_client_id="client-id.apps.googleusercontent.com"'* ]]
[[ "$complete_args" == *'google_default_client_secret="client-secret"'* ]]

plain_args="$(FINGERBROWSER_KERNEL_PRINT_GN_ARGS=1 "$ROOT_DIR/scripts/build-mac-arm64.sh")"
[[ "$plain_args" != *'google_api_key='* ]]
[[ "$plain_args" != *'google_default_client_id='* ]]
[[ "$plain_args" != *'google_default_client_secret='* ]]

linux_args="$(FINGERBROWSER_KERNEL_PRINT_GN_ARGS=1 "$ROOT_DIR/scripts/build-linux-x64.sh")"
[[ "$linux_args" == *'target_os="linux"'* ]]
[[ "$linux_args" == *'target_cpu="x64"'* ]]
[[ "$linux_args" != *'google_api_key='* ]]

set +e
partial_output="$(
  FINGERBROWSER_KERNEL_PRINT_GN_ARGS=1 \
  FINGERBROWSER_GOOGLE_API_KEY="api-key" \
    "$ROOT_DIR/scripts/build-mac-arm64.sh" 2>&1
)"
partial_status=$?
set -e

[[ $partial_status -ne 0 ]]
[[ "$partial_output" == *"Google API credentials must be provided together"* ]]

echo "Google API build args test passed"
