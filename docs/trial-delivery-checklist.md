# Trial Delivery Checklist

Use this checklist before a 30-day trial handoff.

## Assets

- FingerBrowser macOS debug or signed app package.
- `fingerbrowser-kernel-v<version>-mac-arm64.zip`.
- `fingerbrowser-kernel-v<version>-mac-arm64.manifest.json`.
- `checksums.txt`.
- Customer-facing installation note with the local manifest import steps.
- `FingerBrowser Kernel.app` displays the FingerBrowser Kernel Dock/Finder icon after install.

## Preflight

- `CHROMIUM_BASE_REVISION` is fixed to an explicit revision or release tag.
- `dist/checksums.txt` verifies both runtime zip and manifest.
- Runtime zip contains `FingerBrowser Kernel.app/Contents/Resources/FingerBrowserKernel.icns`.
- `Info.plist` uses `CFBundleIconFile=FingerBrowserKernel`.
- Manifest fields match the desktop contract:
  - `version`
  - `baseChromiumRevision`
  - `patchsetVersion`
  - `platform=darwin`
  - `arch=arm64`
  - `artifactUrl`
  - `sha256`
  - `executableRelativePath`
  - `policySchemaVersion=1`
- No Chromium source tree, build cache, customer profile data, proxy credentials, license tokens, or local app databases are included in the handoff.

## Demo Flow

1. Activate trial license.
2. Create one official environment.
3. Create one custom-kernel environment.
4. Import manifest through the desktop app.
5. Install runtime through `检查自研内核`.
6. Launch and stop the custom-kernel environment.
7. Confirm audit events include kernel install, policy apply, and kernel launch.
8. Generate feedback package and confirm it contains redacted kernel summary only.

## Release Gate

Unsigned or unnotarized macOS packages are internal debug artifacts only. External distribution requires Apple Developer ID signing and notarization before customer handoff.
