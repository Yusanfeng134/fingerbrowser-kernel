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
| 0008 | fingerbrowser-passkey-authenticator | **每环境 passkey 认证器** | content/browser/webauth（策略驱动挂载、AAGUID 归零、加密持久化）、base/threading（ScopedAllowBlocking 白名单）|
| 0009 | rename-kernel-executable | 产物改名 | chrome/BUILD.gn 等（chrome.exe → yunbrowser.exe）|
| 0010 | fingerbrowser-window-icon | 环境级图标 | browser_view.cc（`--yunlogin-window-icon`，窗口与任务栏双路接线）|
| 0011 | fingerbrowser-capabilities-manifest | 能力清单 | chrome/BUILD.gn + generate_capabilities.py（构建产出 `yunbrowser.capabilities.json`）|

> **0009 为何单独成一个补丁**：0011 的清单产物名依赖改名，而 `chrome/BUILD.gn` 里改名与清单两处改动在同一文件、无法按文件拆分，故按提交顺序分层导出。0009 必须在 0011 之前应用。

### 0008 说明：亚马逊安全密钥（passkey）支持

解决亚马逊上线 WebAuthn 风控后**客户完全无法完成验证**的问题：指纹浏览器里平台认证器（Windows Hello）会把多个店铺账号绑到同一台机器，手机 hybrid 路径对无 Google 服务的国产 Android 不可用，USB 密钥又需硬件且共用即关联——三条路同时堵死，实测表现为 `navigator.credentials.create()` **无限挂起**。

本补丁给每个环境提供**独立的软件 CTAP2 认证器**：
- **策略驱动**：policy 的 `passkeyAuthenticator` → `--fp-passkey`（策略字段在 0003 中），WebAuthn 请求到来时自动挂载，**不依赖 CDP**。
- **AAGUID 归零**：`VirtualAuthenticator::Options::zero_aaguid` 强制 self attestation。**必须在认证器层强制**——规范只在 RP 请求 `attestation=none` 时归零，RP 请求 `direct/indirect` 时仍会发出 Chromium 虚拟认证器的公开 AAGUID，实测被亚马逊显示为 "Chromium Virtual Authenticator (browser dev tools)"。**绝不借用其它厂商 AAGUID 冒充硬件。**
- **加密持久化**：凭据（含私钥、**签名计数器**）经 DPAPI 加密后存入环境 profile 目录。counter 必须持久化——RP 把计数器回退视作认证器被克隆。
- **环境隔离**：凭据随 profile 走，跨环境不可见。

实测（`probe/run-p1-persistence.cjs`）：注册→关闭浏览器→重开仅登录成功（凭据跨重启存活）；另一 profile 仅登录失败（隔离生效）；存储文件扫不到明文字段名。

真实站点实测（amazon.com，授权测试账号）：买家端与卖家中心均接受注册与登录；AAGUID 归零后，账号页**不再出现 "Chromium 虚拟身份验证器（浏览器开发工具）"**，该条目按平台回退显示为 "Windows Hello"——即与一台普通 Windows 电脑的系统级 passkey 无从区分。（该归属为推断：列表中仅此条可能来自本 Windows 内核，且落盘时间吻合。）

> 实现注记：写盘经线程池异步执行（凭据变更在 UI 线程上报，同步 I/O 会触发 DCHECK 崩溃）；读取需同步（认证器创建时即须持有凭据），故在 `base/threading/thread_restrictions.h` 的 `ScopedAllowBlocking` 白名单中加了 friend。这是本补丁集**唯一改动 `base/` 之处**，rebase 时需留意。

## 实测验证（151 chrome.exe）

DevTools 远程调试端口读 `document.title`（151 主二进制不再支持 `--dump-dom`）。
探针页由本地 HTTP 服务托管（`probe/echo-server.cjs`），因此**同一次运行同时覆盖
真实导航的线上请求头与渲染进程侧的 JS 取值**。

全绿：**Accept-Language 线上头** / navigator.language / platform / timezone /
Intl locale / brands→Chrome / UA↔高熵 CH 版本一致 / WebGL vendor+renderer /
WebGPU vendor+architecture / canvas 小画布无损 / audio 值键噪声 / CJK 字体屏蔽。

**WebRTC** 另做差分 ICE 验证（`probe/webrtc-probe.html`）：基线收到
host+srflx 两个候选、srflx 暴露真实公网 IP；开策略后 0 候选、无公网 IP，
两侧 `iceGatheringState` 均为 complete。这同时验证了 151 那处
字符串→`mojom::blink::WebRtcIpHandlingPolicy` 枚举映射在运行时有效。

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
