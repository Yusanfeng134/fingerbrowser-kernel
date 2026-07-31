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
| 0012 | build-blink-generators-utf8 | 构建环境 | blink 代码生成器显式 UTF-8 读写（中文 Windows）|
| 0013 | fingerbrowser-console-omnibox | 管理台地址栏 | location_bar_model（显示产品名而非本地服务 URL、挂锁、只读）|

| 0014 | brand-ui-strings | 品牌文案 | `.grd` / `.grdp` / 162 份 `.xtb` / BRANDING（182 个文件）|
| 0015 | brand-exe-icon | 可执行文件图标 | `chromium.ico`（二进制补丁，须 `--binary` 生成）|
| 0016 | fingerbrowser-shell-ui | 外壳 UI | Voyager 侧栏、垂直标签栏、`--fp-shell`/`--fp-active` 拆分（24 个文件）|
| 0017 | fingerbrowser-pinned-console-tab | 钉标签 | `--fp-pinned-url` 把管理台标签设为固定 |
| 0018 | fingerbrowser-no-google-signin | 账号 | 工作环境禁登 Google |
| 0019 | fingerbrowser-stale-console-tabs | 标签清理 | 清掉上次启动遗留的管理台固定标签（依赖 0017）|
| 0020 | fingerbrowser-newtab-url | 新标签页 | `--fp-newtab-url` 让新标签页打开客户端的 AI 新标签页 |
| 0021 | fingerbrowser-block-native-profiles | 堵洞 | 禁用原生 profile 的创建入口（命令层 + profile-picker）|
| 0022 | fingerbrowser-newtab-blank-omnibox | 新标签页 | 新标签页地址栏留空但保持可用（依赖 0020）|
| 0023 | fingerbrowser-account-panel | 账号面板 | `--fp-account-panel` 用云登账号面板替换原生头像菜单（22 个文件）|
| 0024 | fingerbrowser-aumid-prefix | 品牌 | AUMID 前缀 `Chromium.` → `Yunbrowser.`（任务栏分组键）|
| 0025 | fingerbrowser-account-panel-login-entry | 账号面板 | 顶部账号行可点，指向管理台 `#/account`（依赖 0023）|
| 0026 | fingerbrowser-fingerprint-contradictions | 指纹 | 消除 DPR / 媒体查询 / 触摸 / platformVersion 四处问题 |
| 0027 | fingerbrowser-account-panel-drop-settings | 账号面板 | 去掉指向不存在路由的「设置」项（依赖 0023）|
| 0028 | fingerbrowser-vector-icon-script-utf8 | 构建 | 向量图标聚合脚本按 UTF-8 读写（与 0012 同族，**必须在 0030 之前**）|
| 0029 | fingerbrowser-dynamic-island-webui | 灵动岛 | 灵动岛的 WebUI 页面本体，注册完成但无入口 |
| 0030 | fingerbrowser-dynamic-island-toolbar-entry | 灵动岛 | 工具栏按钮 + 气泡 + `IDC_TOGGLE_DYNAMIC_ISLAND` + Ctrl+Shift+K（依赖 0029）|
| 0031 | fingerbrowser-dynamic-island-query-in-fragment | 灵动岛 | 钉住 `?q=` 必须落在 `#` 之后（纯注释，依赖 0029）|
| 0032 | fingerbrowser-policy-parse-dpr-touch | 指纹 | 策略解析补上 `devicePixelRatio` / `maxTouchPoints` —— 0026 的这两处此前不可达 |

### 0026 说明：矛盾 ≠ 未伪装

两者危害不同级：**未伪装**暴露真实值，检测方看到一个普通用户；**矛盾**是两个本该一致的值对不上，检测方看到的是**有人动过手脚**。后者是阳性证据。本补丁前三项是矛盾，第四项是未伪装。

| 项 | 类型 | 说明 |
|---|---|---|
| 媒体查询 `device-width` | 矛盾 | `screen.*` 的伪装在 `Screen::width()` getter 上，媒体查询走 `ScreenInfo`，两条路各说各话。实测宿主 4K@175% 时媒体查询报 2195（= 3840/1.75）而 `screen.width` 报 1920，**一条 CSS 媒体查询即可拆穿**。复用已有 `fp-screen-*` 而不新开开关：屏幕尺寸只能有一处真相 |
| `--fp-dpr-x1000` | 矛盾 | 宿主 1.75，而人格声称的普通桌面屏几乎总是 1；它也是上面 2195 的来源 |
| `--fp-max-touch-points` | 矛盾 | 宿主报 10，而 `ontouchstart` 不存在、`pointer:coarse` 为否 —— 三者本该同进同退 |
| `--fp-platform-version` | **未伪装** | Windows 上是 WinRT API Contract 版本，实测本机 19.0.0（Win11 24H2+），罕见即高熵 |

> **`LayoutZoomFactor()` 已经含了设备缩放**（= 设备缩放 × 页面缩放）。第一版直接相乘等于把 1.75 又乘回去，实测 DPR 仍是 1.75，改动看起来完全没生效。现改为除掉真实设备缩放、只保留页面缩放 —— 用户按 Ctrl+= 时 DPR 本该跟着变，钉死成常数反而是新特征。

> **新开关必须加进 `render_process_host_impl.cc` 的渲染进程转发白名单**，否则开关传了、代码写了、就是不生效。而媒体查询那处因复用旧开关**反而先生效了** —— 一半好一半不好，比全都不生效更难定位。

> **`fp-max-touch-points` 不能用「值 > 0」判断是否接管**：0 恰恰是桌面人格该传的值。为此新增 `fingerbrowser::HasSwitch()`；策略侧同理用独立的 `has_` 标志位。

> **CreepJS 报的「UA Win10 vs CH Win11」不成立。** Win11 起 UA 里的 `Windows NT` 冻结在 `10.0`，Client Hints 用另一套编号，两者不同是**正常**的 —— 真实 Win11 机器就这么报。此前转述该结论时未经核实。

### 0027 说明：打开成功 ≠ 去对了地方

「设置」指向 `#/settings`，而管理台没有这个路由；SPA 的兜底 `<Route path="*">` 接住它，最终显示环境管理。**能点、有反应、页面也正常渲染，只是去错了地方。**

> 只验「每一项都能点开一个标签页」时该项**必然通过** —— 因为它确实打开了一个标签页。验收得逐项核对**落地页是不是它声称的那个**。
>
> 已做成自动检查（`probe/run-panel-links.cjs`）。两处刻意设计：**面板有几项由面板自己说**（硬编码清单则面板加项时不会失败，等于漏测）；**假管理台不设兜底路由**（真管理台的兜底恰恰是本次假通过的成因，测试环境复刻它就等于复刻盲区）。

### 0024 说明：只改 `base_app_id`

链路：`GetAppUserModelIdForBrowser()` → `ShellUtil::GetBrowserModelId()` → `install_static::GetBaseAppId()` → `chromium_install_modes.h` 的 `base_app_id`。

同一张表里还有几个品牌串，**均保持原样**：`base_app_name`、`browser_prog_id_prefix`、`pdf_prog_id_prefix` 是安装器与文件关联注册用的（本产品不走安装器）；**`kProductPathName` 尤其不能顺手改** —— 它是默认用户数据目录的路径成分，改了会让所有未显式指定 `--user-data-dir` 的场景换目录。「都是品牌泄漏，一起改掉」听起来合理，但影响面完全不同。

验证（`probe/check-aumid.ps1`，程序读 `System.AppUserModel.ID`，非肉眼）：

```
prof-aumid-a  Yunbrowser.U4KBPE2AZLGVDTK5V6VY.profaumida.Default
prof-aumid-b  Yunbrowser.U4KBPE2AZLGVDTK5V6VY.profaumidb.Default
```

> **两条必须一起验。** 第二条是反例：AUMID 里的 profile 哈希决定任务栏分组，只顾改前缀而弄丢哈希，会让所有店铺环境合并成同一个任务栏按钮 —— 比留着 `Chromium` 严重得多，而只验第一条完全看不出来。

### 0023 说明：新增一个 top-chrome WebUI 要接的九处线

以 Voyager 侧栏（0016）为模板，但**宿主不同**：侧栏 → 气泡。接线清单：

| # | 文件 | 漏了会怎样 |
|---|---|---|
| 1 | `resources/<name>/` 四件 | — |
| 2 | `webui/<name>/` 三件 | — |
| 3 | `webui_url_constants.h` | 编译失败 |
| 4 | `chrome_web_ui_configs.cc` | 页面 404 |
| 5 | `chrome_paks.gni` ×2 | gn 失败 |
| 6 | `resources/BUILD.gn` ×2 | gn 失败 |
| 7 | `resource_ids.spec` ×2 | 资源打不进去 |
| 8 | `third_party/lit/v3_0/BUILD.gn` | gn 失败（可见性白名单）|
| 9 | `histograms.xml` | **静默**：埋点打出未知 WebUI 名 |
| — | `ui/BUILD.gn` ×2 | 链接失败 |

只有第 9 条是静默的。

**气泡宿主另有三处非显然的坑**（侧栏模板里没有）：

- **锚点必须直接取头像按钮的 View**。`GetAvatarToolbarButton()` 优先返回 `BubbleAnchor(TrackedElement)`，不是 View；取不到 View 则气泡既无 `anchor_widget` 又无 `parent_window`，`CreateBubble` 的 `DCHECK(bubble_params.parent || !bubble->has_parent())` 当场失败 —— **表现是点头像闪退**。
- **`ShouldAutoResizeHost()` 必须返回 true**。默认 false 对侧栏是对的（尺寸由侧栏决定），气泡没有外部尺寸来源，关掉就停在最小尺寸 —— **表现是空白小气泡，看起来像页面没加载，实际内容已渲染成 288×186 而视口只有 26px**。
- **`WebUIContentsWrapper` 的所有权在 coordinator**，气泡视图只持 `WeakPtr`。

> **链接由宿主接管，不给页面 mojo 方法。** 上游 `WebUIContentsWrapper::Host::OpenURLFromTab` 默认返回 `nullptr`，气泡里的链接点了不会有任何反应，所以「面板项就是几个 `<a href>`」在上游走不通。`AccountPanelBubbleView` 重写它并只放行管理台 origin ——**能去哪由 C++ 决定，不由页面决定**，比给页面一个打开 URL 的方法收得更紧。这个面天生是特权面（跑在 `chrome://` 上），而这类接口「加一个方法几乎零成本、减一个方法要改两边」，故在还没有第一个方法时就卡住。
>
> **白名单拒绝路径已验**（0025）：把要新增的链接先故意指向 `https://example.com`，实测点击**无任何反应**，而同面板下方三项照常打开；确认后改成正确地址。同一次改动里既做功能又验反例，不留临时代码。
>
> **两条必须成对。** 只验「拦住了」，全拦死也会通过；只验「能打开」，全放行也会通过 —— 面板里若没有会被拒的链接，「链接都能打开」与「白名单形同虚设」表现完全一致。0023 提交时把这条记成「未验证的待办」是**归类错误**：它不是「有一项待验」，而是「这项验收必然通过，且与实现是否正确无关」。

### 0021 说明：为什么在命令层禁而不在菜单里藏

本产品里「环境」已经占据了 profile 这个位置。而 `IDC_ADD_NEW_PROFILE` / `IDC_OPEN_GUEST_PROFILE` / `IDC_MANAGE_CHROME_PROFILES` 创建的是**原生** profile —— 管理台里看不见、没有指纹策略、不受环境隔离管辖，却能上网能登账号。

这三个命令至少有三条可达路径:头像气泡 `ProfileMenuView`、三点菜单（`app_menu_model.cc` 的 `ProfileSubMenuModel`）、以及 `chrome://profile-picker` 直接导航。

> **逐个隐藏入口只会让洞更难被看见。** 菜单里看不见和做不到是两回事。菜单项遵从命令启用状态，禁掉命令则现有与将来的入口一并失效；`chrome://profile-picker` 不走命令，故另在 `--fp-shell` 下不注册它的 WebUIConfig。两者是同一件事的两半。

### 0022 说明：与 0013 语义相反，不可套用

管理台是**产品名 + 挂锁 + 只读**；新标签页**必须能输入**。两者同源（同一份产物、同一个本地服务）而语义相反。

走 `ShouldDisplayURL()`（原生 NTP 用的机制）而非显示文本覆盖：前者给出空地址栏 + 占位文案**且保持可聚焦、可输入、可导航**，后者只能做到「看起来是空的」。该函数逐次按当前 URL 求值，故导航到真实网站后立刻显示真实域名。

> **只取「不显示 URL」一条、沿用 0013 的只读，就会把 0020 修掉的那个回归重新造出来。**
>
> 判定统一在 `IsNewTabUrl()`，不再内联：0013 的规则要**排除**它，0022 要**命中**它——同一条规则散在两处迟早只被改一处，而漂移后的症状是静默的。

### 0020 说明：与 0013 的同源冲突

AI 新标签页由客户端**同一个本地服务**提供，与管理台**同源**（`/newtab` 对 `/`）——这是客户端为复用同一份产物有意做的设计。而 0013 的地址栏改写**按 origin 判定**，不加排除的话新标签页会被认成管理台：地址栏显示产品名并置为只读，**用户按 Ctrl+T 后无法输入网址**，基本浏览功能丢失。

0020 按 **path** 排除（两者都是 hash 路由，管理台在 `/`、新标签页在 `/newtab`，fragment 不参与），与客户端在服务端切分两者的依据一致。

> **改 0013 的匹配规则时必须同时想到这条。** 这个回归极易躲过验收：0013 那六条实测全在管理台页面上做，碰不到新标签页；0020 若只验「AI 页面打开了」，看到页面出现也就过了——除非有人恰好去点一下新标签页的地址栏。

> **✅ 已验证可完整重建。** 将 0001–0020 依序应用到纯净 151（`git apply --cached`
> 到临时索引后 `write-tree`），得到的树与分支 HEAD 的树**哈希完全相同**，
> 逐字节一致。
>
> **必须做全树比对，不能只看「补丁全部干净应用」。** 实测过一次 19 个补丁
> 全部 ✓ 应用、却仍漏掉 `chrome/browser/ui/BUILD.gn` 两行 Voyager 依赖的情况：
> 该文件同时被外壳工作与 0013 改过，而生成规则是「同一文件只归一个补丁」，
> 文件被 0013 认领后，外壳那两行掉出了整个补丁集。两边各自都对，合起来漏了
> 一块，且是静默的。其症状与代码写错完全一致（链接期报
> `VoyagerSidePanelUIConfig` 未定义），足以让人去查代码而不是查补丁集。
>
> **由此得到的规则**：分配文件前先看它是否被多方改过；是的话不能整文件归属，
> 只能由后应用的一方生成增量 hunk。详见 `SHELL-PATCHES-NOTE.md` 第 5 节。
>
> 顺序不可打乱，存在四处硬依赖：0009 先于 0011、0013 先于 0016、0017 先于 0019、
> **0028 先于 0030**。最后一处的失败形态与前三处不同：不是应用冲突，而是应用
> 得干干净净、随后**构建**炸在一条指错地方的报错上 —— 0030 新增的两个 `.icon`
> 带中文注释，没有 0028 的编码修复，聚合脚本会在中文 Windows 上以 GBK 读它们，
> 报的是 `gen/chrome/app/vector_icons/vector_icons.cc: FAILED` 加一句
> `UnicodeDecodeError`，既不指名文件也不指向 0030。
>
> 所以「补丁全部干净应用」对顺序依赖同样不是充分检查 —— 与下面那条全树比对的
> 教训是同一件事的两个方向。

> **0009 为何单独成一个补丁**：0011 的清单产物名依赖改名，而 `chrome/BUILD.gn` 里改名与清单两处改动在同一文件、无法按文件拆分，故按提交顺序分层导出。0009 必须在 0011 之前应用。

### 0013 说明：管理台地址栏

客户端把管理台交给内核作为启动页打开，页面由本地 HTTP 服务提供，端口是 `listen(0)` 由系统分配，因此地址栏显示 `http://127.0.0.1:53483/#/yunlogin-environments`——一个用户用不上、每次启动还都不一样的实现细节。改为显示 `--fp-console-title` 指定的产品名。URL 复用客户端已在下发的 `--fp-pinned-url`。

**分层刻意做薄**：`components/omnibox` 只加一个默认返回空串的虚函数 `GetDisplayTextOverride()` 与两处转发（共 14 行），产品逻辑全在 `chrome/` 下。本补丁集已在 `base/` 欠了一处（0008 的 `ScopedAllowBlocking` 白名单），不宜再欠一处 `components/`。

**顺着上游已有形状**：`LocationBarModelImpl` 那两个函数的第一行本就是 `if (IsContextualTasksPage()) return GetContextualTasksDisplayURL()`，即 Chromium 自己就为特殊页面替换 omnibox 显示文本；图标用委托层现成的 `GetVectorIconOverride()`。

- **按 origin 相等匹配，不是整串 URL**——管理台是单页应用，路由在 fragment 里（`#/yunlogin-environments`），整串比对一换路由即失效。**勿"优化"成整串比对。**
- **不改 `GetSecurityLevel()`**，只换图标与文字。安全等级还喂给权限决策与页面信息气泡。
- **挂锁用 `vector_icons::kLockIcon` 而非 SECURE 图标**——自 M117 起 SECURE 的字形是 page-info 控件，摆在产品名旁边像个按钮而不像陈述。

> **安全边界**：改写 omnibox 显示正是浏览器严防的欺骗行为，故规则绑死三件事——只匹配启动时传入的那个 origin、强制 loopback、只作用于顶层框架。放松成「任意 127.0.0.1」的话，本机任何进程起个服务就能取得一个带锁的可信外观。
>
> **需要说明的取舍**：管理台是明文 HTTP，本机任意进程可连，挂锁在严格意义上**高于实际保证**。这是有意识的取舍——origin 由我们自己在启动时传入、强制 loopback、且安全等级未被篡改，暴露面可控。

地址栏在显示产品名时**置为只读**：否则用户可覆盖产品名把管理台标签导航走，而端口是本次启动随机分配的，他无法重新输入回来。

验证（三次启动，端口 49871 / 52250 / 62419 均由 `listen(0)` 分配）：显示产品名 ✅ 挂锁 ✅ 点击不露出 URL 且不可输入 ✅ 换 hash 路由仍显示产品名 ✅ `/settings` 子路径仍显示产品名 ✅ **反例：新标签页 `example.com` 正常显示域名 ✅**

> 反例是验收重点：前五条只证明「能改」，第六条才证明「不会乱改」——匹配规则若放松，前五条照样全过，而用户会发现访问任何网站地址栏都变成产品名。

不传 `--fp-console-title` 时行为完全不变，客户端可自行决定何时下发。

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
