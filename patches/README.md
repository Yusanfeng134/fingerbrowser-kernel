# Patch Queue

Place Chromium patches here as `*.patch` files. `scripts/apply-patches.sh` applies them in lexical order after syncing `chromium/src` to `CHROMIUM_BASE_REVISION`.

## Queue

`0001`-`0006` are build-compat and infrastructure patches; `0001`-`0005` are
macOS/Xcode-only and are not needed for the Windows build. `0007`-`0011` are
the fingerprint layer and apply in order:

| Patch | Scope |
| --- | --- |
| `0007` | `--fingerbrowser-policy` parsing; L2 hardware profile: platform, hardwareConcurrency, deviceMemory, WebGL vendor/renderer, canvas/audio noise seeds. |
| `0008` | Per-profile timezone and Accept-Language inside the renderer process. |
| `0009` | `screen.*` dimensions and Geolocation coordinates. |
| `0010` | Canvas readback keyed on absolute coordinates (partial and full reads agree), one hash per pixel. |
| `0011` | UA/Client Hints and WebGPU identity consistency: keep high-entropy hints under a custom UA, complete the brand list, spoof the WebGPU adapter to match WebGL. |

`0008`-`0011` each carry an increment on top of `0007`; they must be applied in
numeric order. The full set has been verified to apply cleanly in sequence and
to reproduce the reference worktree byte-for-byte.

Still untouched by design: fonts, Do Not Track, and account automation. Font
fingerprinting and DNT are tracked as separate work items.

