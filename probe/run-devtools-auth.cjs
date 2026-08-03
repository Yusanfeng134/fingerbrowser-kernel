// DevTools 端点令牌鉴权：HTTP 与 WebSocket 两条路径都必须校验。
//
// ── 被测属性 ────────────────────────────────────────────────────────────
//
// `--remote-debugging-port` 开的那个端口，连上之后不需要任何凭据就能读 cookie、
// 导出 storage、注入脚本。随机端口挡不住 —— 端口号就写在 profile 目录的
// DevToolsActivePort 里。对一个卖「环境隔离」的产品，这是实质性的洞。
//
// ── 五种假通过，逐一对应下面的用例 ──────────────────────────────────────
//
//   1 只验「带对令牌能连上」 → 一个**完全忽略令牌**的实现同样通过。
//     所以 C/D/E 三个否定用例才是真正的验收点，B 只是前提。
//
//   2 只验 HTTP 不验 WS → **这是最可能的漏法**，两者在 Chromium 里是不同的代码
//     路径。而真正授予控制权的是 WS：/json/list 被拒之后，攻击者仍可直连
//     ws://127.0.0.1:<port>/devtools/browser/<guid>，那个 guid 就写在
//     DevToolsActivePort 的第二行。**HTTP 全锁上、WS 没锁 = 完全没锁**，
//     而这两半在「带对令牌能连上」里表现完全一样。
//     所以每个用例都同时打 HTTP 和 WS，且 WS 走的正是那条绕过路径。
//
//   3 只用 curl 验 → 验不到 Playwright 真实握手的形状（尾斜杠 /json/version/、
//     升级请求的头集合）。用例 G 用真的 connectOverCDP。
//
//   4 忘了验「未配置令牌」的回归 → 用例 A。一个默认改变行为的开关会悄悄打断
//     所有现有调试流程，而所有正向用例都不会发现。
//
//   5 拿空令牌验 → 空串与「缺失的头」相等，看起来「校验通过」而实际等于没鉴权。
//     用例 E 送一个空 devtoolsToken，要求结果是**全拒**而不是全放行。
//
// ── 就绪等待与它的陷阱 ──────────────────────────────────────────────────
//
// 令牌在线程池上读，而端口可能先开。实现把这段窗口设成「全拒」（fail-closed），
// 所以带对令牌的请求在最初几十毫秒可能也被拒。用例 B 因此要轮询到成功为止。
//
// 但**轮询本身没有判别力** —— 一个完全忽略令牌的实现第一次就成功。就绪等待只是
// 前提，不是断言；判别力全在 C/D/E。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.DTA_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const PW = 'C:/Users/MARS_01_WYF/Desktop/Yunlogin/node_modules/playwright-core'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!process.env.DTA_KERNEL && fs.existsSync('D:/yunbrowser-run/STALE')) {
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

// 起一个内核。auth 为 null 表示不传 --fp-devtools-auth（用例 A）。
// token 为 null 表示 JSON 里不带 devtoolsToken；'' 表示带一个空串（用例 E）。
async function launch({ tag, auth, token }) {
  const profile = `${WORKDIR}/prof-dta-${tag}`
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })

  const args = ['--headless=new', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`]
  if (auth) args.push('--fp-devtools-auth=stdin')
  args.push('about:blank')

  const child = spawn(KERNEL, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })

  if (auth) {
    const payload = { version: 1 }
    if (token !== null) payload.devtoolsToken = token
    child.stdin.write(JSON.stringify(payload))
  }
  // 无论有没有 auth 都要关掉 stdin：读端等的是 EOF。
  child.stdin.end()

  // 端口从 DevToolsActivePort 读，不猜。第一行是端口，第二行是 browser guid 路径。
  const portFile = path.join(profile, 'DevToolsActivePort')
  let port = null, browserPath = null
  for (let i = 0; i < 80 && port === null; i++) {
    await sleep(250)
    try {
      const lines = fs.readFileSync(portFile, 'utf8').split('\n')
      if (lines.length >= 2 && lines[0].trim()) {
        port = parseInt(lines[0].trim(), 10)
        browserPath = lines[1].trim()
      }
    } catch (e) {}
  }
  if (port === null) { child.kill(); throw new Error(`DevToolsActivePort 没出现（${tag}）`) }
  return { child, port, browserPath, profile, getStderr: () => stderr }
}

// HTTP：Playwright 请求的是带尾斜杠的 /json/version/，路由若只匹配不带斜杠的写法，
// 会造成「HTTP 通过、WS 被拒」这种最难查的半通状态。所以两种写法都打。
async function httpTry(port, token, urlPath) {
  const headers = {}
  if (token !== null) headers['X-FP-DevTools-Token'] = token
  try {
    const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers })
    return { status: r.status, body: await r.text() }
  } catch (e) {
    return { status: 0, body: 'fetch failed: ' + e.message }
  }
}

// WS：直连 browser guid —— 这正是交办书描述的那条绕过路径。
function wsTry(port, browserPath, token) {
  return new Promise((resolve) => {
    const headers = {}
    if (token !== null) headers['X-FP-DevTools-Token'] = token
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let s
    try {
      s = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { headers })
    } catch (e) { return finish({ ok: false, why: e.message }) }
    const to = setTimeout(() => { try { s.close() } catch (e) {} ; finish({ ok: false, why: 'timeout' }) }, 6000)
    s.on('open', () => { clearTimeout(to); try { s.close() } catch (e) {} ; finish({ ok: true }) })
    s.on('error', (e) => { clearTimeout(to); finish({ ok: false, why: String(e.message || e) }) })
    s.on('unexpected-response', (req, res) => {
      clearTimeout(to); finish({ ok: false, why: 'http ' + res.statusCode })
    })
  })
}

const results = []
const record = (name, pass, detail) => { results.push({ name, pass, detail }); return pass }

;(async () => {
  ensureFieldClear()
  await sleep(800)
  const TOKEN = crypto.randomBytes(32).toString('hex')

  // ── A 未配置令牌：行为必须与今天完全一致（§6.4）──────────────────────
  {
    const k = await launch({ tag: 'noauth', auth: false, token: null })
    const h = await httpTry(k.port, null, '/json/version')
    const w = await wsTry(k.port, k.browserPath, null)
    record('A 未配置令牌 -> HTTP 放行', h.status === 200, `status=${h.status}`)
    record('A 未配置令牌 -> WS 放行', w.ok, w.why || '')
    k.child.kill(); await sleep(500)
  }

  // ── B 正确令牌（同时作为就绪等待）───────────────────────────────────
  let leakCheck = null
  {
    const k = await launch({ tag: 'ok', auth: true, token: TOKEN })
    let h = null
    for (let i = 0; i < 40; i++) {
      h = await httpTry(k.port, TOKEN, '/json/version')
      if (h.status === 200) break
      await sleep(250)
    }
    record('B 正确令牌 -> HTTP 200', h.status === 200, `status=${h.status}`)
    // 尾斜杠：Playwright 实际请求的形状
    const hs = await httpTry(k.port, TOKEN, '/json/version/')
    record('B 正确令牌 -> HTTP 200（带尾斜杠）', hs.status === 200, `status=${hs.status}`)
    const w = await wsTry(k.port, k.browserPath, TOKEN)
    record('B 正确令牌 -> WS 连上', w.ok, w.why || '')

    // ── C 不带令牌：两条都必须失败（§6.2）─────────────────────────────
    const hc = await httpTry(k.port, null, '/json/version')
    const wc = await wsTry(k.port, k.browserPath, null)
    record('C 不带令牌 -> HTTP 403', hc.status === 403, `status=${hc.status}`)
    record('C 不带令牌 -> WS 被拒', !wc.ok, wc.ok ? '竟然连上了' : wc.why)
    record('C 403 响应体不透露原因', hc.body.trim() === '', `body=${JSON.stringify(hc.body.slice(0, 60))}`)

    // ── D 错误令牌 ───────────────────────────────────────────────────
    const hd = await httpTry(k.port, 'f'.repeat(64), '/json/version')
    const wd = await wsTry(k.port, k.browserPath, 'f'.repeat(64))
    record('D 错误令牌 -> HTTP 403', hd.status === 403, `status=${hd.status}`)
    record('D 错误令牌 -> WS 被拒', !wd.ok, wd.ok ? '竟然连上了' : wd.why)

    // ── F 令牌不得出现在任何可读处（§6.5）────────────────────────────
    const listResp = await httpTry(k.port, TOKEN, '/json/list')
    const portFileText = fs.readFileSync(path.join(k.profile, 'DevToolsActivePort'), 'utf8')
    leakCheck = {
      inPortFile: portFileText.includes(TOKEN),
      inList: listResp.body.includes(TOKEN),
      inStderr: k.getStderr().includes(TOKEN),
    }
    record('F 令牌不在 DevToolsActivePort 里', !leakCheck.inPortFile, '')
    record('F 令牌不在 /json/list 响应里', !leakCheck.inList, '')
    record('F 令牌不在 stderr 里', !leakCheck.inStderr, '')

    k.child.kill(); await sleep(500)
  }

  // ── E 空令牌：必须全拒，不是全放行（§7 第五条）──────────────────────
  //
  // 这是最阴的一条：实现若把空串当成「令牌就是空串」，那么一个**不带头**的请求
  // 读到的也是空串，两边相等 —— 校验「通过」，而实际上等于没有鉴权。
  // 正确行为是把空/缺失当作「令牌还没到」，继续全拒。
  {
    const k = await launch({ tag: 'empty', auth: true, token: '' })
    await sleep(2500)   // 给读取与解析留足时间，确保测的不是「还没读完」
    const h = await httpTry(k.port, null, '/json/version')
    const he = await httpTry(k.port, '', '/json/version')
    const w = await wsTry(k.port, k.browserPath, null)
    record('E 空令牌 -> 不带头的 HTTP 仍被拒', h.status === 403, `status=${h.status}`)
    record('E 空令牌 -> 带空头的 HTTP 仍被拒', he.status === 403, `status=${he.status}`)
    record('E 空令牌 -> WS 仍被拒', !w.ok, w.ok ? '竟然连上了' : w.why)
    k.child.kill(); await sleep(500)
  }

  // ── G 真实的 Playwright connectOverCDP（§6.6 / §7 第三条）───────────
  {
    let pw = null
    try { pw = require(PW) } catch (e) { pw = null }
    if (!pw) {
      record('G Playwright connectOverCDP', null, `找不到 playwright-core（${PW}）—— 本条无法判定`)
    } else {
      const k = await launch({ tag: 'pw', auth: true, token: TOKEN })
      let ok = false, why = ''
      for (let i = 0; i < 40; i++) {
        const h = await httpTry(k.port, TOKEN, '/json/version')
        if (h.status === 200) break
        await sleep(250)
      }
      try {
        const browser = await pw.chromium.connectOverCDP(
          `http://127.0.0.1:${k.port}`, { headers: { 'X-FP-DevTools-Token': TOKEN } })
        const ctx = browser.contexts()[0] || (await browser.newContext())
        const page = ctx.pages()[0] || (await ctx.newPage())
        await page.goto('about:blank')
        ok = (await page.evaluate('1+1')) === 2
        await browser.close()
      } catch (e) { why = String(e.message || e).split('\n')[0] }
      record('G Playwright 带令牌能驱动浏览器', ok, why)

      // 反例：同一条路径不带令牌必须连不上。没有这条，G 只证明了「能连」，
      // 证明不了「鉴权在起作用」。
      let noTokenConnected = false
      try {
        const b2 = await pw.chromium.connectOverCDP(`http://127.0.0.1:${k.port}`)
        noTokenConnected = true
        await b2.close()
      } catch (e) {}
      record('G 反例：Playwright 不带令牌连不上', !noTokenConnected,
        noTokenConnected ? '竟然连上了' : '')
      k.child.kill(); await sleep(500)
    }
  }

  // ── 汇总 ────────────────────────────────────────────────────────────
  console.log('')
  let bad = 0, undec = 0
  for (const r of results) {
    if (r.pass === null) { undec++; console.log(`  ? ${r.name}  ${r.detail}`); continue }
    if (!r.pass) { bad++; console.log(`  X ${r.name}  ${r.detail}`) }
    else console.log(`  OK ${r.name}`)
  }
  console.log('')
  if (bad) { console.log(`X ${bad} 项未通过（${undec} 项无法判定）。`); process.exit(1) }
  if (undec) console.log(`   ${undec} 项无法判定，未计入通过。`)
  console.log('OK HTTP 与 WS 两条路径都校验令牌；未配置时行为不变；空令牌按未配置处理。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
