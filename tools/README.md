# 构建与同步工具

## `build-and-sync.sh`

构建内核，成功后同步到客户端实际运行的那份目录。

```bash
./tools/build-and-sync.sh          # 默认目标 chrome
```

**为什么构建与同步必须绑在一起**：客户端跑 `D:\yunbrowser-run`（由
`voyager-settings.json` 的 `kernels` 注册表条目指向），不再是构建输出目录。构建完
若忘了同步，客户端就在跑旧内核，而**一切看起来都正常** —— 开发侧以为改动生效了，
客户端侧以为在测新内核，两边都不会报错。靠记性挡不住，所以绑进构建收尾。

`-j 14` 而非按核数开满：32 核默认并发下，blink 的 mojom/bindings 每个任务能吃
好几 GB，近全量重建时峰值会打穿 64 GB，报 `LLVM ERROR: out of memory`。

失败时不用 `tail` 取错误：ninja 失败后仍会继续跑其它目标，真正的报错会被后续
进度行冲掉。改为 `grep` 失败特征。

## `sync-kernel-run.ps1`

把内核的运行时文件同步到独立目录，使构建目录只用于构建。

**顶层文件用排除法，子目录用包含法。** 排除的只有不可能在运行时需要的东西（调试
符号、静态库、ninja 状态）。刻意不去挑「哪些 dll 是必需的」——
`chrome/installer/mini_installer/chrome.release` 那份权威清单里就没有
`dxcompiler.dll`，而实测运行中的内核确实加载了它。挑清单漏一个不会报错，只会让某
个功能悄悄坏掉；多拷几百 MB 只是磁盘。两种错误的代价不对等。

### 沙箱 ACL

拷完文件后**内核仍会一起就崩**，退出码 `STATUS_BREAKPOINT`：

```
Sandbox cannot access executable ... Check filesystem permissions are valid. (0x5)
DCHECK failed: sandbox\policy\win\sandbox_win.cc
```

Chromium 的沙箱子进程用受限令牌运行，必须能读到 exe。构建输出目录的这条 ACE 是
构建过程加的（见 `patches-151/0001`），新建目录没有。两边 `icacls` 一比，差异只有
一行。

授权用 **SID `S-1-15-2-1`（ALL APPLICATION PACKAGES）而不是名字** —— 该组在中文
Windows 上显示为本地化名称，按名字授权会随系统语言失效。与 0001 是同一类问题。

> 只检查「文件拷全了」会交付一个一启动就崩、且报错完全看不出跟权限有关的内核。

### `STALE` 标记

同步未走完时在目标目录留下 `STALE`，`probe/` 下的脚本启动即拒绝运行。把「同步
失败」从一条日志变成下一步无法继续 —— 防线的接收端不能是「记得去看」。

两个已修的洞：

1. 第一版写在「内核是否在跑」检查之后 —— 最常发生的那种失败恰好不留标记。
2. 构建失败时同步脚本根本不被调用 —— 由 `build-and-sync.sh` 自己补写。

### 报出关键产物时间戳

同步末尾打印 `yunbrowser.exe` / `chrome.dll` / `resources.pak` 各自的时间。

起因是一次差点下错的结论：习惯用 `chrome.dll` 的时间戳判断「内核是不是最新」，但
**纯前端改动（`.ts`/`.html`/`.grd`）不进 `chrome.dll`，只进 `resources.pak`**。改了
前端却看到 `chrome.dll` 没动，按那个判据会得出「没同步」——方向与漏读日志那次相反，
错得一样彻底。

> 判据本身是瞎的，比忘了看更难发现：忘了看至少还有信号，判据错了则是信号本身在
> 骗人。

## 编码

两个 `.ps1` 都必须存为 **UTF-8 with BOM**。Windows PowerShell 5.1 按系统 ANSI
（中文机器上是 GBK）读无 BOM 的 `.ps1`，中文注释变乱码后直接解析失败。同族问题见
`patches-151/0012`。
