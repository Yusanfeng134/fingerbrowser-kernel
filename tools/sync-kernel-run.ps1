# 把内核的运行时文件同步到一份独立目录，供客户端运行。
#
# 起因：客户端直接运行构建输出目录里的 yunbrowser.exe，于是它一开着，构建就写不了
# chrome.dll / dxcompiler.dll / v8_context_snapshot.bin —— 一天里打断了三次，每次都要
# 请用户关掉正在用的客户端。分开之后构建目录只用于构建。
#
# 取舍：顶层文件用「排除法」，子目录用「包含法」。
#
#   排除的只有不可能在运行时需要的东西：调试符号、静态库、ninja 状态。
#   刻意不去挑「哪些 dll 是必需的」—— chrome/installer/mini_installer/chrome.release
#   那份权威清单里就没有 dxcompiler.dll，而实测运行中的内核确实加载了它。挑清单漏一个
#   不会报错，只会让某个功能悄悄坏掉；多拷几百 MB 只是磁盘。两种错误的代价不对等。
#
#   子目录只能用包含法：obj/ 与 gen/ 有几十 GB。这一侧的漏拷风险由脚本末尾的自检兜底。
#
# 用法：构建之后跑一次。增量同步，只有变过的文件会被复制（通常就是 chrome.dll）。

param(
  [string]$Source = 'D:\chromium-work-151\src\out\FingerBrowser',
  [string]$Dest   = 'D:\yunbrowser-run'
)

$ErrorActionPreference = 'Stop'

# 输出编码定为 UTF-8：本脚本常被 bash 包装调用，默认的 GBK 输出到管道后是乱码。
# 守卫的价值全在那句报错能被读懂——读不懂的报错等于没有守卫。
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

if (-not (Test-Path $Source)) { throw "构建输出目录不存在: $Source" }

if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }

# --- 陈旧标记 ---
# 构建成功但同步失败时，目标目录里留下的是旧内核，而「一切看起来都正常」——
# 我以为改动生效了，实际在测旧二进制。今天真的发生过一次，浪费了用户两次操作。
# 当时那条「同步失败」的提示是打出来了的，我没读到。
#
# 所以把它从「一条日志」变成「下一步无法继续」：同步没走完就留下这个文件，
# 探针脚本启动前检查它并拒绝运行。防线的接收端不能是「记得去看」。
#
# 必须写在所有可能 throw 的检查**之前**。第一版写在「内核是否在跑」那个检查
# 之后，结果最常发生的那种失败恰恰不会留下标记 —— 一道正好漏掉主要失败模式的
# 防线，比没有更糟，因为它给人「已经防住了」的错觉。
$stale = Join-Path $Dest 'STALE'
Set-Content -LiteralPath $stale -Value "同步未完成，此目录中的内核可能是旧的。" -Encoding utf8

# 目标目录里若有内核在跑，复制会失败得莫名其妙 —— 先说清楚。
$running = Get-CimInstance Win32_Process -Filter "Name='yunbrowser.exe'" -EA SilentlyContinue |
           Where-Object { $_.ExecutablePath -like "$Dest*" }
if ($running) {
  throw "目标目录里的内核正在运行（$($running.Count) 个进程）。先关掉客户端再同步。"
}

# --- 沙箱 ACL ---
# Chromium 的沙箱子进程用受限令牌运行，必须能读到 exe，否则启动即
# DCHECK failed (sandbox_win.cc)，症状是「拷贝出来的内核一起就崩」，看不出跟权限有关：
#   Sandbox cannot access executable ... Check filesystem permissions are valid. (0x5)
# 构建输出目录的这条 ACE 是构建过程加的（见 patches-151/0001），新建目录没有。
#
# 用 SID 而不是名字：这个组在中文 Windows 上显示为本地化名称，按名字授权会随系统语言
# 失效 —— 与 0001 处理的是同一类问题。S-1-15-2-1 = ALL APPLICATION PACKAGES。
$acl = icacls $Dest 2>$null | Out-String
if ($acl -notmatch 'S-1-15-2-1' -and $acl -notmatch 'APPLICATION PACKAGE AUTHORITY') {
  icacls $Dest /grant '*S-1-15-2-1:(OI)(CI)(RX)' /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "授予沙箱 ACL 失败（icacls 返回 $LASTEXITCODE）" }
  "已为 $Dest 授予沙箱所需 ACL (S-1-15-2-1)"
}

# --- 顶层文件：排除法 ---
$excludeExt = @('.pdb', '.lib', '.exp', '.ilk', '.rsp', '.stamp', '.d')
$copied = 0; $skipped = 0
foreach ($f in Get-ChildItem $Source -File) {
  if ($excludeExt -contains $f.Extension) { continue }
  if ($f.Name -like '.ninja*' -or $f.Name -like '*.ninja') { continue }

  $target = Join-Path $Dest $f.Name
  # 增量：大小与写入时间都相同就跳过。chrome.dll 有 400 MB，每次全拷没必要。
  if (Test-Path $target) {
    $t = Get-Item $target
    if ($t.Length -eq $f.Length -and $t.LastWriteTimeUtc -eq $f.LastWriteTimeUtc) { $skipped++; continue }
  }
  Copy-Item $f.FullName $target -Force
  $copied++
}

# --- 子目录：包含法 ---
# 依据 chrome/installer/mini_installer/chrome.release 的运行时目录，加上实际存在的几个。
$subdirs = @(
  'locales', 'resources', 'MEIPreload', 'PrivacySandboxAttestationsPreloaded',
  'IwaKeyDistribution', 'angledata', 'Dictionaries', 'hyphen-data',
  'Extensions', 'swiftshader', 'VisualElements'
)
foreach ($s in $subdirs) {
  $src = Join-Path $Source $s
  if (-not (Test-Path $src)) { continue }
  # /MIR 让目标与源一致（含删除），避免旧版本残留文件被加载。
  robocopy $src (Join-Path $Dest $s) /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（子目录 $s，代码 $LASTEXITCODE）" }
}

# --- 自检 ---
# 不检查「拷了多少个」，那说明不了什么。检查几个缺了必然出问题、且今天真被锁过的文件。
$mustHave = @(
  'yunbrowser.exe', 'chrome.dll', 'v8_context_snapshot.bin', 'icudtl.dat',
  'resources.pak', 'chrome_100_percent.pak', 'dxcompiler.dll',
  'yunbrowser.capabilities.json'
)
$missing = $mustHave | Where-Object { -not (Test-Path (Join-Path $Dest $_)) }
if ($missing) { throw "同步后缺少必需文件: $($missing -join ', ')" }
if (-not (Test-Path (Join-Path $Dest 'locales\en-US.pak'))) { throw "同步后缺少 locales\en-US.pak" }

# 走到这里说明文件复制与自检都过了，撤掉陈旧标记。
Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue

$size = (Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
"同步完成: {0} -> {1}" -f $Source, $Dest
"  复制 {0} 个，跳过（未变）{1} 个" -f $copied, $skipped

# 报出本次实际更新了哪些关键产物。
#
# 起因是一次差点下错的结论：我习惯用 chrome.dll 的时间戳判断「内核是不是最新」，
# 但**纯资源改动（.ts/.html/.grd）不进 chrome.dll，只进 resources.pak**。改了前端
# 却看到 chrome.dll 没动，按那个判据会得出「没同步」——方向与漏读日志那次相反，
# 错得一样彻底。判据本身盲，比忘了看更难发现。
foreach ($n in 'yunbrowser.exe', 'chrome.dll', 'resources.pak') {
  $f = Join-Path $Dest $n
  if (Test-Path $f) {
    "  {0,-20} {1}" -f $n, (Get-Item $f).LastWriteTime.ToString('MM-dd HH:mm:ss')
  }
}
"  目标大小 {0:N0} MB" -f $size
""
"客户端应指向: {0}\yunbrowser.exe" -f $Dest

# robocopy 复制成功也返回 1（表示「有文件被复制」），会残留在 $LASTEXITCODE 里，
# 让调用方误以为脚本失败。上面已按 >=8 判过真正的失败。
exit 0
