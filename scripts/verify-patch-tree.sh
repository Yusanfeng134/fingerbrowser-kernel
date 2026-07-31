#!/usr/bin/env bash
#
# 验证补丁队列能否从干净基线字节级重现内核树。
#
# 用法：  ./scripts/verify-patch-tree.sh 151
#         ./scripts/verify-patch-tree.sh 124
#
# ── 这个脚本存在的理由 ──────────────────────────────────────────────────
#
# 「补丁全部干净应用」不是充分检查。实际发生过：19 个补丁全部干净应用，树却差
# 两行 —— 一个文件被两方改过，归属规则把它判给了其中一方，另一方那两行掉出了
# 整个补丁集。两边各自都对，合起来漏了。
#
# 所以判据是**树哈希相等**，不是「应用成功」。
#
# ── 为什么必须把「没覆盖到的」大声说出来 ────────────────────────────────
#
# 124 的补丁 0001/0002 改的是 third_party/libc++/src 与 third_party/angle ——
# gclient 的 DEPS 子仓，主仓索引里根本没有它们的文件。拿主仓做树比对，这两个
# 补丁**在结构上无法被覆盖**。
#
# 天真的写法是让它们应用失败、然后报「✗ 不一致」。那样 124 会永远红，而一个
# 永远红的检查比没有检查更糟：人会学会忽略它，然后真正的不一致也一起被忽略。
#
# 另一种天真写法是静默跳过、照常打印「★ 一致」。那更糟 —— 通过条件被一个与被测
# 对象无关的前提满足了，正是本仓库反复记录的那类假通过。
#
# 这里的做法：**分类、覆盖、并且每次都把未覆盖的列出来**。结论行永远是
# 「N 个已覆盖且一致，M 个结构上无法覆盖」，不存在一句光秃秃的「一致」。
#
# 分类依据是 checkout 自己的 DEPS，不是硬编码清单 —— 硬编码的清单在 DEPS 变动
# 时不会失败，只会悄悄错。

set -euo pipefail

KERNEL="${1:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$KERNEL" in
  151) SRC=/d/chromium-work-151/src;      PATCHDIR="$ROOT_DIR/patches-151" ;;
  124) SRC=/d/chromium-work/chromium/src; PATCHDIR="$ROOT_DIR/patches" ;;
  *)   echo "用法: $0 <151|124>" >&2; exit 2 ;;
esac

# 基线修订：补丁目录内的优先（151 是这样），否则回落到仓库根（124 是这样）。
# 先判存在再读 —— `< 不存在的文件` 的报错是 bash 自己发的，tr 上的 2>/dev/null
# 拦不住，会在 124 的正常路径上留一行噪音。
if [ -f "$PATCHDIR/CHROMIUM_BASE_REVISION" ]; then
  BASE="$(tr -d '[:space:]' < "$PATCHDIR/CHROMIUM_BASE_REVISION")"
elif [ -f "$ROOT_DIR/CHROMIUM_BASE_REVISION" ]; then
  BASE="$(tr -d '[:space:]' < "$ROOT_DIR/CHROMIUM_BASE_REVISION")"
else
  echo "✗ 找不到 CHROMIUM_BASE_REVISION（查过 $PATCHDIR/ 与 $ROOT_DIR/）" >&2; exit 1
fi

[ -d "$SRC/.git" ] || { echo "✗ 找不到 $KERNEL 的源码树: $SRC" >&2; exit 1; }
cd "$SRC"
git rev-parse --verify "$BASE" >/dev/null 2>&1 || {
  echo "✗ 基线修订 $BASE 不在 $SRC 的本地仓库里。先 git fetch --tags。" >&2; exit 1; }

shopt -s nullglob
PATCHES=("$PATCHDIR"/0*.patch)
[ ${#PATCHES[@]} -gt 0 ] || { echo "✗ $PATCHDIR 里没有补丁" >&2; exit 1; }

# ── 1. 从 DEPS 取受管前缀 ──────────────────────────────────────────────
# 用 checkout 自己的 DEPS 而不是硬编码：硬编码在 DEPS 变动时不会失败，只会悄悄错。
# `|| true`：grep 无匹配时返回 1，配上 pipefail 会让这个赋值失败，而 set -e 会
# 就地**静默**杀掉脚本 —— 没有任何输出，只有退出码 1。写这个脚本时真踩到了：
# 151 那半一声不吭地退出，124 那半正常，差点当成「151 没问题」。
# 失败必须由下面那句显式检查来报，不能由 set -e 无声代劳。
DEPS_PREFIXES="$( { git show "$BASE:DEPS" 2>/dev/null \
  | grep -oE "^[[:space:]]*'src/[^']+':" | sed "s|^[[:space:]]*'src/||; s|':$||" | sort -u; } || true )"
[ -n "$DEPS_PREFIXES" ] || { echo "✗ 从 DEPS 解析不出任何受管前缀 —— 解析规则可能已失效，不能继续。" >&2; exit 1; }

is_deps_managed() {  # $1 = 补丁里的文件路径
  local p="$1"
  while [ "$p" != "." ] && [ "$p" != "/" ] && [ -n "$p" ]; do
    if grep -qxF "$p" <<< "$DEPS_PREFIXES"; then return 0; fi
    p="$(dirname "$p")"
  done
  return 1
}

# ── 2. 逐个补丁分类 ────────────────────────────────────────────────────
COVERABLE=(); UNCOVERABLE=(); MIXED=()
for p in "${PATCHES[@]}"; do
  # 从 `diff --git a/X b/Y` 取路径，不用 `+++ b/`：**二进制补丁没有 `+++` 行**
  # （0015 换 exe 图标就是），只认 `+++` 会把它们当成「没有目标路径」。
  paths="$( { grep -oE '^diff --git a/.+ b/[^[:space:]]+$' "$p" \
              | sed -E 's|^diff --git a/.+ b/||'; } || true )"
  [ -n "$paths" ] || { echo "✗ $(basename "$p") 里找不到任何目标路径 —— 不是标准 diff？" >&2; exit 1; }
  n_deps=0; n_main=0
  while IFS= read -r f; do
    if is_deps_managed "$f"; then n_deps=$((n_deps+1)); else n_main=$((n_main+1)); fi
  done <<< "$paths"

  if   [ "$n_deps" -gt 0 ] && [ "$n_main" -gt 0 ]; then MIXED+=("$(basename "$p")")
  elif [ "$n_deps" -gt 0 ];                        then UNCOVERABLE+=("$(basename "$p")")
  else                                                  COVERABLE+=("$(basename "$p")")
  fi
done

# 混合补丁没有正确的处理方式：拆开验一半会给出误导性的通过。大声失败。
if [ ${#MIXED[@]} -gt 0 ]; then
  echo "✗ 以下补丁同时改动主仓与 DEPS 子仓，无法分类验证："
  printf '    %s\n' "${MIXED[@]}"
  echo "  拆开只验主仓那半会给出误导性的通过。请把它们拆成两个补丁。"
  exit 1
fi

# ── 3. 在临时索引上应用可覆盖的补丁 ────────────────────────────────────
# 只写临时索引，全程不碰工作区。（曾用 checkout-index 毁过一次 151 工作树。）
TMP_INDEX="$(mktemp -u)"; export GIT_INDEX_FILE="$TMP_INDEX"
trap 'rm -f "$TMP_INDEX"' EXIT
git read-tree "$BASE"

failed=0
for name in "${COVERABLE[@]}"; do
  if ! git apply --cached --whitespace=nowarn "$PATCHDIR/$name" 2>/tmp/vpt.err; then
    echo "✗ 应用失败: $name"
    sed 's/^/      /' /tmp/vpt.err | head -3
    failed=1
  fi
done
[ "$failed" = 0 ] || { echo ""; echo "★ 失败：有补丁无法应用，树比对无意义。"; exit 1; }

BUILT="$(git write-tree)"
HEADT="$(git rev-parse HEAD^{tree})"

# ── 4. 报告 ────────────────────────────────────────────────────────────
echo "内核 $KERNEL   基线 $BASE"
echo "  已覆盖 ${#COVERABLE[@]} 个补丁"
echo "  补丁树 $BUILT"
echo "  HEAD树 $HEADT"

# 未覆盖清单每次都打印，即使为空 —— 「本次没有未覆盖项」和「脚本忘了检查」
# 必须长得不一样。
if [ ${#UNCOVERABLE[@]} -gt 0 ]; then
  echo "  ⚠ 结构上无法覆盖 ${#UNCOVERABLE[@]} 个（改的是 DEPS 子仓，不在主仓索引内）："
  printf '      %s\n' "${UNCOVERABLE[@]}"
  echo "      这几个补丁本脚本**没有验过**。要验它们得在对应子仓里单独做。"
else
  echo "  未覆盖 0 个（所有补丁都在主仓内）"
fi

echo ""
if [ "$BUILT" = "$HEADT" ]; then
  if [ ${#UNCOVERABLE[@]} -gt 0 ]; then
    echo "★ ${#COVERABLE[@]} 个已覆盖补丁字节级重现 HEAD；另有 ${#UNCOVERABLE[@]} 个未经验证。"
  else
    echo "★ 全部 ${#COVERABLE[@]} 个补丁字节级重现 HEAD。"
  fi
  exit 0
else
  echo "✗ 不一致 —— 补丁重建不出当前内核。差异："
  unset GIT_INDEX_FILE
  git diff --stat "$BUILT" HEAD^{tree} | tail -25 | sed 's/^/    /'
  exit 1
fi
