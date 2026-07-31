// 验策略 JSON → 开关下发 → 渲染侧生效**这条完整链路**。
//
// ── 起因：一次必然通过的验收 ──────────────────────────────────────────
//
// 补丁 0026「消除四处指纹矛盾」验收通过了，但其中两处在生产路径上根本不可达：
//
//   fp-max-touch-points  永不下发 —— ParsePolicyDict 从不读 maxTouchPoints
//   fp-dpr-x1000         恒为 1000 —— 从不读 devicePixelRatio，回落兜底值
//
// 两个内核都是。逃掉的原因是 run-creepjs-audit.cjs **直接在命令行传开关**：
//
//   '--fp-dpr-x1000=1000', '--fp-max-touch-points=0'
//
// 它验的是「开关传进去时渲染侧生效」，而生产路径是「策略 JSON → 解析 → 下发」。
// 解析那一环从未被任何探针走到过。通过条件被一个与被测属性无关的前提满足了。
//
// 更糟的是它选的值**与故障不可区分**：1000 正是坏路径的兜底值，0 正是开发机
// 的真实触点数。就算它走了策略路径，这两个值也照样通过。
//
// ── 因此这个脚本的形状 ────────────────────────────────────────────────
//
// 跑两趟：先**不带**策略，记下宿主真值与兜底值；再**带**策略，要求值确实变成
// 配置的那个。「什么都没发生」于是永远无法通过 —— 这是本目录的反例纪律。
//
// 配置值刻意选成与两者都不同：
//   devicePixelRatio 1.5   （兜底 1.0；宿主 4K@175% 是 1.75）
//   maxTouchPoints   5     （非触摸开发机真值是 0）
// 若哪天在触点数恰为 5 的机器上跑，下面的 baseline 断言会当场喊出来。
//
// devicePixelRatio 用小数是刻意的：JSON 的 1.5 在 base::Value 里是 DOUBLE，
// FindInt 对 DOUBLE 返回 nullopt，会**静默**当作没配置。传整数的测试发现不了
// 这个坑 —— 与 geolocation 那条契约同源。

if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('X D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。先跑 build-and-sync.sh。')
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

const fs = require('fs')
const http = require('http')
const { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const KERNEL = 'D:/yunbrowser-run/yunbrowser.exe'
const WORKDIR = 'D:/chromium-work-151/probe'
const POLICY = `${WORKDIR}/policy-emit-policy.json`
const PORT = 9471
const HTTP_PORT = 8796

const WANT_DPR = 1.5
const WANT_TOUCH = 5
// 16 是刻意选的：本机基线 32（宿主 >=32GB）。旧校验器只接受 {1,2,4,8}，会把 16
// 静默丢弃 -> 开关不下发 -> 页面仍读 32；新校验器接受 -> 读到 16。基线、旧行为、
// 期望值三者两两不同，所以红绿可分。
// 注意 151 桌面的可达集合是 {2,4,8,16,32}（钳位 [2,32]，8 只在 Android 分支），
// 与 124 的 {0.25..8} 不同 —— 这个值不能照搬到 124 的探针上。
const WANT_MEM = 16

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 必须在一个**安全上下文**里测：navigator.deviceMemory 是 [SecureContext]
// （navigator_device_memory.idl:8），在 about:blank 上恒为 undefined，而
// devicePixelRatio / maxTouchPoints 不受此限、照常返回。于是读数会呈现为
// 「只有 deviceMemory 坏了」—— 一个高度可信、且指向具体字段的错误结论。
// http://localhost 是规范认定的可信来源，无需 https 证书。
const PAGE_URL = `http://localhost:${HTTP_PORT}/`

fs.mkdirSync(WORKDIR, { recursive: true })
fs.writeFileSync(POLICY, JSON.stringify({
  schemaVersion: 1,
  profileId: 'policy-emit',
  runtimeChannel: 'custom-kernel',
  fingerprintPolicy: {
    locale: 'en-US',
    timezone: 'America/New_York',
    windowSize: { width: 1920, height: 1080 },
    permissionDefaults: 'deny',
    webrtcIpPolicy: 'default',
    brand: 'Google Chrome',
    hardwareProfile: {
      platform: 'Win32',
      hardwareConcurrency: 8,
      screenWidth: 1920,
      screenHeight: 1080,
      // 被测的三个字段。DPR 刻意用小数，见文件头。
      devicePixelRatio: WANT_DPR,
      maxTouchPoints: WANT_TOUCH,
      deviceMemory: WANT_MEM,
    },
  },
}, null, 2), 'utf8')

// 在一个内核实例里读出被测值。withPolicy=false 时不传策略，用来取基线。
async function measure(withPolicy, profileSuffix) {
  ensureFieldClear('yunbrowser.exe')
  await sleep(1200)

  const args = [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${WORKDIR}/prof-policy-emit-${profileSuffix}`,
    PAGE_URL,
  ]
  if (withPolicy) args.splice(4, 0, `--fingerbrowser-policy=${POLICY}`)

  const child = spawn(KERNEL, args, { stdio: 'ignore' })

  let ws = null
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) ws = page.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) { child.kill(); throw new Error(`内核未起来（withPolicy=${withPolicy}）`) }

  const sock = new WebSocket(ws)
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej })

  // 等 location.href 真的到了目标再测。**target 列表里的 URL 是「打算去哪」，
  // 不是「现在在哪」** —— 连上去时文档往往还是初始的 about:blank。踩过：
  // target 报 http://localhost:8796/ 而 location.href 是 about:blank，
  // isSecureContext=false，deviceMemory 恒 UNDEFINED。
  let landed = false
  for (let i = 0; i < 40 && !landed; i++) {
    const href = await new Promise((r) => {
      sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 99) r(d.result?.result?.value || '') }
      sock.send(JSON.stringify({ id: 99, method: 'Runtime.evaluate',
        params: { returnByValue: true, expression: 'location.href' } }))
    })
    if (href.startsWith(PAGE_URL)) landed = true; else await sleep(250)
  }
  if (!landed) { sock.close(); child.kill(); throw new Error('导航未在 10s 内到达测试页，测量无意义') }

  const out = await new Promise((res, rej) => {
    sock.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id === 1) {
        if (d.result && d.result.result) res(d.result.result.value)
        else rej(new Error('Runtime.evaluate 无返回值: ' + JSON.stringify(d).slice(0, 200)))
      }
    }
    sock.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: 'JSON.stringify({sec: isSecureContext, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, mem: navigator.deviceMemory})',
      },
    }))
  })
  sock.close(); child.kill()
  await sleep(600)
  return JSON.parse(out)
}

function fail(msg) { console.log('X ' + msg); process.exit(1) }
// 注：fail() 用 process.exit 强制退出，句柄由进程退出一并释放，无需单独关服务。

;(async () => {
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    r.end('<!doctype html><meta charset=utf-8><title>probe</title>')
  })
  await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r))
  process.on('exit', () => { try { srv.close() } catch (e) {} })

  // ── 1. 基线：不带策略 ───────────────────────────────────────────────
  const base = await measure(false, 'base')
  console.log(`  基线（无策略）  dpr=${base.dpr}  maxTouchPoints=${base.touch}  deviceMemory=${base.mem}`)

  if (!base.sec) {
    fail('测试页不是安全上下文（isSecureContext=false）—— deviceMemory 恒为 undefined，\n' +
         '  本次测量对该字段无意义。检查是否仍在 about:blank 上求值。')
  }

  // 前提检查：配置值必须与基线不同，否则「生效」与「没生效」不可区分。
  // 这不是可选的谨慎 —— 正是原探针失败的根因：它选的 0 恰好等于宿主真值。
  if (base.dpr === WANT_DPR) {
    fail(`基线 dpr 恰好等于要配置的 ${WANT_DPR}，本次测量无法区分「生效」与「没生效」。\n` +
         `  换一个配置值再跑（改本文件的 WANT_DPR）。`)
  }
  if (base.touch === WANT_TOUCH) {
    fail(`基线 maxTouchPoints 恰好等于要配置的 ${WANT_TOUCH}，本次测量无法区分。\n` +
         `  换一个配置值再跑（改本文件的 WANT_TOUCH）。`)
  }
  if (base.mem === WANT_MEM) {
    fail(`基线 deviceMemory 恰好等于要配置的 ${WANT_MEM}，本次测量无法区分。\n` +
         `  换一个配置值再跑（改本文件的 WANT_MEM），且必须落在上游可达集合内\n` +
         `  （151 桌面是 {2,4,8,16,32}，见 check-policy-contract.cjs 的输出）。`)
  }

  // ── 2. 带策略 ───────────────────────────────────────────────────────
  const got = await measure(true, 'policy')
  console.log(`  带策略          dpr=${got.dpr}  maxTouchPoints=${got.touch}  deviceMemory=${got.mem}`)
  console.log('')

  let bad = 0

  if (got.dpr !== WANT_DPR) {
    bad++
    const why = got.dpr === 1
      ? '取到 1 —— 正是 ParsePolicyDict 不读 devicePixelRatio 时的兜底值。'
      : got.dpr === base.dpr
        ? '与基线相同 —— 策略完全没起作用。'
        : '既不是配置值也不是基线值。'
    console.log(`X devicePixelRatio: 期望 ${WANT_DPR}，实际 ${got.dpr}。${why}`)
  } else {
    console.log(`OK devicePixelRatio = ${WANT_DPR}（基线是 ${base.dpr}，确实变了）`)
  }

  if (got.touch !== WANT_TOUCH) {
    bad++
    const why = got.touch === base.touch
      ? '与基线相同 —— fp-max-touch-points 很可能压根没下发。'
      : '既不是配置值也不是基线值。'
    console.log(`X navigator.maxTouchPoints: 期望 ${WANT_TOUCH}，实际 ${got.touch}。${why}`)
  } else {
    console.log(`OK navigator.maxTouchPoints = ${WANT_TOUCH}（基线是 ${base.touch}，确实变了）`)
  }

  if (got.mem !== WANT_MEM) {
    bad++
    const why = got.mem === base.mem
      ? '与基线相同 —— fp-device-memory 很可能没下发（校验器把该值当非法丢弃了？）。'
      : '既不是配置值也不是基线值。'
    console.log(`X navigator.deviceMemory: 期望 ${WANT_MEM}，实际 ${got.mem}。${why}`)
  } else {
    console.log(`OK navigator.deviceMemory = ${WANT_MEM}（基线是 ${base.mem}，确实变了）`)
  }

  console.log('')
  if (bad) {
    srv.close()
    console.log(`X ${bad} 项未通过 —— 策略 JSON 到渲染侧这条链路有断点。`)
    process.exit(1)
  }
  // 显式关服务并退出。少了这句，http 服务的句柄会把 node 的事件循环挂住，
  // 脚本跑完却不退出 —— 而它若被管进 `| tail`，管道要等进程结束才输出，于是
  // 看起来像「卡住且没有任何诊断」。本次会话里这个组合踩过两次。
  srv.close()
  console.log('OK 策略 JSON → 开关下发 → 渲染侧，整条链路通。')
  console.log('   注意：这只覆盖 devicePixelRatio、maxTouchPoints、deviceMemory 三个字段。')
  console.log('   其余字段仍只被命令行直传的探针验过，同一个洞可能还在别处。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
