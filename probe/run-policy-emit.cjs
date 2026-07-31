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

const fs = require('fs')
const { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const KERNEL = 'D:/yunbrowser-run/yunbrowser.exe'
const WORKDIR = 'D:/chromium-work-151/probe'
const POLICY = `${WORKDIR}/policy-emit-policy.json`
const PORT = 9471

const WANT_DPR = 1.5
const WANT_TOUCH = 5

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      deviceMemory: 8,
      screenWidth: 1920,
      screenHeight: 1080,
      // 被测的两个字段。DPR 刻意用小数，见文件头。
      devicePixelRatio: WANT_DPR,
      maxTouchPoints: WANT_TOUCH,
    },
  },
}, null, 2), 'utf8')

// 在一个内核实例里读出被测值。withPolicy=false 时不传策略，用来取基线。
async function measure(withPolicy, profileSuffix) {
  try { execSync('taskkill /IM yunbrowser.exe /F /T', { stdio: 'ignore' }) } catch (e) {}
  await sleep(1200)

  const args = [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${WORKDIR}/prof-policy-emit-${profileSuffix}`,
    'about:blank',
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
        expression: 'JSON.stringify({dpr: devicePixelRatio, touch: navigator.maxTouchPoints})',
      },
    }))
  })
  sock.close(); child.kill()
  await sleep(600)
  return JSON.parse(out)
}

function fail(msg) { console.log('X ' + msg); process.exit(1) }

;(async () => {
  // ── 1. 基线：不带策略 ───────────────────────────────────────────────
  const base = await measure(false, 'base')
  console.log(`  基线（无策略）  dpr=${base.dpr}  maxTouchPoints=${base.touch}`)

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

  // ── 2. 带策略 ───────────────────────────────────────────────────────
  const got = await measure(true, 'policy')
  console.log(`  带策略          dpr=${got.dpr}  maxTouchPoints=${got.touch}`)
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

  console.log('')
  if (bad) {
    console.log(`X ${bad} 项未通过 —— 策略 JSON 到渲染侧这条链路有断点。`)
    process.exit(1)
  }
  console.log('OK 策略 JSON → 开关下发 → 渲染侧，整条链路通。')
  console.log('   注意：这只覆盖 devicePixelRatio 与 maxTouchPoints 两个字段。')
  console.log('   其余字段仍只被命令行直传的探针验过，同一个洞可能还在别处。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
