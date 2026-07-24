# 124 → 151 内核补丁移植实录

基线 124.0.6367.207 的 16 个指纹补丁（0001–0016，0001–0005 为 macOS 专用已弃用）
套到 151.0.7922.47（SHA c583827a354674180dc8856eb65aeb3f0afa5ee9）时的实际改动。
补丁用 `patch -p1 --fuzz=3` 应用；`--fuzz` 在 151 重排过的周边代码里会把补丁块**错位**，
下面逐条记录，未来 rebase 可据此快速定位。

## 1. 机械 API 改名（151 改了大小写/类型名）

| 旧（124） | 新（151） | 影响文件 |
|---|---|---|
| `blink::String::FromUTF8` | `String::FromUtf8`（新增 `std::string_view` 重载） | navigator.cc, navigator_id.cc, navigator_language.cc, timezone_controller.cc, gpu_adapter.cc, webgl_rendering_context_base.cc |
| `EqualIgnoringASCIICase` | `EqualIgnoringAsciiCase` | font_cache.cc |
| `base::Value::Dict` / `::List` | `base::DictValue` / `base::ListValue`（提升到 base 顶层） | fingerbrowser_policy.cc（6 处）|
| `chrome::RESULT_CODE_UNSUPPORTED_PARAM` | `CHROME_RESULT_CODE_UNSUPPORTED_PARAM`（去命名空间） | chrome_browser_main.cc |

注意：`WebString::FromUTF8`（public API）**保留**旧拼写，不要连带改；
`base::FilePath::FromUTF8Unsafe` 也是不同函数，保留。

## 2. `patch --fuzz` 错位（151 重排导致补丁块落到错误位置）

- **profile_network_context_service.cc** — Accept-Language 覆盖块落进了 disk-cache
  实验组函数（返回 bool），应在 `ComputeAcceptLanguage()`（151 移到第 730 行附近）。
- **chrome_switches.cc** — `kFingerBrowserPolicy` 声明插进了
  `kEnablePotentiallyAnnoyingSecurityFeatures[]` 的字符串字面量中间，拆散了它。
- **navigator_language.cc** — 悬空的 `} else if (fb_lang…)` 落在两个函数之间，
  应改写进 `EnsureUpdatedLanguage()` 的 `if (languages_dirty_)` 块。
- **webgl_rendering_context_base.cc** — vendor/renderer 覆盖块悬空在函数外
  （还触发 `-Wglobal-constructors`），应在 `getParameter()` 的
  `kUnmaskedRendererWebgl` / `kUnmaskedVendorWebgl` 分支内。
- **user_agent_utils.cc** — brand 覆盖块悬空，应在 `GetUserAgentBrandList()` 内
  （151 的 `brand` 是 `std::optional<std::string>`，赋值兼容）。
- **chrome_browser_main.cc** — 策略应用块落进了 `void ToolkitInitialized()`，
  应在 `PreCreateThreadsImpl()`（返回 int，才能用返回错误码中止启动）。
- **fingerbrowser_policy.h** — `block_cjk_fonts` 字段落到了 struct 闭合 `};` 之后，
  要移进 struct 内。

## 3. 需要真正语义适配的 151 变更（非机械改名）

- **WebRTC**：`webrtc_ip_handling_policy` 从 `WebString` 改成枚举
  `mojom::blink::WebRtcIpHandlingPolicy`。common 层的 `ToWebRTCIPHandlingPolicy()`
  返回的是**跨进程变体** `blink::mojom::`（另一 C++ 类型），不能直接赋值——
  改为本地字符串→`mojom::blink` 枚举映射（peer_connection_dependency_factory.cc，
  在 `GetWebRTCRendererPreferences()` 之后）。
- **时区**：`SetTimeZoneOverride()` 从返回 `unique_ptr<TimeZoneOverride>` 变成返回
  `TimeZoneOverrideResult{status, handle}`。`.release()` → `.handle.release()`。
- **WebGPU（重要，真实泄露）**：151 的 `CreateAdapterInfoForAdapter()` 把
  GPUAdapterInfo 构造拆成 `if (WebGPUDeveloperFeaturesEnabled())` 全字段分支 与
  `else` 默认 web 分支（**只传 vendor_/architecture_**）。伪装覆盖必须放在两分支
  **之前**（函数顶部）。放进 developer 分支 = web 路径不执行 → 真实用户机器泄露真实
  GPU。device/description 在 web 路径本就不暴露（返回空，与真实 Chrome 一致，勿填）。
- **Accept-Language（真实泄露，检测站标红后才发现）**：124 上钩住
  `ProfileNetworkContextService::ComputeAcceptLanguage()`（喂
  `NetworkContextParams.accept_language`）即可。151 不行——导航请求会走
  `ReduceAcceptLanguageUtils::AddNavigationRequestAcceptLanguageHeaders()`，
  它从 profile 的 `intl.accept_languages` pref 重新 `ExpandLanguageList` +
  生成 q 值，然后 `SetHeader()` **直接覆写**，把网络上下文和
  `ChromeContentBrowserClient::GetAcceptLangs()` 的结果全盖掉。
  实测（带日志的构建）：两个钩子都命中且都返回 `en-US,en;q=0.9`，
  线上头仍是 `zh-CN,zh;q=0.9`。
  **修法**：不加第三个钩子，在 `ProfileNetworkContextService` 构造时把
  `intl.accept_languages` pref 设成人设语言（单一真相源）；该 pref 有变更回调，
  已缓存的 service 会自动刷新，与 KeyedService 创建顺序无关。
- **geolocation**（0009）：151 从 modules/geolocation/ 移到 core/geolocation/，
  `GeolocationCoordinates` 构造从 provides_X+double 对改成 `std::optional<double>`；
  `StartUpdating` 更名 `UpdateGeolocationState`。手工移植。
- **canvas 编码**（image_data_buffer.cc）：151 把 EncodeImageInternal 三分支重构成
  单个 `EncodeImage()`，手工移植 noise 注入点。

## 4. 构建环境修复（Windows / 中文系统）

- `testing/scripts/common.py` set_lpac_acls：`universal_newlines=True` →
  `encoding='utf-8', errors='replace'`（中文 Windows 的 icacls 输出是 GBK，
  PYTHONUTF8=1 严格 UTF-8 解码 0xd2 失败）。
- `fingerbrowser_fingerprint.h`：加 `#pragma allow_unsafe_buffers`（151 新增
  `-Wunsafe-buffer-usage` error，PerturbPixels/PerturbAudio 的裸指针循环需 opt-out）。

## 5. 验证（151 chrome.exe，DevTools 远程调试端口读 document.title）

151 主 chrome 二进制不再支持 `--dump-dom`（迁到独立 chrome-headless-shell）。
用 `--remote-debugging-port` + `/json/list` 的 title 字段取结果。

探针页由本地 HTTP 服务托管（`probe/echo-server.cjs` 把该次导航的真实
Accept-Language 注入页面），**一次运行同时覆盖线上请求头与 JS 取值**。

全部接缝验证通过：**Accept-Language 线上头(en-US,en;q=0.9)** / navigator.language /
platform / timezone / Intl locale / brands→Chrome / UA↔高熵 CH 版本一致 /
WebGL vendor+renderer / WebGPU vendor+architecture /
canvas 小画布无损（CreepJS getPixelMods 安全）/ audio 值键噪声 /
CJK 字体屏蔽（Arial 不受影响）。

**教训一**：headless / `--enable-unsafe-swiftshader` 会**开启** WebGPUDeveloperFeatures，
掩盖 WebGPU web 路径的泄露——WebGPU 伪装不能只靠 headless 探针验证。

### WebRTC ICE 差分验证（webrtcIpPolicy）

按教训二的要求补做了真实网络行为验证，不再只确认"开关接上了"。
同一构建、同一探针页，仅切换是否加 `--fingerbrowser-policy`：

| | 基线（无策略） | 开策略 disable_non_proxied_udp |
|---|---|---|
| 候选数 | 2 | 0 |
| 类型 | host:1, **srflx:1** | 无 |
| 公网 IP 泄露 | **是**（srflx 暴露真实公网 IP） | **否** |
| iceGatheringState | complete | complete |

两侧 gathering 均为 `complete`（非超时），故 0 候选是真实的"无可收集"。
这同时运行时验证了 151 移植中那处手写的**字符串→`mojom::blink::WebRtcIpHandlingPolicy`
枚举映射**（151 把该策略从 WebString 改成了枚举）。

> **权衡**：`disable_non_proxied_udp` 会导致**零 ICE 候选**。这是 Chrome 原生该策略
> 的标准行为（企业部署常用），但对"普通家庭用户"人设而言零候选本身是弱信号。
> 更理想是经环境代理产生 relay 候选（需代理支持 UDP）。无代理直连时，
> 零候选仍远好过泄露真实公网 IP。

**教训二（更普遍）**：不要用**渲染进程侧的 JS 取值**去证明**线上网络行为**。
早期探针读到 `navigator.language === 'en-US'` 就判定 Accept-Language 通过，
而真实 HTTP 头当时仍在发 `zh-CN,zh;q=0.9`——两者是独立代码路径，前者通过
不蕴含后者通过。凡"既有 JS 表示又有线上表示"的项（语言、UA、时区、WebRTC
候选、代理出口），验证必须落到真实网络行为上。
