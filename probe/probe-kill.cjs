// 只杀**本探针自己起的**内核进程，按 `--user-data-dir` 过滤，不按镜像名。
//
// ── 为什么必须这样 ──────────────────────────────────────────────────────
//
// `taskkill /IM yunbrowser.exe` 打的是整个映像名。而这台机器上同时跑着：
//   · 客户端外壳（yunbrowser.exe）
//   · 客户端的店铺环境（yunbrowser.exe，另一个 profile）
//   · 探针起的内核（yunbrowser.exe）
// 三方共用同一个可执行文件名。按名字杀 = 无差别清场。
//
// **这已经造成两次实际破坏**：第一次杀掉客户端 21 个内核进程；第二次在同一天，
// 客户端连续三次被打断（5 分钟 / 32 秒 / 不定），他先怀疑了两轮自己的代码
// （「用户关了窗口」「关环境误伤外壳」）才找到我这边。
//
// ── 第二次是怎么发生的：修了实例，没修做法 ──────────────────────────────
//
// 第一次之后我给九个已提交的探针加了 ensureFieldClear（默认拒绝 +
// PROBE_FORCE_KILL=1 显式授权）。然后当天我又写了**七个临时脚本**做各种对比
// 测量，每一个都是从旧模式默写出来的裸 taskkill，零守卫。
//
// **修复落在了产物上，没落在做法上。** 守卫是「要记得用」的，而临时脚本恰恰是
// 纪律最松的地方 —— 它们「反正跑一次就删」。
//
// 所以这里换成结构性防护：杀谁由 profile 路径决定，而不是由「我记不记得加守卫」
// 决定。探针的 profile 一律在 D:/chromium-work* 下，客户端的不在，按前缀过滤
// 就不可能误伤 —— 即使下一个人照旧默写一行 taskkill，只要他用的是这个函数。

const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 查进程表。**把脚本写到临时文件再跑**，不用 `-Command "..."`：
// 那条路要穿过 bash -> node -> powershell 三层引号，`-Filter "Name='x'"` 的内层
// 引号会被吃掉，PowerShell 收到没引号的 Name=x 并报「无效查询」。而两个调用方
// 都把异常当成「没有匹配」，于是**查询失败与真的没有进程表现完全一致** ——
// 守卫悄悄退化成什么都不做，诊断还报告一切正常。实测踩过。
function queryProcesses(imageName) {
  const f = path.join(os.tmpdir(), `probe-kill-${process.pid}.ps1`)
  fs.writeFileSync(f,
    `Get-CimInstance Win32_Process -Filter "Name='${imageName}'" |\n` +
    `  Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress\n`,
    'utf8')
  try {
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${f}"`,
      { encoding: 'utf8', timeout: 30000 }).trim()
    if (!out) return []          // 真的没有同名进程
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } finally {
    try { fs.unlinkSync(f) } catch (e) {}
  }
  // 刻意不 catch：查询失败必须抛出去。**「查不到」和「没有」必须可区分** ——
  // 混为一谈正是上面那段注释描述的失效方式。
}

// 探针 profile 的根。客户端的 user-data-dir 不在这些前缀下。
const PROBE_PROFILE_PREFIXES = [
  'D:\\chromium-work',
  'D:/chromium-work',
]

// 杀掉命令行里 --user-data-dir 落在探针前缀下的进程。
// 返回被杀的 pid 列表；没有匹配就返回空数组，**不做任何事**。
function killProbeKernels(imageName) {
  const mine = queryProcesses(imageName).filter((p) => {
    const cl = p.CommandLine || ''
    return PROBE_PROFILE_PREFIXES.some((x) => cl.includes(`--user-data-dir=${x}`))
  })
  const killed = []
  for (const p of mine) {
    try {
      execSync(`taskkill /F /PID ${p.ProcessId} /T`, { stdio: 'ignore' })
      killed.push(p.ProcessId)
    } catch (e) { /* 已经退了 */ }
  }
  return killed
}

// 报告**不属于**探针的同名进程数量。调用方据此在输出里说明「场上还有别人」——
// 探针照跑没问题（profile 隔离），但异常时能少走一轮弯路。
function foreignKernelCount(imageName) {
  return queryProcesses(imageName).filter((p) => {
    const cl = p.CommandLine || ''
    return !PROBE_PROFILE_PREFIXES.some((x) => cl.includes(`--user-data-dir=${x}`))
  }).length
}

module.exports = { killProbeKernels, foreignKernelCount, PROBE_PROFILE_PREFIXES }
