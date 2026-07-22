# Windows x64 Build Machine Setup

This document is the operational checklist for producing a FingerBrowser custom
Chromium runtime on Windows x64. It mirrors `docs/build-machine-setup.md`
(macOS arm64) for the Windows toolchain.

## Machine Requirements

- Windows 10/11 x64.
- Visual Studio 2022 (Community is fine) with the **Desktop development with
  C++** workload, plus these individual components:
  - MSVC v143 - VS 2022 C++ x64/x86 build tools
  - C++ ATL for latest v143 build tools (x86 & x64)
  - Windows 11 SDK **10.0.22621.x** (the version pinned by Chromium 124's
    `build/vs_toolchain.py`)
  - Debugging Tools for Windows (installed as an SDK feature; Chromium's
    toolchain check fails without it)
- `depot_tools` on `PATH`, ahead of any system Python.
- At least **150 GB free** on the build drive for source, build output, and
  cache. Do **not** build on a drive with < 100 GB free.
- Long paths enabled (`git config --global core.longpaths true`) — the Chromium
  tree exceeds the legacy `MAX_PATH` limit.
- No customer profile data, proxy credentials, license tokens, or desktop app
  databases on the build host.

## Bootstrap

Run from an elevated **Developer** shell (or a normal shell after
`git config --global core.longpaths true`).

```bash
# 1. depot_tools (do NOT use `git clone --depth`; the bootstrap needs history)
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git D:/depot_tools

# 2. PATH + external toolchain flags. depot_tools must come first so its
#    bundled Python/gn/ninja win over anything already installed.
export PATH="/d/depot_tools:$PATH"
export DEPOT_TOOLS_WIN_TOOLCHAIN=0   # use the locally installed Visual Studio
export GYP_MSVS_VERSION=2022

# 3. clone the kernel repo onto the same large drive
cd /d
git clone <this-repo-url> fingerbrowser-kernel
cd fingerbrowser-kernel
```

`DEPOT_TOOLS_WIN_TOOLCHAIN=0` is mandatory for external builders: without it,
`gclient runhooks` tries to download Google's internal packaged Windows
toolchain, which requires Google corp access and will fail.

The repository pins Chromium through `CHROMIUM_BASE_REVISION`
(`refs/tags/124.0.6367.207`). Do not use `stable`, `main`, branch heads, or
moving aliases for formal trial builds.

## Build Workflow

```bash
bash -n scripts/*.sh
scripts/apply-patches.sh          # fetch + sync Chromium, apply the patch queue
scripts/build-win-x64.sh          # gn gen + autoninja chrome
```

`scripts/build-win-x64.sh` generates `out/FingerBrowserKernelWinX64` with:

```
target_os="win" target_cpu="x64" is_debug=false is_component_build=false \
  symbol_level=0 enable_nacl=false proprietary_codecs=false
```

Expected primary output:

- `chromium/src/out/FingerBrowserKernelWinX64/chrome.exe` and its runtime
  dependencies (`*.dll`, `resources.pak`, `icudtl.dat`, `v8_context_snapshot.bin`,
  the `locales/` directory, etc.).

Preview the exact GN args without building:

```bash
FINGERBROWSER_KERNEL_PRINT_GN_ARGS=1 scripts/build-win-x64.sh
```

## Google API Credentials (optional)

Identical to the macOS/Linux builds. Provide all three values together before
running the build script, or none:

```bash
export FINGERBROWSER_GOOGLE_API_KEY=...
export FINGERBROWSER_GOOGLE_DEFAULT_CLIENT_ID=...
export FINGERBROWSER_GOOGLE_DEFAULT_CLIENT_SECRET=...
```

Do not commit these values.

## Not Yet Provided

- There is no `scripts/package-runtime-win-x64.sh` or Windows manifest verifier
  yet. macOS uses `package-runtime.sh` + `.app` renaming; Linux uses
  `package-runtime-linux-x64.sh` + `fingerbrowser-kernel/chrome`. A Windows
  packaging step (zip of the runtime dir + `win/x64` manifest + checksum) still
  needs to be authored before a Windows artifact can be handed to the desktop
  app.

## Notes on the Fingerprint Patch (0007)

`patches/0007-fingerbrowser-fingerprint.patch` is written to be
cross-platform. The one platform-conditional path is the timezone application:
`tzset()` is guarded by `BUILDFLAG(IS_POSIX) || BUILDFLAG(IS_FUCHSIA)` and is a
no-op on Windows, but `icu::TimeZone::adoptDefault()` still runs, so the ICU
timezone override applies on Windows. All renderer-side seams
(navigator/WebGL/canvas/audio) are platform-neutral and build unchanged.
