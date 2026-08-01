// 拒绝在陈旧内核上跑：同步未走完时 sync-kernel-run.ps1 会留下 STALE。
// 没有这道检查的话，「同步失败」只是一条没人读的日志 —— 今天已经因此白测过两轮。
if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('✗ D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。先跑 build-and-sync.sh。')
  process.exit(1)
}

// 验证 --fp-newtab-url：新标签页打开 AI 新标签页而非原生 NTP。
//
// 同时验证一个回归：AI 新标签页由同一个本地服务提供，与管理台**同源**
// （/newtab 对 /）。地址栏改写是按 origin 判定的，若不排除，新标签页会被
// 认成管理台 —— 地址栏显示产品名且只读，用户按 Ctrl+T 后输不进网址。
//
// 哪些是程序验的、哪些必须你看，脚本里分得很清楚。地址栏是浏览器原生 UI，
// CDP 读不到，那几条只能靠眼睛 —— 不会假装自动通过。

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

const KERNEL = 'D:\\chromium-work-151\\src\\out\\FingerBrowser\\yunbrowser.exe'
const SHELL_PROFILE = 'D:\\chromium-work-151\\probe\\prof-newtab-shell'
const ENV_PROFILE = 'D:\\chromium-work-151\\probe\\prof-newtab-env'
const TITLE = 'YunLogin 管理中心'
const CDP_SHELL = 9411

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function page(title, body) {
  return `<!doctype html><meta charset=utf-8><title>${title}</title>
<body style="font:16px/1.7 system-ui;padding:40px">${body}
<p>当前地址：<code id=u></code></p>
<script>document.getElementById('u').textContent=location.href</script>`
}

function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const isNewTab = req.url.startsWith('/newtab')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(isNewTab
        ? page('AI 新标签页', '<h2>AI 新标签页</h2><p>这里是 /newtab</p>')
        : page('管理台', '<h2>管理台</h2><p>这里是 /</p>'))
    })
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
  })
}

;(async () => {
  ensureFieldClear('yunbrowser.exe')
  await sleep(1500)

  const { server, port } = await startServer()
  const consoleUrl = `http://127.0.0.1:${port}/`
  const newtabUrl = `http://127.0.0.1:${port}/newtab#/ai-newtab`

  // 外壳：传 --fp-newtab-url
  spawn(KERNEL, [
    '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${SHELL_PROFILE}`,
    `--fp-pinned-url=${consoleUrl}`,
    `--fp-console-title=${TITLE}`,
    `--fp-newtab-url=${newtabUrl}`,
    `--remote-debugging-port=${CDP_SHELL}`,
    consoleUrl,
  ], { stdio: 'ignore' })

  await sleep(9000)

  console.log(`
=========================================================
 新标签页验证

 管理台     ：${consoleUrl}
 AI 新标签页：${newtabUrl}

---------------------------------------------------------
 【需要你看】地址栏是浏览器原生 UI，CDP 读不到，以下必须肉眼确认：

 1. 在外壳窗口按 Ctrl+T
    → 应打开「AI 新标签页」，不是 Chromium 原生新标签页

 2. ★ 在这个新标签页里点地址栏，随便打几个字
    → **必须能输入**。若打不进字、或地址栏写着「${TITLE}」，
      说明同源排除失效 —— 用户会没法在新标签里输网址，
      这是比「新标签页没换」严重得多的问题。

 3. 切回第一个标签（管理台）
    → 地址栏仍应显示「${TITLE}」且只读（这条是原有行为，不能被这次改动弄坏）

---------------------------------------------------------
 【程序验】下面这条我自动查：新标签页的 URL 是否为 AI 页面。

 按完 Ctrl+T 后等几秒，结果会打印在下面。
=========================================================
`)

  // 轮询 CDP，等出现第二个标签
  let reported = false
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    let tabs = []
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_SHELL}/json/list`)
      tabs = (await r.json()).filter(t => t.type === 'page')
    } catch (e) { continue }

    if (tabs.length >= 2 && !reported) {
      reported = true
      console.log('【程序验结果】当前标签：')
      tabs.forEach(t => console.log(`   ${t.url}`))
      const hasNewTab = tabs.some(t => t.url.includes('/newtab'))
      const hasNativeNtp = tabs.some(t => t.url.startsWith('chrome://newtab') ||
                                          t.url.startsWith('chrome://new-tab-page'))
      console.log(`\n  AI 新标签页已打开: ${hasNewTab ? '✓' : '✗'}`)
      console.log(`  原生 NTP 未出现  : ${hasNativeNtp ? '✗（仍是原生）' : '✓'}`)
      console.log(hasNewTab && !hasNativeNtp ? '\n★ 程序验部分通过' : '\n★ 程序验部分未通过')
      console.log('\n（第 2、3 条仍需你确认 —— 那两条程序看不到）')
    }
  }
  server.close()
})()
