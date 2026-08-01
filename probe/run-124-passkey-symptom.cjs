// 测 124 内核上 navigator.credentials.create() 的**实际结局**。
//
// ── 为什么要先测 ────────────────────────────────────────────────────────
//
// docs/124-vs-151-gap.md 说 124 上 WebAuthn 会「无限挂起 —— 不报错、不超时，
// 用户只看到页面卡住」，并标为危害最高、客户当前会实际撞上。
//
// 但同一份文档 §5 写着「没有在 124 上跑过 probe/ 下的任何脚本」。也就是说这个
// 症状是从「151 需要这个补丁」推出来的，**没有测过**。
//
// 而那份文档 §4 第 1 条自己写的是：「先在 124 上跑一遍审计，确认真的出现。
// 落点相同不等于症状相同 —— 这正是今天三次误判的根源。」那条当时只用在了指纹
// 矛盾类上，没用在 passkey 上。移植成本最高的一项，值得先花十分钟测。
//
// ── 判据必须能区分三种结局，不能只判「没成功」──────────────────────────
//
//   HANG      Promise 既不 resolve 也不 reject，直到超时。这才是文档说的症状，
//             也是唯一真正需要虚拟认证器来解决的形态。
//   REJECT    明确抛错（NotAllowedError / NotSupportedError 等）。页面能走
//             fallback、用户看得到提示 —— 危害低得多，可能根本不值得移植。
//   RESOLVE   居然成功了（系统里有可用认证器）。那说明 124 上这条路本来就通。
//
// 只判「有没有拿到 credential」会把 HANG 和 REJECT 混为一谈，而这两者的危害
// 与应对方式完全不同 —— 这正是本仓库反复记录的「通过条件与被测属性无关」的
// 镜像：**失败条件与被测属性无关**。

const http = require('http')
const { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.K124 ||
  'D:/chromium-work/chromium/src/out/FingerBrowser/chrome.exe'
const PROFILE = process.env.PK_PROFILE || 'D:/chromium-work/probe-passkey-symptom'
// 可选：走策略路径（151 的 fp-passkey 由策略挂载）。用来做对照组。
const POLICY = process.env.PK_POLICY || ''
const CDP = 9482
const HTTP_PORT = 8793
// 页面侧等 25s。真「无限挂起」在 25s 内不会有任何动静；而正常的 reject 通常
// 在 1s 内到达（无认证器时立即拒）。两者相差一个数量级，不会误判。
const PAGE_TIMEOUT_MS = 25000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><meta charset=utf-8><title>wa</title><body>
<div id="out">pending</div>
<script>
(async () => {
  const t0 = performance.now()
  const timeout = new Promise((r) => setTimeout(() => r({k: 'HANG'}), ${PAGE_TIMEOUT_MS}))
  const attempt = navigator.credentials.create({
    publicKey: {
      challenge: new Uint8Array(32),
      rp: { name: 'probe', id: 'localhost' },
      user: { id: new Uint8Array(16), name: 'p', displayName: 'p' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60000,
      authenticatorSelection: { authenticatorAttachment: 'platform' },
    }
  }).then((c) => ({k: 'RESOLVE', id: c && c.id}),
          (e) => ({k: 'REJECT', name: e.name, msg: String(e.message).slice(0, 120)}))
  const r = await Promise.race([attempt, timeout])
  r.ms = Math.round(performance.now() - t0)
  document.getElementById('out').textContent = JSON.stringify(r)
})()
</script></body>`

;(async () => {
  try { execSync('taskkill /IM chrome.exe /F /T', { stdio: 'ignore' }) } catch (e) {}
  await sleep(1200)

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r))

  // localhost 而非 127.0.0.1：裸 IP 不是合法的 WebAuthn RP ID。
  const child = spawn(KERNEL, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-background-networking',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${PROFILE}`,
    ...(POLICY ? [`--fingerbrowser-policy=${POLICY}`] : []),
    `http://localhost:${HTTP_PORT}/`,
  ], { stdio: 'ignore' })

  let ws = null
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) ws = page.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) { console.log('X 124 内核未起来'); child.kill(); srv.close(); process.exit(1) }

  const sock = new WebSocket(ws)
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej })

  let id = 0
  const evalIn = (expr) => new Promise((res, rej) => {
    const myId = ++id
    const h = (m) => {
      const d = JSON.parse(m.data)
      if (d.id !== myId) return
      sock.removeEventListener('message', h)
      if (d.result && d.result.result) res(d.result.result.value)
      else rej(new Error(JSON.stringify(d).slice(0, 200)))
    }
    sock.addEventListener('message', h)
    sock.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate',
      params: { returnByValue: true, expression: expr } }))
  })

  // 轮询到出结果为止，上限比页面超时再多 10s。
  let out = 'pending'
  const deadline = Date.now() + PAGE_TIMEOUT_MS + 10000
  while (Date.now() < deadline) {
    await sleep(1000)
    try { out = await evalIn("document.getElementById('out').textContent") } catch (e) {}
    if (out && out !== 'pending') break
  }

  sock.close(); child.kill(); srv.close()
  await sleep(500)

  if (!out || out === 'pending') {
    console.log('X 页面侧 25s 到期后仍未写出结果 —— 连超时分支都没跑到，脚本本身有问题。')
    process.exit(1)
  }

  const r = JSON.parse(out)
  console.log(`  内核: ${KERNEL.split('/').slice(-3).join('/')}${POLICY ? '  (带策略)' : '  (无策略)'}`)
  console.log(`  结局: ${r.k}   耗时 ${r.ms}ms`)
  if (r.k === 'REJECT') console.log(`  错误: ${r.name} — ${r.msg}`)
  if (r.k === 'RESOLVE') console.log(`  credential id: ${String(r.id).slice(0, 24)}...`)
  console.log('')

  // 结论必须跟着本次的输入走。第一版把三段文案写死成「124 无策略」那一组的
  // 语气，于是对照组（151 + 策略）跑出 RESOLVE 时，它输出的是「124 上这条路
  // 本来就通」—— 行为对、说法不对，而错误的解释比没有解释更贵。
  const expectAuthenticator = !!POLICY
  if (r.k === 'HANG') {
    if (expectAuthenticator) {
      console.log('X 带着策略仍然挂起 —— 认证器没挂上，或策略没被识别。')
      console.log('  这是本组**不该**出现的结果，先查策略路径再谈别的。')
    } else {
      console.log('★ 症状复现：Promise 既不 resolve 也不 reject。')
      console.log('  没有虚拟认证器时 WebAuthn 无限挂起，前提成立。')
    }
  } else if (r.k === 'REJECT') {
    console.log('! 结局是明确报错，不是「无限挂起」。')
    console.log('  页面能走 fallback、用户看得到提示 —— 危害低一级，')
    console.log('  优先级要按这个重判，不能照搬「危害最高」。')
  } else {
    if (expectAuthenticator) {
      console.log('★ 对照成立：挂上虚拟认证器后立即成功。')
      console.log('  说明挂起的成因就是「没有认证器」，而 0008 提供的正是它。')
    } else {
      console.log('! 不带策略却成功了 —— 系统里本来就有可用认证器。')
      console.log('  那么「缺 fp-passkey 导致卡住」这个前提在本机不成立，')
      console.log('  对照组也就失去意义，需要换一台机器重测。')
    }
  }
  console.log('')
  console.log('⚠ 症状随条件变化，本脚本测到的形态**不是唯一形态**。')
  console.log('  本地实测（124/151、localhost、headless 与有窗口、三种 userVerification、')
  console.log('  有无用户手势）一律 HANG 15-25s；客户端在真实环境（151、figma.com）测到的')
  console.log('  是 REJECT 1ms NotAllowedError。四个候选成因逐一变更后仍挂，成因未查清。')
  console.log('')
  console.log('  所以**不要拿「25 秒挂起」当作缺陷是否存在的依据** —— 按它去真实站点')
  console.log('  复现会得到「没问题」。两种形态都是「无认证器时 WebAuthn 异常失败」，')
  console.log('  修法相同。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
