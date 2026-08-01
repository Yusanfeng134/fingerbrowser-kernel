// navigator.maxTouchPoints 与 CSS 指针媒体特征必须同进同退。
//
// ── 被测属性 ────────────────────────────────────────────────────────────
//
// 伪装 maxTouchPoints 之后，`(any-pointer: coarse)` 若仍报宿主值，就出现：
//
//     navigator.maxTouchPoints  0      ← 人格声称没有触摸
//     any-pointer: coarse       true   ← 一条媒体查询说有粗指针可用
//
// 真实的无触屏桌面报 false。这是**矛盾**不是「未伪装」：它证明的不是有没有
// 触屏，是有人动过手脚。
//
// 实测发现于本机（触屏笔记本），两个内核都有。修法是让指针类型从
// fp-max-touch-points 派生 —— **触摸能力只能有一处真相**，新开一个开关只会
// 造出「两个开关说法不一」这种更难查的形态。
//
// ── 前提：这台机器必须真的有触屏 ────────────────────────────────────────
//
// 宿主若本来就没有触屏，any-pointer:coarse 本来就是 false，那么「伪装成 0 之后
// 它是 false」什么都证明不了 —— 通过条件被一个与被测属性无关的前提满足了。
// 所以先测不带开关的基线，coarse 必须为 true，否则明确报「本机测不了这条」。
//
// ── 不测 ontouchstart ───────────────────────────────────────────────────
//
// 实测 fp-max-touch-points=0 时 ontouchstart 本来就是 false，是对的。
// patches/README 曾把它列进「三者本该同进同退」，那是把一个本就正确的项也算成
// 了问题。**清单里混进一个假项，会让人在排查时怀疑正确的代码。**

if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('X D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。')
  process.exit(1)
}

const http = require('http')
const { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.TOUCH_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureFieldClear(image) {
  let n = 0
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, { encoding: 'utf8' })
    const hay = out.toLowerCase(), needle = image.toLowerCase()
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++
  } catch (e) { return }
  if (n === 0) return
  if (process.env.PROBE_FORCE_KILL === '1') {
    try { execSync(`taskkill /IM ${image} /F /T`, { stdio: 'ignore' }) } catch (e) {}
    return
  }
  console.log(`X 有 ${n} 个 ${image} 进程在跑。关掉后重跑，或 PROBE_FORCE_KILL=1 显式授权。`)
  process.exit(1)
}

const EXPR = `JSON.stringify({
  maxTouchPoints: navigator.maxTouchPoints,
  pointerCoarse: matchMedia('(pointer: coarse)').matches,
  pointerFine: matchMedia('(pointer: fine)').matches,
  anyCoarse: matchMedia('(any-pointer: coarse)').matches,
  anyFine: matchMedia('(any-pointer: fine)').matches,
})`

async function measure(touch, port, cdp, tag) {
  ensureFieldClear(IMAGE)
  await sleep(1000)
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    r.end('<!doctype html><meta charset=utf-8><body>probe')
  })
  await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  const url = `http://localhost:${port}/`

  const args = ['--headless=new', '--no-first-run', '--disable-background-networking',
    `--remote-debugging-port=${cdp}`, `--user-data-dir=${WORKDIR}/prof-touch-${tag}`]
  if (touch !== null) args.push(`--fp-max-touch-points=${touch}`)
  args.push(url)
  const child = spawn(KERNEL, args, { stdio: 'ignore' })

  let ws = null
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500)
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()
      const p = l.find((t) => t.type === 'page')
      if (p) ws = p.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) { srv.close(); child.kill(); throw new Error(`内核未起来（touch=${touch}）`) }

  const s = new WebSocket(ws)
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej })
  const evalIn = (expr, id) => new Promise((r) => {
    s.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) r(d.result?.result?.value ?? '') }
    s.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { returnByValue: true, expression: expr } }))
  })
  // 等导航落地：target 列表的 URL 是「打算去哪」，不是「现在在哪」。
  let landed = false
  for (let i = 0; i < 40 && !landed; i++) {
    const h = await evalIn('location.href', 700 + i)
    if (String(h).startsWith(url)) landed = true; else await sleep(250)
  }
  if (!landed) { s.close(); srv.close(); child.kill(); throw new Error('导航未落地') }

  const out = await evalIn(EXPR, 1)
  s.close(); srv.close(); child.kill()
  await sleep(500)
  return JSON.parse(out)
}

function fail(msg) { console.log('X ' + msg); process.exit(1) }
const yn = (b) => (b ? 'true ' : 'false')

;(async () => {
  const base = await measure(null, 8851, 9535, 'host')
  console.log(`  基线（不传开关）  maxTouchPoints=${base.maxTouchPoints}  ` +
              `any-pointer:coarse=${yn(base.anyCoarse)}  pointer:coarse=${yn(base.pointerCoarse)}`)

  // 前提检查：宿主必须真有触屏，否则这条测不了。
  if (!base.anyCoarse) {
    console.log('')
    console.log('? 本机宿主没有粗指针（any-pointer:coarse 基线就是 false）。')
    console.log('  伪装成 0 之后它当然还是 false —— **这不能证明修复生效**，')
    console.log('  通过条件会被一个与被测属性无关的前提满足。本条在此机器上测不了。')
    process.exit(2)
  }
  if (base.maxTouchPoints === 0) {
    console.log('')
    console.log('? 宿主 maxTouchPoints 本来就是 0，同上，测不了。')
    process.exit(2)
  }

  const off = await measure(0, 8852, 9536, 't0')
  console.log(`  fp-max-touch-points=0  maxTouchPoints=${off.maxTouchPoints}  ` +
              `any-pointer:coarse=${yn(off.anyCoarse)}  any-pointer:fine=${yn(off.anyFine)}`)

  const on = await measure(5, 8853, 9537, 't5')
  console.log(`  fp-max-touch-points=5  maxTouchPoints=${on.maxTouchPoints}  ` +
              `any-pointer:coarse=${yn(on.anyCoarse)}  any-pointer:fine=${yn(on.anyFine)}`)
  console.log('')

  let bad = 0
  if (off.maxTouchPoints !== 0) { bad++; console.log('X 开关没生效：maxTouchPoints 不是 0。') }
  if (off.anyCoarse) {
    bad++
    console.log('X 声称 0 触点，但 any-pointer:coarse 仍为 true —— 矛盾未消除。')
  } else {
    console.log('OK 声称 0 触点时 any-pointer:coarse=false（基线是 true，确实变了）')
  }
  // 反例方向：>0 时 coarse 必须在，否则等于把矛盾翻到另一面。
  if (!on.anyCoarse) {
    bad++
    console.log('X 声称 5 触点，却报 any-pointer:coarse=false —— 反向的同一个矛盾。')
  } else {
    console.log('OK 声称 5 触点时 any-pointer:coarse=true')
  }
  // fine 不该被动到：宿主有鼠标与人格声称的触摸能力无关。
  if (off.anyFine !== base.anyFine || on.anyFine !== base.anyFine) {
    bad++
    console.log(`X any-pointer:fine 被改动了（基线 ${yn(base.anyFine)}）—— 不该动它。`)
  } else {
    console.log('OK any-pointer:fine 未被改动')
  }

  console.log('')
  if (bad) { console.log(`X ${bad} 项未通过。`); process.exit(1) }
  console.log('OK 触摸能力与指针媒体特征一致。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
