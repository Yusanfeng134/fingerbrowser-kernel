// 逐项核对账号面板的链接：不只验「能打开一个标签页」，而是验**落地页是不是它
// 声称的那个**。
//
// 起因是一条真实的假通过：面板里的「设置」指向 #/settings，而管理台没有这个
// 路由；SPA 的兜底 <Route path="*"> 接住它，最终显示环境管理。**能点、有反应、
// 页面也正常渲染，只是去错了地方。**
//
// 只验「每一项都能打开一个标签页」时这条必然通过 —— 因为它确实打开了一个标签页。
// 通过条件被一个与被测属性无关的前提满足了：打开成功 ≠ 去对了地方。
if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('✗ D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。先跑 build-and-sync.sh。')
  process.exit(1)
}


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
const WebSocket = require('ws')

const KERNEL = 'D:/yunbrowser-run/yunbrowser.exe'
const PROFILE = 'D:/chromium-work-151/probe/prof-panel-links'
const CDP = 9633
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 管理台声称支持的路由。假管理台只对这些返回内容，其余一律返回 404 —— 不设
// 兜底路由，这样「指向不存在的路由」会明确失败，而不是被兜底页悄悄接住。
const ROUTES = new Set(['', 'yunlogin-environments', 'proxies', 'account'])

;(async () => {
  ensureFieldClear('yunbrowser.exe')
  await sleep(1500)

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    // 路由在 fragment 里，服务端看不到 —— 由页面脚本自行判定并写入标记元素。
    res.end(`<!doctype html><meta charset=utf-8><title>管理台</title><body>
<div id="route"></div>
<script>
  const known = ${JSON.stringify([...ROUTES])};
  const r = location.hash.replace(/^#\\/?/, '');
  document.getElementById('route').textContent =
      known.includes(r) ? ('OK:' + (r || '(首页)')) : ('NOROUTE:' + r);
</script>`)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const consoleUrl = `http://127.0.0.1:${srv.address().port}/`

  spawn(KERNEL, ['--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP}`,
    '--fp-shell', '--fp-account-panel', '--fp-account-initial=测试',
    `--fp-pinned-url=${consoleUrl}`, '--fp-console-title=YunLogin 管理中心',
    consoleUrl], { stdio: 'ignore' })
  await sleep(11000)

  // 从面板页面里读出所有链接及其文案 —— 面板有几项、指向哪里，由面板自己说，
  // 脚本不硬编码一份清单（否则面板加项时这里不会失败，等于漏测）。
  // 面板的 WebContents 只在用户点头像时才创建，启动时并不存在。这里直接在标签页
  // 里打开同一个 chrome:// 地址 —— 本审计验的是**链接目标**，那是页面内容，与宿主
  // 是气泡还是标签页无关。气泡本身的行为由 run-newtab/账号面板那几轮人工验。
  await fetch(`http://127.0.0.1:${CDP}/json/new?chrome://account-panel.top-chrome/`,
              { method: 'PUT' }).catch(() => null)
  await sleep(4000)

  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const panel = list.find(x => (x.url || '').startsWith('chrome://account-panel'))
  if (!panel) {
    console.log('✗ 面板页面打不开 —— --fp-account-panel 未生效或 WebUI 未注册。')
    process.exit(1)
  }
  const ws = new WebSocket(panel.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  const raw = await new Promise((resolve) => {
    ws.on('message', m => { const d = JSON.parse(m); if (d.id === 1) resolve(d.result?.result?.value) })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true,
      expression: `JSON.stringify([...document.querySelector('account-panel-app')
        .shadowRoot.querySelectorAll('a')].map(a => [a.textContent.trim(), a.getAttribute('href')]))` } }))
    setTimeout(() => resolve(null), 10000)
  })
  ws.close()

  if (!raw) { console.log('✗ 读不到面板链接'); process.exit(1) }
  const links = JSON.parse(raw)
  console.log(`\n面板共 ${links.length} 项：\n`)

  let bad = 0
  for (const [text, href] of links) {
    const hash = (href || '').split('#/')[1] || ''
    const known = ROUTES.has(hash)
    console.log(`  ${known ? '✓' : '✗'} 「${text || '(账号行)'}」 → #/${hash || '(首页)'}` +
                (known ? '' : '   ← 管理台没有这个路由'))
    if (!known) bad++
  }

  console.log(bad === 0
    ? '\n★ 全部指向真实存在的路由'
    : `\n★ ${bad} 项指向不存在的路由 —— 它们仍会「打开成功」，只是去错地方`)

  ensureFieldClear('yunbrowser.exe')
  srv.close()
  process.exit(bad === 0 ? 0 : 1)
})()
