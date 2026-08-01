// 拒绝在陈旧内核上跑：同步未走完时 sync-kernel-run.ps1 会留下 STALE。
// 没有这道检查的话，「同步失败」只是一条没人读的日志 —— 今天已经因此白测过两轮。
if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('✗ D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。先跑 build-and-sync.sh。')
  process.exit(1)
}

// 验证：上次启动遗留的管理台固定标签会被清理，且只清它。
//
// 复现真实成因：管理台端口由 listen(0) 分配，每次不同；客户端在某些路径上是
// 杀进程而非正常关闭，profile 里留下 exit_type=Crashed，下次按崩溃恢复处理，
// 把上次的固定标签恢复回来 —— 于是每启动一次多积一个死标签。
//
// 关键设计：先证明累积确实发生了（会话文件里能找到多个不同端口的管理台地址），
// 再看清理结果。否则「只剩一个标签」可能只是复现失败，压根没积起来 —— 那种
// 通过和真的修好长得一模一样。

// ── 场地检查：不再无条件 taskkill ───────────────────────────────────────
//
// 按镜像名杀进程分不清「探针上次留下的残留」和「客户端此刻正开着的环境」。
// 实际发生过：一次探针运行杀掉了 21 个正在跑的内核进程，打断了另一端正在做
// 的验证。破坏性操作不该是默认行为。
//
// 改为：发现有同名进程就拒绝运行并说明，确认无关时用 PROBE_FORCE_KILL=1 显式
// 授权。保留了清残留的能力，但把「谁来决定杀」交还给人。
function ensureFieldClear(image) {
  // 只清本探针自己的 profile，按 --user-data-dir 过滤，**不按镜像名**。
  // 这台机器上客户端外壳、店铺环境、探针内核共用同一个可执行文件名，按名字杀
  // 等于无差别清场 —— 已经造成两次实际破坏。见 probe-kill.cjs 的说明。
  const { killProbeKernels, foreignKernelCount } = require('./probe-kill.cjs')
  const killed = killProbeKernels(image)
  if (killed.length) console.log(`  清掉本探针上次残留的 ${killed.length} 个进程`)
  const foreign = foreignKernelCount(image)
  if (foreign) {
    console.log(`  注意：场上还有 ${foreign} 个非本探针的 ${image}（客户端在跑）——`)
    console.log('  不影响本次测量（profile 隔离），但异常时值得先想到这一点。')
  }
}

const http = require('http')
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const KERNEL = 'D:\\chromium-work-151\\src\\out\\FingerBrowser\\yunbrowser.exe'
const PROFILE = 'D:\\chromium-work-151\\probe\\prof-stale'
const TITLE = 'YunLogin 管理中心'
const ROUNDS = 3           // 制造 3 个死标签
const CDP_PORT = 9333

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function startServer(label) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset=utf-8><title>管理台 ${label}</title>
<body style="font:16px system-ui;padding:40px"><h2>管理台 · ${label}</h2>
<p><code id=u></code></p><script>document.getElementById('u').textContent=location.href</script>`)
    })
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
  })
}

function launch(url, extra = []) {
  return spawn(KERNEL, [
    '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--fp-pinned-url=${url}`,
    `--fp-console-title=${TITLE}`,
    ...extra, url,
  ], { stdio: 'ignore' })
}

function killKernel() {
  // 杀进程而非正常关闭：正是这一步让 exit_type 停在 Crashed。
  ensureFieldClear('yunbrowser.exe')
}

function sessionConsoleUrls() {
  const dir = path.join(PROFILE, 'Default', 'Sessions')
  if (!fs.existsSync(dir)) return []
  const found = new Set()
  for (const f of fs.readdirSync(dir)) {
    const buf = fs.readFileSync(path.join(dir, f))
    // 会话文件是二进制的，URL 以可见 ASCII 存在其中，直接扫。
    const re = /http:\/\/127\.0\.0\.1:(\d+)\//g
    let m
    const s = buf.toString('latin1')
    while ((m = re.exec(s)) !== null) found.add(m[1])
  }
  return [...found]
}

async function cdpTabs() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const all = await res.json()
  return all.filter(t => t.type === 'page')
}

;(async () => {
  killKernel()
  fs.rmSync(PROFILE, { recursive: true, force: true })

  const ports = []
  for (let i = 1; i <= ROUNDS; i++) {
    const { server, port } = await startServer(`第 ${i} 次启动`)
    ports.push(port)
    console.log(`第 ${i} 次启动：端口 ${port}`)
    launch(`http://127.0.0.1:${port}/`)
    await sleep(9000)          // 等页面加载并写入会话
    killKernel()               // 制造 Crashed
    await sleep(2500)
    server.close()             // 服务关掉 —— 这个标签自此是死链接
  }

  const accumulated = sessionConsoleUrls()
  console.log(`\n【前提检查】会话文件里出现过的管理台端口: ${accumulated.join(', ')}`)
  const staleSeen = ports.filter(p => accumulated.includes(String(p)))
  if (staleSeen.length < 2) {
    console.log(`✗ 复现失败：只找到 ${staleSeen.length} 个旧端口，累积没发生。`)
    console.log(`  此时无论结果如何都不能作为修复的证据。`)
    killKernel(); process.exit(1)
  }
  console.log(`✓ 累积确已发生：${staleSeen.length} 个旧启动的管理台被会话保留\n`)

  const { server, port } = await startServer('本次')
  console.log(`最后一次启动：端口 ${port}（本次唯一活着的管理台）`)
  launch(`http://127.0.0.1:${port}/`, [`--remote-debugging-port=${CDP_PORT}`])
  await sleep(10000)

  let tabs = []
  try { tabs = await cdpTabs() } catch (e) { console.log('CDP 取标签失败：' + e.message) }

  console.log(`\n【结果】当前标签数: ${tabs.length}`)
  tabs.forEach(t => console.log(`   ${t.url}`))

  const live = tabs.filter(t => t.url.includes(`:${port}/`))
  const dead = tabs.filter(t => ports.some(p => t.url.includes(`:${p}/`)))

  console.log(`\n本次管理台(应为 1): ${live.length}`)
  console.log(`遗留死标签(应为 0): ${dead.length}`)
  console.log(dead.length === 0 && live.length === 1 ? '\n★ 通过' : '\n★ 未通过')

  killKernel(); server.close(); process.exit(0)
})()
