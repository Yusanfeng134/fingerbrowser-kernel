#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="${1:-$ROOT_DIR/manifest/fingerbrowser-kernel.manifest.json}"
BASE_REVISION="$(tr -d '[:space:]' < "$ROOT_DIR/CHROMIUM_BASE_REVISION")"

if [[ "$BASE_REVISION" == "stable" || "$BASE_REVISION" == "main" || "$BASE_REVISION" == refs/heads/* || "$BASE_REVISION" == origin/* ]]; then
  echo "CHROMIUM_BASE_REVISION must be an exact git sha or immutable release tag, not '$BASE_REVISION'" >&2
  exit 1
fi

node - "$MANIFEST_PATH" "$BASE_REVISION" <<'NODE'
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { fileURLToPath } = require('node:url');

const [, , manifestPath, baseRevision] = process.argv;
if (!existsSync(manifestPath)) {
  throw new Error(`manifest not found: ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const required = [
  'version',
  'baseChromiumRevision',
  'patchsetVersion',
  'platform',
  'arch',
  'artifactUrl',
  'sha256',
  'executableRelativePath',
  'policySchemaVersion'
];

for (const field of required) {
  if (!manifest[field]) {
    throw new Error(`manifest missing field: ${field}`);
  }
}

if (manifest.baseChromiumRevision !== baseRevision) {
  throw new Error(`manifest baseChromiumRevision does not match CHROMIUM_BASE_REVISION: ${manifest.baseChromiumRevision}`);
}
if (manifest.platform !== 'darwin' || manifest.arch !== 'arm64') {
  throw new Error('manifest must target darwin arm64');
}
if (manifest.policySchemaVersion !== 1) {
  throw new Error('manifest policySchemaVersion must be 1');
}
if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
  throw new Error('manifest sha256 must be a 64-character hex digest');
}
if (/password|token|secret|cookie|cache/i.test(JSON.stringify(manifest))) {
  throw new Error('manifest contains a forbidden sensitive key or value');
}

if (manifest.artifactUrl.startsWith('file://')) {
  const artifactPath = fileURLToPath(manifest.artifactUrl);
  if (!existsSync(artifactPath)) {
    throw new Error(`artifact missing: ${artifactPath}`);
  }
  const actualSha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  if (actualSha256 !== manifest.sha256) {
    throw new Error(`artifact sha256 mismatch: ${actualSha256}`);
  }
}

console.log(`Verified ${manifest.version} (${manifest.baseChromiumRevision})`);
NODE
