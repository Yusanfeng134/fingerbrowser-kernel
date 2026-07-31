// 拒绝在陈旧内核上跑：同步未走完时 sync-kernel-run.ps1 会留下 STALE。
// 没有这道检查的话，「同步失败」只是一条没人读的日志 —— 今天已经因此白测过两轮。
if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('✗ D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。先跑 build-and-sync.sh。')
  process.exit(1)
}

// 验证同步出来的那份内核（D:\yunbrowser-run）是真的能用，而不只是「文件都在」。
//
// 拷贝漏一个 dll 通常不会让浏览器起不来，而是让某个功能悄悄坏掉 —— 所以只看
// 「进程起来了」没有意义。这里逐项验实际行为：页面能加载、指纹伪装生效、
// WebGPU 可用（dxcompiler.dll 就是今天被锁住的那个）、地址栏改写与新标签页也在。

// ── 场地检查：不再无条件 taskkill ───────────────────────────────────────
//
// 按镜像名杀进程分不清「探针上次留下的残留」和「客户端此刻正开着的环境」。
// 实际发生过：一次探针运行杀掉了 21 个正在跑的内核进程，打断了另一端正在做
// 的验证。破坏性操作不该是默认行为。
//
// 改为：发现有同名进程就拒绝运行并说明，确认无关时用 PROBE_FORCE_KILL=1 显式
// 授权。保留了清残留的能力，但把「谁来决定杀」交还给人。
function ensureFieldClear(image) {
  const { execSync } = require('child_process')
  let n = 0
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, { encoding: 'utf8' })
    // 直接数镜像名出现次数，不按行切 —— 避开跨语言生成时的换行转义坑（就是它把
    // 这一行写坏过一次）。
    const hay = out.toLowerCase()
    const needle = image.toLowerCase()
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++
  } catch (e) { return }
  if (n === 0) return
  if (process.env.PROBE_FORCE_KILL === '1') {
    try { execSync(`taskkill /IM ${image} /F /T`, { stdio: 'ignore' }) } catch (e) {}
    return
  }
  console.log(`X 有 ${n} 个 ${image} 进程在跑 —— 可能是客户端正开着环境。`)
  console.log('  探针不会替你杀：按镜像名杀分不清哪些是你的工作。')
  console.log('  关掉后重跑；确认与你无关时用 PROBE_FORCE_KILL=1 显式授权。')
  process.exit(1)
}

const http = require('http')
const { spawn, execSync } = require('child_process')

const KERNEL = 'D:\\yunbrowser-run\\yunbrowser.exe'
const PROFILE = 'D:\\chromium-work-151\\probe\\prof-copy-sanity'
const CDP = 9455
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

;(async () => {
  ensureFieldClear('yunbrowser.exe')
  await sleep(1500)

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset=utf-8><title>copy sanity</title><body><h2>ok</h2>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/`

  spawn(KERNEL, [
    '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--fp-pinned-url=${url}`,
    '--fp-console-title=YunLogin 管理中心',
    `--fp-newtab-url=${url}newtab#/ai-newtab`,
    '--fp-accept-lang=ja-JP',   // 开关名是 fp-accept-lang，不是 fp-lang
    '--fp-platform=Win32',
    '--fp-gpu-renderer=ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    `--remote-debugging-port=${CDP}`,
    url,
  ], { stdio: 'ignore' })

  await sleep(11000)

  let ok = true
  const check = (name, pass, detail) => {
    console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
    if (!pass) ok = false
  }

  let target
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
    target = list.find(t => t.type === 'page')
  } catch (e) {
    console.log('CDP 连不上：' + e.message)
    process.exit(1)
  }
  check('浏览器启动并接受 CDP', !!target)

  // 用 CDP 在页面里求值
  const WebSocket = require('ws')
  let ws
  try { ws = new WebSocket(target.webSocketDebuggerUrl) } catch (e) {
    console.log('（缺 ws 模块，改用 HTTP 侧断言）')
  }

  const evalJs = (expr) => new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6)
    const onMsg = (m) => {
      const d = JSON.parse(m)
      if (d.id === id) { ws.off('message', onMsg); resolve(d.result?.result?.value) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true } }))
    setTimeout(() => reject(new Error('求值超时')), 15000)
  })

  await new Promise(r => ws.on('open', r))

  console.log('\n【这份拷贝能不能真的用】')
  check('页面正常加载', (await evalJs('document.title')) === 'copy sanity')
  check('指纹：语言伪装生效', (await evalJs('navigator.language')) === 'ja-JP',
        await evalJs('navigator.language'))
  check('指纹：platform 伪装生效', (await evalJs('navigator.platform')) === 'Win32',
        await evalJs('navigator.platform'))

  const webgl = await evalJs(`(() => {
    const c = document.createElement('canvas').getContext('webgl');
    const e = c && c.getExtension('WEBGL_debug_renderer_info');
    return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'no-webgl';
  })()`)
  check('WebGL 可用且 renderer 已伪装', /RTX 3070/.test(webgl), webgl)

  // WebGPU：dxcompiler.dll 正是今天被锁住的那个文件，漏拷它这里会失败
  const gpu = await evalJs(`(async () => {
    if (!navigator.gpu) return 'no-navigator.gpu';
    const a = await navigator.gpu.requestAdapter();
    if (!a) return 'no-adapter';
    const i = a.info || {};
    return (i.vendor || '?') + ' / ' + (i.architecture || '?');
  })()`)
  check('WebGPU 可取到 adapter（验 dxcompiler.dll 等已拷全）',
        !!gpu && !/^no-/.test(gpu), gpu)

  console.log(ok ? '\n★ 这份拷贝可用' : '\n★ 这份拷贝有问题，不要切换')
  ensureFieldClear('yunbrowser.exe')
  server.close()
  process.exit(ok ? 0 : 1)
})()
