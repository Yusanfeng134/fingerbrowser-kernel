# FingerBrowser Kernel

This repository is the Chromium kernel engineering companion for FingerBrowser. It keeps Chromium source sync, patch application, macOS arm64 build commands, and runtime package manifest generation outside the Electron app repository.

## Scope

- Build a controlled Chromium runtime for compliant enterprise environment normalization.
- Load FingerBrowser profile policy through `--fingerbrowser-policy=<path>`.
- Keep behavior stable, documented, and auditable.
- Do not add random Canvas/WebGL/font noise, platform risk-control bypass, CAPTCHA bypass, batch account automation, or credential abuse features.

## Build Machine

- macOS arm64 dedicated builder.
- `depot_tools` available on `PATH`.
- Chromium source cached under `chromium/src`.
- Runtime output written under `dist/`.

## Workflow

```bash
scripts/apply-patches.sh
scripts/build-mac-arm64.sh
scripts/package-runtime.sh
```

The package step emits:

- `dist/fingerbrowser-kernel-v<PATCHSET_VERSION>-mac-arm64.zip`
- `dist/fingerbrowser-kernel-v<PATCHSET_VERSION>-mac-arm64.manifest.json`
- `dist/checksums.txt`

## Desktop App Handoff

Point the desktop app to the generated manifest before launching:

```bash
FINGERBROWSER_KERNEL_MANIFEST=/path/to/fingerbrowser-kernel-v0.1.0-mac-arm64.manifest.json npm run dev
```

For packaged builds, set the same environment variable when starting the app. The desktop app verifies the zip checksum before extracting a `file://` artifact and refuses to silently fall back when the custom kernel is missing or invalid.

## Repository Setup

Create an empty GitHub repository, then push this local repo:

```bash
git remote add origin git@github.com-yusanfeng134:Yusanfeng134/fingerbrowser-kernel.git
git push -u origin main
```
