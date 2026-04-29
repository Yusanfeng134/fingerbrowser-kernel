# macOS arm64 Build Machine Setup

This document is the week-1 operational checklist for producing a FingerBrowser custom Chromium runtime.

## Machine Requirements

- Dedicated Apple Silicon Mac.
- macOS with the current Xcode command line tools accepted and selected.
- `depot_tools` on `PATH`.
- At least 500 GB free disk for Chromium source, build output, and cache.
- No customer profile data, proxy credentials, license tokens, or desktop app databases on the build host.

## Bootstrap

```bash
xcode-select --install
sudo xcodebuild -license accept

git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$HOME/depot_tools"
export PATH="$HOME/depot_tools:$PATH"

git clone git@github.com-yusanfeng134:Yusanfeng134/fingerbrowser-kernel.git
cd fingerbrowser-kernel
```

The repository pins Chromium through `CHROMIUM_BASE_REVISION`. Do not use `stable`, `main`, branch heads, or moving aliases for formal trial builds.

## Build Workflow

```bash
bash -n scripts/*.sh
scripts/apply-patches.sh
scripts/build-mac-arm64.sh
scripts/package-runtime.sh
shasum -a 256 -c dist/checksums.txt
```

Expected outputs:

- `dist/fingerbrowser-kernel-v<version>-mac-arm64.zip`
- `dist/fingerbrowser-kernel-v<version>-mac-arm64.manifest.json`
- `dist/checksums.txt`

## Desktop Validation

1. Open FingerBrowser.
2. Go to an environment's `配置` tab.
3. Set `内核通道` to `自研内核`.
4. Click `导入 manifest` and select the generated manifest.
5. Click `检查自研内核`.
6. Launch and stop the custom-kernel environment.
7. Export a feedback package and confirm it contains the redacted kernel summary only.

The desktop app must refuse to launch custom kernel profiles when the runtime is missing, the checksum is wrong, the zip lacks the executable, or platform/arch/schema do not match.
