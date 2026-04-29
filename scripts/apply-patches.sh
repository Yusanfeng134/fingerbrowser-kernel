#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_REVISION="$(tr -d '[:space:]' < "$ROOT_DIR/CHROMIUM_BASE_REVISION")"
SRC_DIR="$ROOT_DIR/chromium/src"

if [[ -z "$BASE_REVISION" ]]; then
  echo "CHROMIUM_BASE_REVISION is empty" >&2
  exit 1
fi

if ! command -v fetch >/dev/null 2>&1 || ! command -v gclient >/dev/null 2>&1; then
  echo "depot_tools must be installed and available on PATH" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/chromium"
if [[ ! -d "$SRC_DIR/.git" ]]; then
  cd "$ROOT_DIR/chromium"
  fetch --nohooks chromium
fi

cd "$SRC_DIR"
git fetch --tags origin
git checkout --detach "$BASE_REVISION"
gclient sync -D --with_branch_heads --with_tags

shopt -s nullglob
patches=("$ROOT_DIR"/patches/*.patch)
if [[ ${#patches[@]} -eq 0 ]]; then
  echo "No patches found under $ROOT_DIR/patches; source is synced only."
  exit 0
fi

for patch_file in "${patches[@]}"; do
  echo "Applying $(basename "$patch_file")"
  git apply --check "$patch_file"
  git apply "$patch_file"
done

echo "Patch queue applied to $BASE_REVISION"

