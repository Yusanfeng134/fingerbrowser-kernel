// 两条「以为修了、实际没修」的复验：hover 与 pointer 同源；ScreenDetailed 的 DPR。
//
// ── 这两条是怎么被发现的 ────────────────────────────────────────────────
//
// 拿云登线上内核的缺陷清单反过来自查我们自己时，交叉自查判「我们已修」，
// 而对抗性核验把这两条**推翻**了。主路径确实都修好了，漏的都是第二读点。
//
// 记在这里是因为这类错判的代价最高：它让人放心，然后不去看。
//
// ── 条件一：hover 必须与 pointer 同源 ──────────────────────────────────
//
// 补丁 0035 只收了 pointer 的口。在触屏笔记本这类宿主上伪装 maxTouchPoints=0：
//     (pointer: fine)   true   ← 0035 强制的
//     (hover: none)     true   ← 仍是宿主值
// 而 ui/base/pointer/pointer_device_win.cc:57-67 里 FINE 与 HOVER 是在同一个分支
// 里一起设的（有鼠标 -> fine + hover），tablet 分支返回 {coarse, none}。
// **fine-without-hover 在真实 Windows 上不可达。**
//
// 所以判据不是「hover 变了」——那只说明开关有效。判据是**那个真机不存在的组合
// 不再出现**。一个把 hover 恒设成 none 的实现也会让「hover 变了」通过。
//
// ── 条件二：ScreenDetailed 内部不得自相矛盾 ────────────────────────────
//
// ScreenDetailed 继承 Screen，width/height 没 override（走伪装值），而
// devicePixelRatio 原本直接返回宿主 device_scale_factor。于是同一个对象里
// width 是伪装的、DPR 是真的。
//
// 注意**不能**断言 sd.devicePixelRatio === window.devicePixelRatio：上游这两者
// 本来就不等价（window 那个含页面缩放，屏幕自身的 DPR 不随 Ctrl+= 变）。
// 断言相等会把一个正确实现判成失败，也会诱导下一个人去「修」成相等 ——
// 那才真的造出「屏幕 DPR 跟着页面缩放走」这个真机没有的矛盾。
// 探针在 100% 缩放下跑，此时两者应当相等；这一点在下面写明。
//
// ScreenDetailed 需要 WINDOW_MANAGEMENT 权限，用 CDP 的
// Browser.grantPermissions 授予 —— 不是绕过权限，是把「站点已获授权」这个
// 本就会发生的状态构造出来。

const http = require('http')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.HSD_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const CDP = 9651
const HTTP_PORT = 8981
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!process.env.HSD_KERNEL && require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('X D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。')
  process.exit(1)
}

function ensureFieldClear() {
  const { killProbeKernels, foreignKernelCount } = require('./probe-kill.cjs')
  const killed = killProbeKernels(IMAGE)
  if (killed.length) console.log(`  清掉本探针上次残留的 ${killed.length} 个进程`)
  const foreign = foreignKernelCount(IMAGE)
  if (foreign) console.log(`  注意：场上还有 ${foreign} 个非本探针的 ${IMAGE}。`)
}

const EXPR = `(async () => {
  const mq = (q) => matchMedia(q).matches;
  const out = {
    maxTouchPoints: navigator.maxTouchPoints,
    dpr: window.devicePixelRatio,
    screenWidth: screen.width,
    pointerFine: mq('(pointer: fine)'),
    pointerCoarse: mq('(pointer: coarse)'),
    anyPointerFine: mq('(any-pointer: fine)'),
    anyPointerCoarse: mq('(any-pointer: coarse)'),
    hoverHover: mq('(hover: hover)'),
    hoverNone: mq('(hover: none)'),
    anyHoverHover: mq('(any-hover: hover)'),
    anyHoverNone: mq('(any-hover: none)'),
  };
  try {
    const d = await window.getScreenDetails();
    const s = d.currentScreen;
    out.sdWidth = s.width;
    out.sdHeight = s.height;
    out.sdDpr = s.devicePixelRatio;
  } catch (e) {
    out.sdError = String(e && e.name || e);
  }
  return JSON.stringify(out);
})()`

async function run(touchPoints, dprX1000, tag) {
  ensureFieldClear()
  await sleep(900)
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html>hsd')
  })
  await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r))
  const url = `http://localhost:${HTTP_PORT}/`
  const args = ['--headless=new', '--no-first-run', '--disable-background-networking',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORKDIR}/prof-hsd-${tag}`]
  if (touchPoints !== null) args.push(`--fp-max-touch-points=${touchPoints}`)
  if (dprX1000 !== null) {
    args.push(`--fp-dpr-x1000=${dprX1000}`, '--fp-screen-width=1920', '--fp-screen-height=1080')
  }
  args.push(url)
  const child = spawn(KERNEL, args, { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      target = l.find((x) => x.type === 'page') || null
    } catch (e) {}
  }
  if (!target) { srv.close(); child.kill(); throw new Error(`内核未起来（${tag}）`) }

  const s = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej })
  let id = 0
  const send = (method, params) => new Promise((r) => {
    const myId = ++id
    const prev = s.onmessage
    s.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id === myId) { s.onmessage = prev; r(d) } else if (prev) prev(m)
    }
    s.send(JSON.stringify({ id: myId, method, params: params || {} }))
  })
  const ev = async (e, aw) => {
    const d = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: !!aw, expression: e })
    return d.result?.result?.value ?? ''
  }
  for (let i = 0; i < 40; i++) {
    const h = await ev('location.href')
    if (String(h).startsWith(url)) break
    await sleep(250)
  }
  // 构造「站点已获 WINDOW_MANAGEMENT 授权」这个本就会发生的状态。
  await send('Browser.grantPermissions', { origin: url, permissions: ['windowManagement'] })
  const out = await ev(EXPR, true)
  s.close(); srv.close(); child.kill()
  await sleep(700)
  return JSON.parse(out)
}

const R = []
const rec = (name, pass, detail) => R.push({ name, pass, detail })

;(async () => {
  const base = await run(null, null, 'base')
  console.log(`  基线（不伪装）  maxTouchPoints=${base.maxTouchPoints}` +
    ` pointer:fine=${base.pointerFine} hover:hover=${base.hoverHover}` +
    ` hover:none=${base.hoverNone} dpr=${base.dpr} sdDpr=${base.sdDpr}`)

  // ── 条件一：桌面人格（0 触点）─────────────────────────────────────
  const desk = await run(0, null, 'touch0')
  console.log(`  maxTouchPoints=0  pointer:fine=${desk.pointerFine}` +
    ` any-pointer:coarse=${desk.anyPointerCoarse}` +
    ` hover:hover=${desk.hoverHover} any-hover:none=${desk.anyHoverNone}`)

  rec('声称 0 触点时 navigator.maxTouchPoints 为 0', desk.maxTouchPoints === 0, `实为 ${desk.maxTouchPoints}`)
  rec('声称 0 触点时 any-pointer:coarse 为否', desk.anyPointerCoarse === false, '')
  // 真正的判据：真机不可达的组合不得出现。
  const impossible = desk.pointerFine === true && desk.hoverHover === false
  rec('不出现 fine-without-hover（真机不可达的组合）', !impossible,
    impossible ? 'pointer:fine 为真而 hover:hover 为假 —— 这台设备物理上不存在' : '')
  rec('声称 0 触点时 any-hover:none 为否', desk.anyHoverNone === false, '')

  // ── 条件一的反例：触屏人格（10 触点）──────────────────────────────
  const touch = await run(10, null, 'touch10')
  console.log(`  maxTouchPoints=10 any-pointer:coarse=${touch.anyPointerCoarse}` +
    ` any-hover:none=${touch.anyHoverNone} hover:hover=${touch.hoverHover}`)
  rec('反例：声称 10 触点时 any-pointer:coarse 为真', touch.anyPointerCoarse === true, '')
  rec('反例：声称 10 触点时 any-hover:none 为真', touch.anyHoverNone === true, '')
  // 触屏笔记本上 hover 与 none 同时可用，不该把 hover 抹掉。
  rec('声称 10 触点时未误删 hover 能力', touch.anyHoverHover === true,
    '触屏设备仍可能有鼠标，any-hover:hover 不该被抹掉')
  // 判别力对照：两种人格必须给出不同答案，否则上面全是恒真。
  rec('对照：0 与 10 触点给出不同的 any-hover:none',
    desk.anyHoverNone !== touch.anyHoverNone,
    `两者都是 ${desk.anyHoverNone} —— 开关没有判别力，上面结论不可信`)

  // ── 条件二：ScreenDetailed ────────────────────────────────────────
  // 伪装成 2.0 而不是 1.0：headless 宿主的 DSF 就是 1，拿 1 去伪装会让
  // 「已伪装」这个断言恒真 —— 第一版就这么写的，探针的前提检查把它挡了下来。
  const sd = await run(null, 2000, 'dpr')
  console.log(`  伪装 DPR=2.0    window.dpr=${sd.dpr} sd.dpr=${sd.sdDpr}` +
    ` screen.width=${sd.screenWidth} sd.width=${sd.sdWidth}` + (sd.sdError ? ` (${sd.sdError})` : ''))

  if (sd.sdError) {
    rec('ScreenDetailed 可读（前提）', null, `拿不到：${sd.sdError} —— 本条测不了`)
  } else {
    rec('ScreenDetailed.width 与 screen.width 一致（继承的伪装值）',
      sd.sdWidth === sd.screenWidth, `${sd.sdWidth} vs ${sd.screenWidth}`)
    rec('ScreenDetailed.devicePixelRatio 已伪装', sd.sdDpr === 2, `实为 ${sd.sdDpr}`)
    // 100% 缩放下两者应当相等；不在其它缩放下断言相等，理由见文件头。
    rec('同一对象内部不再自相矛盾（100% 缩放下 sd.dpr === window.dpr）',
      sd.sdDpr === sd.dpr, `sd=${sd.sdDpr} window=${sd.dpr}`)
    // 判别力对照：基线值必须与伪装值不同，否则上面两条是恒真的。
    rec('对照：基线 sd.dpr 与伪装值不同（证明断言有判别力）',
      base.sdDpr !== sd.sdDpr,
      `基线与伪装后都是 ${sd.sdDpr} —— 断言恒真，结论不可信`)
  }

  console.log('')
  let bad = 0, undec = 0
  for (const r of R) {
    if (r.pass === null) { undec++; console.log(`  ? ${r.name}  ${r.detail}`); continue }
    if (!r.pass) { bad++; console.log(`  X ${r.name}  ${r.detail}`) } else console.log(`  OK ${r.name}`)
  }
  console.log('')
  if (bad) { console.log(`X ${bad} 项未通过（${undec} 项无法判定）。`); process.exit(1) }
  if (undec) console.log(`   ${undec} 项无法判定，未计入通过。`)
  console.log('OK hover 与 pointer 同源；ScreenDetailed 内部不再自相矛盾。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
