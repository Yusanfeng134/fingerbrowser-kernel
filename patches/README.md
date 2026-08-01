# patches — FingerBrowser 指纹补丁（Chromium 124）

基线 **124.0.6367.207**（见根目录 `CHROMIUM_BASE_REVISION`）。与 `../patches-151/`
并列，互不影响；客户端按内核版本选择对应补丁集构建的二进制。

## 应用与验证

```bash
cd <chromium-src>   # git checkout refs/tags/124.0.6367.207
for p in patches/0*.patch; do git apply "$p"; done
```

验证用仓库根的脚本，**不要只看「补丁全部干净应用」**：

```bash
./scripts/verify-patch-tree.sh 124
```

当前结果：**红**。这是**已知且有意的**，不是漏导出 ——

```
✗ 不一致 —— 13 个文件 / +691 行不在任何补丁里
```

那 691 行是 fp-passkey 移植（提交 `a8089735c3`），**目前只有编译验证、行为一次
没验过**：链接被一台机器上的僵尸进程堵着（它锁住 `v8_context_snapshot.bin`，
`taskkill` 报「无此任务」而 `Get-CimInstance` 说它还在，只有重启能清）。

补丁集里每条的提交消息都写着「验证通过」。在 passkey 这条上那句话还不成立，
所以**先入库、不导出**。等能链接、跑完红转绿对照后再导出为 0013，届时本节删除。

**记在这里的理由**：一小时前这个检查还是绿的。红得有理由、可解释，但下一个人
跑到它时只看得见红，分不清「已知的有意的」和「又漏了一次」。一个总是红的检查
会被学会忽略，而那正是它失效的方式。

在此之前的状态是：10 个已覆盖补丁字节级重现 HEAD，另有 2 个结构上无法覆盖（见下）。

## 补丁清单

| # | 补丁 | 关注点 | 说明 |
|---|---|---|---|
| 0001 | xcode26-max-align-compat | Mac 构建 | `third_party/libc++`（**DEPS 子仓**）|
| 0002 | xcode26-metal-toolchain-xcrun | Mac 构建 | `third_party/angle`（**DEPS 子仓**）|
| 0003 | xcode26-accessibility-availability | Mac 构建 | `ui/accessibility` |
| 0004 | xcode26-browser-accessibility-constants | Mac 构建 | `content/browser` |
| 0005 | xcode26-accelerate-compat | Mac 构建 | `third_party/blink` |
| 0006 | suppress-google-api-keys-infobar | 去横幅 | API key 缺失提示条 |
| 0007 | fingerbrowser-policy-infrastructure | 基础设施 | 策略解析、开关下发、渲染进程白名单、渲染侧头文件。**后五个补丁全部依赖它** |
| 0008 | fingerbrowser-hardware-identity | 硬件身份 | platform、并发数、内存、WebGL 厂商、WebGPU、UA 品牌与 platformVersion |
| 0009 | fingerbrowser-regional-persona | 区域人格 | 时区、`navigator.language(s)`、Accept-Language、CJK 字体屏蔽 |
| 0010 | fingerbrowser-screen-dpr-touch-geo | 屏幕/定位 | `screen.*`、DPR、maxTouchPoints、`device-width` 媒体查询、地理位置 |
| 0011 | fingerbrowser-canvas-audio-noise | canvas/音频 | 确定性扰动（**不是随机噪声**）|
| 0012 | fingerbrowser-webrtc-ip-policy | WebRTC | IP 处理策略枚举化 |

顺序不可打乱：0007 是其余五个的硬前提。

## 0007-0012 是重新生成的

此前 0007/0008/0009 三个补丁描述的是一个更早的状态，**从未被验证过能重现任何
东西**。2026-07-31 第一次做全树比对，结果是 584 行 / 16 个文件不在任何补丁里
—— 含 WebGPU、字体、canvas、WebRTC、时区、UA 等核心工作。换句话说**当时的 124
内核不可重建**。

不采用「在旧的三个之上再叠六个」，因为增量里包含对 0007 的**改写**（头文件里
`PerturbPixels` 被删除并替换成 `PerturbPixelsAt`），叠加需要把 152 行的共享头
文件按 hunk 切给四个特性 —— 那正是 `../patches-151/README.md` 记的那次
「19 个补丁全部干净应用、树却差两行」的成因形状。

改为保留与指纹无关的 0001-0006，把 0007-0009 整体重新生成为上表这六个。

**共享头文件 `fingerbrowser_fingerprint.h` 整体归入 0007**，其余补丁只碰自己的
`.cc`。代价是补丁之间的中间态不可编译（声明先到、调用点后到）；补丁是批量应用
后再构建，最终状态可编译，但这个性质值得写明。

**原 0008/0009 的提交消息丢了。** 那两个文件从未入过版本控制（一直是未跟踪
状态），重新生成时被直接删除，删之前没有读过。新补丁的消息是依据代码审计的
特征描述、`../patches-151/README.md` 里同类特性的记录，以及当时的上下文重写的
——**不是从它们那里搬运的**，因此原作者若在那两条消息里写过某个决定的理由，
现在已经无法找回。

记在这里而不是含糊带过：这批补丁的价值一半在代码、一半在「为什么这么写」，
而后者刚刚丢了两条。同类操作以后先读再删。

## 为什么有两个补丁「结构上无法覆盖」

0001 改 `third_party/libc++/src`，0002 改 `third_party/angle` —— 都是 gclient 的
DEPS 子仓，主仓索引里没有它们的文件。拿主仓做树比对，这两个补丁**在结构上无法
被覆盖**。

脚本对此的处理是**分类、覆盖、并且每次都把未覆盖的列出来**。两种天真写法都会
毁掉这个检查：让它们应用失败报「不一致」→ 124 永远红，人会学会忽略；静默跳过
照常报「一致」→ 通过条件被一个与被测对象无关的前提满足了。

要验这两个，得在对应子仓里单独做。目前没做。

## 已知欠账（按危害排）

这些是导出时就知道存在的问题。**补丁按现状导出、不夹带修复** —— 否则「这是原样
导出」和「这里我顺手改了」会混在同一条提交里说不清，而下一个人无法区分哪些行是
历史、哪些是新决定。

1. **策略解析不读 `devicePixelRatio` / `maxTouchPoints`** —— `fp-dpr-x1000` 恒为
   兜底值、`fp-max-touch-points` 永不下发，0010 里的渲染侧代码是死的。实测本机
   `navigator.maxTouchPoints` 漏出真值 10，而人格声称桌面 —— 这是**矛盾**不是
   未伪装。151 已在 0032 修复，124 的对应修复需要一次构建验证后单独提交。
2. ~~**canvas 越界读**~~ —— **已修**（124 树提交 `2676570511`），同样只有编译
   验证、尚未导出补丁。缺陷实测复现过：256 个越界像素里 9 个有非零 RGB 而 alpha
   全零。探针 `probe/run-canvas-oob.cjs` 红转绿两侧都验过。
3. **单元测试跑不过** —— `fingerbrowser_policy_unittest.cc` 仍断言
   `switches::kForceWebRtcIPHandlingPolicy`，实现已改为 `fp-webrtc-ip-policy`。
4. **缺 151 的 Accept-Language pref 修复** —— profile pref
   `language::prefs::kAcceptLanguages` 仍持有宿主 locale，直接读它的消费者
   （尤其 ReduceAcceptLanguage 委托）可能把宿主 locale 盖回线上。
5. **CSS `(pointer)` / `(any-pointer)` 未伪装** —— 与 maxTouchPoints 同族，半边工程。
6. **`fp-do-not-track` / `fp-brand` 有声明无消费者** —— 惰性死开关。
7. **`gpu_adapter.cc` 的注释引用了 151 才有的 `info` 属性** —— 从 151 补丁抄来的
   假说明，124 的 `GPUAdapter` 没有这个成员。
8. ~~**`fp-passkey` 尚未从 151 移植**~~ —— **已移植**（124 树提交 `a8089735c3`），
   但只有编译验证、行为未验、尚未导出补丁，见本文开头。

   **症状：无认证器时 `navigator.credentials.create()` 挂起，既不 resolve 也不
   reject。** 实测覆盖 124 与 151、headless 与有窗口、三种 `userVerification`、
   有无用户手势、真实 HTTPS 源（figma.com）与 `localhost` —— 全部挂起。

   连 `publicKey.timeout` 都不触发（设 20s，35s 后仍挂着）：**请求根本没有进入
   那条会超时的路径**，不是「等到超时再失败」。

   > **这一条曾被改错过一次，记下来免得重演。** 客户端一度报告「真实站点上是
   > 1ms `NotAllowedError`，不是挂起」，我据此把文档改成「症状随条件变化」。
   > 那个读数取自 `location.reload()` 之后的页面 —— 而 **reload 不取消浏览器侧
   > 还挂着的 WebAuthn 请求**，后续请求撞上「已有请求在处理中」被立刻拒绝，
   > 产生一个快速、精确、看起来很可信的错误。改用**从未发过 WebAuthn 的全新
   > 标签页**重测，2×2 四格全部挂起。
   >
   > 我当时逐项排除了四个候选成因仍复现不出对方的结果。**那本身就是证据**：
   > 一个反复复现的测量与一个复现不出的单次测量，不该被等量齐观。当时我把
   > 「污染」这个可能只用在了自己的数据上，没用在对方的数据上。

第 1、2 条是可被检测方观察到的，其余是内部质量问题。
