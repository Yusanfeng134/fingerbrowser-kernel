# FingerBrowser Policy Schema v1

The desktop app writes `fingerbrowser_policy.json` into each profile `userDataDir` before launching the custom Chromium runtime.

```json
{
  "schemaVersion": 1,
  "profileId": "profile-id",
  "runtimeChannel": "custom-kernel",
  "fingerprintPolicy": {
    "locale": "en-US",
    "timezone": "America/Los_Angeles",
    "windowSize": {
      "width": 1360,
      "height": 900
    },
    "permissionDefaults": "deny",
    "webrtcIpPolicy": "disable_non_proxied_udp",
    "brand": "Google Chrome",
    "hardwareProfile": {
      "platform": "Win32",
      "gpuVendor": "Google Inc. (NVIDIA)",
      "gpuRenderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "webgpuVendor": "nvidia",
      "webgpuArchitecture": "ada-lovelace",
      "webgpuDevice": "0x2882",
      "webgpuDescription": "NVIDIA GeForce RTX 4060",
      "hardwareConcurrency": 8,
      "deviceMemory": 8,
      "canvasNoise": 987654321,
      "audioNoise": 123456789,
      "screenWidth": 1920,
      "screenHeight": 1080,
      "geolocation": { "latitude": 34.0522, "longitude": -118.2437 }
    }
  }
}
```

## Fields

`fingerprintPolicy` root:

| Field | Since | Notes |
| --- | --- | --- |
| `locale` | 0007 / 0008 / 0012 | Drives navigator.language (0008), the Accept-Language header, and the Intl/ICU default locale (0012) — all three surfaces, kept consistent. |
| `timezone` | 0007 / 0008 | IANA zone. 0008 also propagates it into the renderer's own ICU. |
| `windowSize` | 0007 | Initial window, not `screen.*`. |
| `permissionDefaults` | 0007 | `deny` blocks permission prompts. |
| `webrtcIpPolicy` | 0007 / 0013 | e.g. `disable_non_proxied_udp`. 0007 shipped the field but the switch it set was a no-op; 0013 makes it actually stop the WebRTC real-IP leak. |
| `brand` | 0011 | Product brand added to the Client Hints brand list (`Google Chrome`, `Microsoft Edge`, …). Must match the product the UA string claims; an unbranded build otherwise omits it. |
| `blockCjkFonts` | 0016 | Bool. Hide the host's CJK fonts and remap generic families to US fonts. Set for a non-CJK persona so a Chinese/Japanese/Korean Windows does not leak its region through font enumeration. |

`hardwareProfile` (all optional; an invalid field is skipped, not fatal):

| Field | Since | Notes |
| --- | --- | --- |
| `platform` | 0007 | `navigator.platform`. Keep consistent with the UA. |
| `gpuVendor` / `gpuRenderer` | 0007 | WebGL `UNMASKED_VENDOR/RENDERER`. |
| `webgpuVendor` / `webgpuArchitecture` / `webgpuDevice` / `webgpuDescription` | 0011 | WebGPU adapter identity. **Must name the same GPU family as `gpuRenderer` and as the host** — WebGPU `limits`/`features` still come from the real adapter, so a cross-vendor identity is exposed by the feature set (Apple reports `texture-compression-etc2/astc`, desktop parts report `bc`). |
| `hardwareConcurrency` | 0007 | 1–128. |
| `deviceMemory` | 0007 | Clamped to 1/2/4/8 by the spec. |
| `canvasNoise` / `audioNoise` | 0007 / 0010 | int32 seed (values above 2147483647 are silently dropped). 0010 keys canvas noise on absolute pixel coordinates. |
| `screenWidth` / `screenHeight` | 0009 | `screen.*`. Omitting these leaks the host resolution. |
| `geolocation` | 0009 | `{ latitude, longitude }`; short-circuits the Geolocation API. |

The policy file must not contain proxy credentials, cookies, license tokens, passwords, encrypted secret values, or customer content.

