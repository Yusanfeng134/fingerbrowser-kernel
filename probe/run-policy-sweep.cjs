// 策略路径全量扫描：内核读的**每一个**字段，配了之后页面是否真的读到。
//
// ── 为什么要有这个 ──────────────────────────────────────────────────────
//
// 补丁 0026 的四项里有三项在生产路径上从未生效，成因分两种：
//   · 内核不解析那个键 → 开关永不下发（devicePixelRatio / maxTouchPoints）
//   · 客户端不下发那个键 → 策略字段恒为空（platformVersion）
// 而它**验收通过了**，因为所有指纹探针都在命令行直传 `--fp-*`，
// 「策略 JSON → 解析 → 下发」这一环从没被走过。
//
// run-policy-emit.cjs 补上了这条路，但只覆盖 3 个字段。内核读 27 个。
// **同一个洞在其余 24 个上很可能还在** —— 这个脚本就是去看还在不在。
//
// ── 判据 ────────────────────────────────────────────────────────────────
//
// 每个字段跑两趟：不带策略取基线，带策略取实测。要求
//   1. 配置值与基线**不同**（否则「生效」与「没生效」不可区分 —— 前提检查）
//   2. 带策略时读到的**等于配置值**
//
// 两趟共用同一个进程实例（一次启动读全部字段），因为 27 个字段各起一次内核要
// 二十多分钟，而它们互不干扰。
//
// ── 不覆盖的，明说 ──────────────────────────────────────────────────────
//
// canvasNoise / audioNoise 是种子，不是可直接读出的值；它们的效果要靠
// run-canvas-oob.cjs 那类形态断言。
// passkeyAuthenticator 由 run-p0-passkey.cjs 覆盖。
// permissionDefaults / webrtcIpPolicy / blockCjkFonts 的效果不在 navigator 上，
// 需要各自的场景，本脚本只报「未覆盖」而不假装验过。

// STALE 只对**部署件**成立。用 SWEEP_KERNEL 指向构建目录时不适用 ——
// 那份就是刚构建出来的，没有「旧内核」这回事。
if (!process.env.SWEEP_KERNEL &&
    require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('X D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。')
  console.log('  要测刚构建出来的那份，用 SWEEP_KERNEL 指向 out/FingerBrowser。')
  process.exit(1)
}

const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.SWEEP_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const CDP = 9571
const HTTP_PORT = 8901
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureFieldClear(image) {
  const { killProbeKernels, foreignKernelCount } = require('./probe-kill.cjs')
  const killed = killProbeKernels(image)
  if (killed.length) console.log(`  清掉本探针上次残留的 ${killed.length} 个进程`)
  const foreign = foreignKernelCount(image)
  if (foreign) console.log(`  注意：场上还有 ${foreign} 个非本探针的 ${image}。`)
}

// 配置值刻意选成不像宿主的：宿主是中文 Windows / 4K 触屏 / 32G。
const POLICY = {
  schemaVersion: 1, profileId: 'sweep', runtimeChannel: 'custom-kernel',
  fingerprintPolicy: {
    locale: 'fr-FR',
    timezone: 'Europe/Paris',
    windowSize: { width: 1280, height: 800 },
    permissionDefaults: 'deny',
    webrtcIpPolicy: 'default',
    brand: 'Google Chrome',
    blockCjkFonts: true,
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    hardwareProfile: {
      platform: 'MacIntel',
      platformVersion: '14.5.0',
      hardwareConcurrency: 6,
      deviceMemory: 4,
      screenWidth: 1440,
      screenHeight: 900,
      devicePixelRatio: 2,
      maxTouchPoints: 3,
      gpuVendor: 'Apple Inc.',
      gpuRenderer: 'Apple M2',
      webgpuVendor: 'apple',
      webgpuArchitecture: 'metal-3',
      webgpuDevice: 'm2',
      webgpuDescription: 'Apple M2 (probe)',
    },
  },
}

// 每一项：怎么读、期望值、以及它对应策略里的哪个键。
const EXPR = `(async () => {
  const out = {};
  out.locale = navigator.language;
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.platform = navigator.platform;
  out.hardwareConcurrency = navigator.hardwareConcurrency;
  out.deviceMemory = navigator.deviceMemory;
  out.screenWidth = screen.width;
  out.screenHeight = screen.height;
  out.devicePixelRatio = devicePixelRatio;
  out.maxTouchPoints = navigator.maxTouchPoints;
  // UA-CH 高熵项
  try {
    const h = await navigator.userAgentData.getHighEntropyValues(
      ['platform', 'platformVersion', 'brands', 'fullVersionList']);
    out.chPlatform = h.platform;
    out.platformVersion = h.platformVersion;
    out.brand = (h.brands || []).map(b => b.brand).join('|');
  } catch (e) { out.chError = String(e.name); }
  // WebGL 厂商
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.gpuVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
    out.gpuRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  } catch (e) { out.glError = String(e.name); }
  // WebGPU：非 dev-features 分支只暴露 vendor/architecture
  try {
    const a = await navigator.gpu.requestAdapter();
    // 151 用 adapter.info 属性；requestAdapterInfo() 在 151 已移除
    // （124 才有那个方法）。用错版本的 API 会得到 undefined，看起来像
    // 「策略没生效」—— 实测栽过一次。
    const i = a.info;
    out.webgpuVendor = i.vendor; out.webgpuArchitecture = i.architecture;
  } catch (e) { out.gpuErr = String(e.name); }
  return JSON.stringify(out);
})()`

const CHECKS = [
  { key: 'locale',              want: 'fr-FR' },
  { key: 'timezone',            want: 'Europe/Paris' },
  { key: 'platform',            want: 'MacIntel' },
  // UA-CH 的词汇表与 navigator.platform 不同：前者是展示名（Windows/macOS/
  // Linux），后者是 NavigatorID 值（Win32/MacIntel/Linux x86_64）。策略配
  // MacIntel 时 CH 应报 macOS —— **期望值写成 MacIntel 是错的**，那正是实现里
  // 刻意避免的「直接透传」，透传会让 CH 报出真实浏览器从不出现的值。
  { key: 'chPlatform',          want: 'macOS', policyKey: 'platform（UA-CH）' },
  { key: 'platformVersion',     want: '14.5.0' },
  { key: 'hardwareConcurrency', want: 6 },
  { key: 'deviceMemory',        want: 4 },
  { key: 'screenWidth',         want: 1440 },
  { key: 'screenHeight',        want: 900 },
  { key: 'devicePixelRatio',    want: 2 },
  { key: 'maxTouchPoints',      want: 3 },
  { key: 'gpuVendor',           want: 'Apple Inc.' },
  { key: 'gpuRenderer',         want: 'Apple M2' },
  { key: 'webgpuVendor',        want: 'apple' },
  { key: 'webgpuArchitecture',  want: 'metal-3' },
  { key: 'brand',               want: null, note: 'brands 列表含 Google Chrome 即可' },
]

async function measure(withPolicy, tag) {
  ensureFieldClear(IMAGE)
  await sleep(1200)
  const args = ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORKDIR}/prof-sweep-${tag}`]
  if (withPolicy) {
    const f = `${WORKDIR}/sweep-policy.json`
    fs.writeFileSync(f, JSON.stringify(POLICY), 'utf8')
    args.push(`--fingerbrowser-policy=${f}`, '--fp-active')
  }
  args.push(`http://localhost:${HTTP_PORT}/`)
  const child = spawn(KERNEL, args, { stdio: 'ignore' })

  let ws = null
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500)
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      const t = l.find((x) => x.type === 'page')
      if (t) ws = t.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) { child.kill(); throw new Error(`内核未起来（${tag}）`) }
  const s = new WebSocket(ws)
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej })
  const ev = (expr, id, awaitPromise) => new Promise((r) => {
    s.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) r(d.result?.result?.value ?? '') }
    s.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { returnByValue: true, awaitPromise: !!awaitPromise, expression: expr } }))
  })
  let landed = false
  for (let i = 0; i < 40 && !landed; i++) {
    const h = await ev('location.href', 700 + i)
    if (String(h).startsWith(`http://localhost:${HTTP_PORT}`)) landed = true; else await sleep(250)
  }
  if (!landed) { s.close(); child.kill(); throw new Error('导航未落地') }
  const out = await ev(EXPR, 1, true)
  s.close(); child.kill()
  await sleep(800)
  return out ? JSON.parse(out) : {}
}

;(async () => {
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    r.end('<!doctype html><meta charset=utf-8><body>sweep')
  })
  await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r))

  console.log('  取基线（不带策略）…')
  const base = await measure(false, 'base')
  console.log('  取实测（带策略）…')
  const got = await measure(true, 'policy')
  srv.close()
  console.log('')

  let bad = 0, undecidable = 0
  for (const c of CHECKS) {
    const b = base[c.key], g = got[c.key]
    const label = (c.policyKey || c.key).padEnd(22)

    if (c.want === null) {
      // brand：只看是否含期望品牌，基线上也可能含 —— 明确标为不可判别。
      const ok = String(g).includes('Google Chrome')
      console.log(`  ?  ${label} 基线=${JSON.stringify(b)} 实测=${JSON.stringify(g)}` +
                  `  ${ok ? '含 Google Chrome' : '不含'}（${c.note}，基线可能相同，不作判据）`)
      undecidable++
      continue
    }
    // 前提检查：基线必须与配置值不同，否则这一项测不了。
    if (b === c.want) {
      console.log(`  ?  ${label} 基线恰好就是 ${JSON.stringify(c.want)} —— **本项不可判别**`)
      undecidable++
      continue
    }
    if (g === c.want) {
      console.log(`  OK ${label} ${JSON.stringify(b)} -> ${JSON.stringify(g)}`)
    } else {
      bad++
      console.log(`  X  ${label} 期望 ${JSON.stringify(c.want)}，实测 ${JSON.stringify(g)}` +
                  `（基线 ${JSON.stringify(b)}）` +
                  (g === b ? '  ← 与基线相同，策略没生效' : ''))
    }
  }

  console.log('')
  console.log(`未覆盖：canvasNoise / audioNoise（是种子，不是可读值，见 run-canvas-oob）、`)
  console.log('  passkeyAuthenticator（见 run-p0-passkey）、permissionDefaults /')
  console.log('  webrtcIpPolicy / blockCjkFonts / windowSize / geolocation（效果不在')
  console.log('  navigator 上，各需自己的场景）。**本脚本不假装验过它们。**')
  console.log('')
  if (undecidable) console.log(`  ${undecidable} 项不可判别（基线与配置值相同或本就无判据）。`)
  if (bad) { console.log(`X ${bad} 项未通过 —— 策略配了但页面没读到。`); process.exit(1) }
  console.log('OK 可判别的字段全部经策略路径生效。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
