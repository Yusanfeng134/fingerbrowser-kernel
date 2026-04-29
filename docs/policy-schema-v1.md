# FingerBrowser Policy Schema v1

The desktop app writes `fingerbrowser_policy.json` into each profile `userDataDir` before launching the custom Chromium runtime.

```json
{
  "schemaVersion": 1,
  "profileId": "profile-id",
  "runtimeChannel": "custom-kernel",
  "fingerprintPolicy": {
    "locale": "zh-CN",
    "timezone": "Asia/Shanghai",
    "windowSize": {
      "width": 1360,
      "height": 900
    },
    "permissionDefaults": "deny",
    "webrtcIpPolicy": "disable_non_proxied_udp"
  }
}
```

The policy file must not contain proxy credentials, cookies, license tokens, passwords, encrypted secret values, or customer content.

