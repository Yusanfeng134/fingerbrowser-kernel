# patches-151 — FingerBrowser 指纹补丁（Chromium 151）

基线 **151.0.7922.47**（见 `CHROMIUM_BASE_REVISION`）。与 `../patches/`（124 基线）并列，
互不影响；客户端按内核版本选择对应补丁集构建的二进制。

从 124 移植的完整记录见 [`../docs/port-124-to-151-findings.md`](../docs/port-124-to-151-findings.md)。

## 应用

按编号顺序对纯净 151 源码树应用（各补丁文件集互不重叠，可独立回退）：

```bash
cd <chromium-src>   # git checkout refs/tags/151.0.7922.47
for p in patches-151/0*.patch; do git apply "$p"; done
```

已验证：7 个补丁套到纯净 151 后，结果树与实测通过的构建**逐字节一致**
（tree 28e104257c362108720ae7f3adf56968e3e346d0）。

## 补丁清单

| # | 补丁 | 关注点 | 主要文件 |
|---|---|---|---|
| 0001 | build-env-win-acl | 构建环境 | testing/scripts/common.py（中文 Windows ACL 的 GBK/UTF-8 解码修复）|
| 0002 | suppress-google-api-keys-infobar | 去横幅 | google_api_keys_infobar_delegate.cc |
| 0003 | fingerbrowser-core | 指纹核心 | fingerbrowser policy/switch 基础设施、开关传播、fingerprint.h、navigator.*、canvas、audio、WebGL、WebGPU、image encode |
| 0004 | fingerbrowser-regional-persona | 区域人格 | timezone、navigator.language、Accept-Language、通用字体重映射、CJK 字体屏蔽 |
| 0005 | fingerbrowser-screen-geolocation | 屏幕/定位 | screen.*、geolocation |
| 0006 | fingerbrowser-webrtc-ip-handling | WebRTC | peer_connection（IP 策略枚举化）|
| 0007 | fingerbrowser-brand | 品牌 | user_agent_utils（brands 报 Chrome）|

## 实测验证（151 chrome.exe）

DevTools 远程调试端口读 `document.title`（151 主二进制不再支持 `--dump-dom`）。
探针页由本地 HTTP 服务托管（`probe/echo-server.cjs`），因此**同一次运行同时覆盖
真实导航的线上请求头与渲染进程侧的 JS 取值**。

全绿：**Accept-Language 线上头** / navigator.language / platform / timezone /
Intl locale / brands→Chrome / UA↔高熵 CH 版本一致 / WebGL vendor+renderer /
WebGPU vendor+architecture / canvas 小画布无损 / audio 值键噪声 / CJK 字体屏蔽。

> **验证方法上的教训**：早期探针只读 `navigator.language`／`navigator.languages`，
> 据此判定 Accept-Language 通过——**这是错的**。二者是不同代码路径：JS 侧已是
> en-US 时，线上头仍在发 `zh-CN,zh;q=0.9`（见下节 ReduceAcceptLanguage）。
> 凡是"既有 JS 表示、又有线上表示"的指纹项（语言、UA、时区偏移、WebRTC 候选），
> **必须抓真实网络行为**，不能只读 JS。

## 与 124 的关键差异（速查）

- `String::FromUTF8`→`FromUtf8`；`EqualIgnoringASCIICase`→`EqualIgnoringAsciiCase`
- `base::Value::Dict`→`base::DictValue`；`chrome::RESULT_CODE_*`→`CHROME_RESULT_CODE_*`
- WebRTC IP 策略：`WebString`→`mojom::blink::WebRtcIpHandlingPolicy` 枚举
- 时区：`SetTimeZoneOverride()` 返回 `TimeZoneOverrideResult{status, handle}`
- **WebGPU**：`CreateAdapterInfoForAdapter()` 拆成 developer/web 双分支，伪装覆盖须在分支外
  （否则 web 路径泄露真实 GPU；headless 会掩盖此泄露）
- **Accept-Language**：151 的导航请求由
  `ReduceAcceptLanguageUtils::AddNavigationRequestAcceptLanguageHeaders()` 从
  profile 的 `intl.accept_languages` pref **重建并 SetHeader 覆写**，会盖掉
  `NetworkContextParams.accept_language` 与 `GetAcceptLangs()` 的结果。因此改这两处
  **不够**，必须改 pref 本身（单一真相源）
- geolocation 迁到 core/geolocation/，`GeolocationCoordinates` 改用 `std::optional<double>`
