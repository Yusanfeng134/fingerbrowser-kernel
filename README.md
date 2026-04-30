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
- `CHROMIUM_BASE_REVISION` pinned to an exact git sha or release tag. Formal builds must not use `stable`, `main`, branch heads, or other moving aliases.
- macOS app icon assets live under `assets/macos/` and are applied during packaging.
- Google API credentials are optional build inputs. To enable Chromium features that require Google APIs, provide all three values as environment variables before `scripts/build-mac-arm64.sh`:
  - `FINGERBROWSER_GOOGLE_API_KEY`
  - `FINGERBROWSER_GOOGLE_DEFAULT_CLIENT_ID`
  - `FINGERBROWSER_GOOGLE_DEFAULT_CLIENT_SECRET`

Do not commit Google API keys, OAuth client IDs, or OAuth client secrets. Chromium upstream documents that sign-in to Chromium builds is restricted unless the account is allowed by Google for Chromium sign-in testing; this repo only wires the supported key delivery path.

## Workflow

```bash
bash -n scripts/*.sh
tests/kernel-icon-packaging.sh
scripts/apply-patches.sh
scripts/build-mac-arm64.sh
scripts/package-runtime.sh
scripts/verify-runtime-manifest.sh dist/fingerbrowser-kernel-v<version>-mac-arm64.manifest.json
```

The package step emits:

- `dist/fingerbrowser-kernel-v<PATCHSET_VERSION>-mac-arm64.zip`
- `dist/fingerbrowser-kernel-v<PATCHSET_VERSION>-mac-arm64.manifest.json`
- `dist/checksums.txt`

`scripts/package-runtime.sh` renames the copied Chromium app bundle to `FingerBrowser Kernel.app`, applies `assets/macos/FingerBrowserKernel.icns`, and updates `Info.plist` bundle name, display name, icon file, and bundle identifier before checksumming the zip.

## Desktop App Handoff

Preferred trial handoff uses the desktop app UI:

1. Open an environment.
2. Switch `内核通道` to `自研内核`.
3. Click `导入 manifest`.
4. Select `dist/fingerbrowser-kernel-v<version>-mac-arm64.manifest.json`.
5. Click `检查自研内核`.

For developer sessions, the desktop app can still be pointed to a generated manifest before launching:

```bash
FINGERBROWSER_KERNEL_MANIFEST=/path/to/fingerbrowser-kernel-v0.1.1-mac-arm64.manifest.json npm run dev
```

The desktop app verifies the zip checksum before extracting a `file://` artifact and refuses to silently fall back when the custom kernel is missing or invalid.

See `docs/build-machine-setup.md` and `docs/trial-delivery-checklist.md` for the build-machine and customer-trial handoff runbooks.

## Repository Setup

Create an empty GitHub repository, then push this local repo:

```bash
git remote add origin git@github.com-yusanfeng134:Yusanfeng134/fingerbrowser-kernel.git
git push -u origin main
```
