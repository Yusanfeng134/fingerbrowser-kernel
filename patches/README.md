# Patch Queue

Place Chromium patches here as `*.patch` files. `scripts/apply-patches.sh` applies them in lexical order after syncing `chromium/src` to `CHROMIUM_BASE_REVISION`.

First patchset target:

- Add `--fingerbrowser-policy=<path>` switch parsing.
- Read `fingerbrowser_policy.json`.
- Apply policy-backed locale, timezone, initial window size, permission defaults, and WebRTC IP handling.
- Leave Canvas, WebGL, fonts, hardware identities, and account automation untouched.

