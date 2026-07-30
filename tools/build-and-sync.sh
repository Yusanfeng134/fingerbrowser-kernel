#!/usr/bin/env bash
# 构建内核，成功后立刻同步到客户端实际运行的那份目录。
#
# 为什么必须绑在一起：客户端现在跑 D:\yunbrowser-run（voyager-settings.json 的
# kernels 注册表条目指向那里），不再是构建输出目录。构建完若忘了同步，客户端
# 就在跑旧内核，而**一切看起来都正常** —— 我以为新改动生效了，客户端以为在测
# 新内核，两边都不会报错。这是个静默失败，靠记性挡不住，所以绑进构建收尾。
#
# 客户端侧的另一道防线：app:status 的 kernel.builtAt 显示内核构建时间，
# 让「在跑哪个内核」成为可观察事实而不是推断。两道一起才挡得住。
#
# 用法：  ./build-and-sync.sh  [ninja 目标，默认 chrome]

set -uo pipefail

SRC=/d/chromium-work-151/src
OUT=out/FingerBrowser
TARGET="${1:-chrome}"
LOG=/d/chromium-work-151/build.log
SYNC='D:\chromium-work-151\sync-kernel-run.ps1'

export DEPOT_TOOLS_WIN_TOOLCHAIN=0
export PATH="/d/depot_tools:$PATH"

cd "$SRC" || { echo "找不到 $SRC"; exit 1; }

# -j 14 而不是默认按核数开满：32 核默认并发下，blink 的 mojom/bindings 每个任务
# 能吃好几 GB，近全量重建时峰值会把 64 GB 打穿，报 LLVM ERROR: out of memory。
echo "构建 $TARGET ..."
autoninja -C "$OUT" -j 14 "$TARGET" > "$LOG" 2>&1
RC=$?

if [ $RC -ne 0 ]; then
  # 构建失败时同步脚本根本不会被调用，于是它写的那个 STALE 标记也不存在 ——
  # 探针照跑不误，在旧内核上得出「改动没生效」的结论。这是 STALE 机制的第二个
  # 洞，与第一个同源：标记只覆盖了「同步失败」，没覆盖「没走到同步」。
  #
  # 一道防线漏掉某条失败路径时，它在那条路径上不是失效，而是**主动提供虚假的
  # 安全感** —— 因为其余路径都正常，人会认为它在工作。
  echo "同步未发生：构建失败，此目录中的内核是上一次成功构建的。" > /d/yunbrowser-run/STALE
  echo "★ 构建失败（退出码 $RC）。前几条错误："
  # 不用 tail：ninja 失败后仍会继续跑其它目标，真正的报错会被后续进度行冲掉。
  grep -nE "^FAILED:|error C[0-9]|LLVM ERROR|UnicodeDecodeError|undefined symbol|LNK[0-9]{4}" "$LOG" | head -8
  echo "完整日志：$LOG"
  echo "★ 未同步 —— 客户端仍在跑上一个可用版本。"
  exit $RC
fi

echo "构建成功，同步到客户端运行目录 ..."
powershell -NoProfile -ExecutionPolicy Bypass -File "$SYNC"
SRC_RC=$?
if [ $SRC_RC -ne 0 ]; then
  echo "★ 构建成功但同步失败 —— 客户端仍在跑旧内核，别以为改动生效了。"
  exit $SRC_RC
fi

echo
echo "★ 完成。客户端下次启动即为本次构建。"
echo "  可在客户端 app:status 里核对 kernel.builtAt 是否为刚才这次。"

# 同步脚本在未走完时会在目标目录留下 STALE。这里再确认一次它确实没了 ——
# 上面那句「完成」若与 STALE 同时存在，说明脚本的成功判定本身错了。
if [ -f /d/yunbrowser-run/STALE ]; then
  echo "★★ 矛盾：脚本报成功，但 STALE 标记仍在。不要相信上面那句「完成」。"
  exit 1
fi
