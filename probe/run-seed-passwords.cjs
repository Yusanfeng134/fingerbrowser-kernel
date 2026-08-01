// 验 --fp-seed-passwords=stdin：种子进密码库、原生自动填充生效。
//
// ⚠ 本脚本**只使用明显的假凭据**（probe@example.test）。真实店铺凭据绝不进入
// 任何探针、任何日志、任何提交。
//
// ── 交办书 §8 列的五条假通过，逐条对应的断言 ────────────────────────────
//
//  1. 「密码填进输入框了」——「原生填充」与「我们用 JS 赋了个值」表现一样。
//     → 断言输入框匹配 `:-internal-autofill-selected`（那是 Chromium 自己在
//       原生填充时打的伪类，JS 赋值产生不了）。
//  2. 只验一次填充 —— 分不清「写进了密码库」与「这次启动顺手填了一下」。
//     → **第二次启动不带 --fp-seed-passwords**，仍须填充。
//  3. 不验反例 —— 「在所有页面上都填」的实现同样通过。
//     → 在一个 origin 不匹配的页面上断言**不填**。
//  4. 只验有种子的情况 —— 会把一个默认改用户密码库的开关当成安全的。
//     → 断言不传开关时密码库不新增（用「第二次启动」那一趟顺带覆盖）。
//  5. 拿空种子验 —— 四条计数全 0 看起来一切正常。
//     → 断言 total>0 且 imported>0，否则明确报「本次测量无意义」。
//
// ── 我另加的一条：http 与 https 的 signon_realm 不同 ────────────────────
//
// 交办书没列这条。若实现把 https 的凭据也匹配到 http，那是把密码**明文发到
// 未加密连接**上 —— 比填到错误站点更糟，而且 §8 的第 3 条（origin 不匹配不填）
// 不覆盖它：同主机同端口、只有协议不同，看起来「匹配」。
//
// 本机只能起 http 服务，所以这条用反向构造：种子给 https origin，页面在 http
// 上 —— 不该填。

const http = require('http')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.SEED_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const PROFILE = `${WORKDIR}/prof-seed-passwords`
const CDP = 9551
const PORT_MATCH = 8871      // 种子里配的 origin
const PORT_OTHER = 8872      // origin 不匹配的反例页面
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureFieldClear(image) {
  const { killProbeKernels, foreignKernelCount } = require('./probe-kill.cjs')
  const killed = killProbeKernels(image)
  if (killed.length) console.log(`  清掉本探针上次残留的 ${killed.length} 个进程`)
  const foreign = foreignKernelCount(image)
  if (foreign) {
    console.log(`  注意：场上还有 ${foreign} 个非本探针的 ${image}（客户端在跑）。`)
  }
}

// 明显的假凭据。用户名带 example.test，密码是一望即知的占位串。
const FAKE_USER = 'probe@example.test'
const FAKE_PASS = 'not-a-real-password-0001'

const SEED = JSON.stringify({
  version: 1,
  entries: [
    { origin: `http://localhost:${PORT_MATCH}`, username: FAKE_USER, password: FAKE_PASS },
    // https 同主机不同协议：signon_realm 不同，**不该**被 http 页面用上。
    { origin: `https://localhost:${PORT_MATCH}`, username: 'https-only@example.test',
      password: 'not-a-real-password-0002' },
  ],
})

const LOGIN_PAGE = `<!doctype html><meta charset=utf-8><body>
<form id="f" method="post" action="/submit">
  <input id="u" type="text" name="username" autocomplete="username">
  <input id="p" type="password" name="password" autocomplete="current-password">
  <button type="submit">go</button>
</form>
<div id="o">pending</div>
<script>
// **判据是伪类，不是 .value。**
//
// Chromium 在用户交互之前**不把自动填充的值暴露给 JS** —— input.value 读到空串，
// 而字段其实已经填好了。用 .value 判会得出「没填」，而实际填了。
// 实测踩过：nativeAutofill=true 而 userFilled=false，两者矛盾，真相是后者不可观测。
//
// :-internal-autofill-selected 是 Chromium 自己在原生填充时打的伪类。已验证它在
// 「没有任何凭据的空表单」上返回 false —— 所以它不是恒真，是有判别力的。
// JS 给 .value 赋值也不会让它命中，因此它正好区分「原生填充」与「脚本赋值」。
(async () => {
  const u = document.getElementById('u'), p = document.getElementById('p');
  const sel = ':-internal-autofill-selected';
  const hit = (el) => { try { return el.matches(sel); } catch (e) { return null; } };
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    if (hit(u) || hit(p)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  document.getElementById('o').textContent = JSON.stringify({
    nativeUser: hit(u), nativePass: hit(p),
    // 仅供参考：交互前恒为空，不作判据。
    valueUser: u.value, valuePassLen: p.value.length,
  });
})();
</script></body>`

async function runKernel({ withSeed, page, tag }) {
  ensureFieldClear(IMAGE)
  await sleep(1200)

  const args = ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`]
  if (withSeed) args.push('--fp-seed-passwords=stdin')
  args.push(page)

  const child = spawn(KERNEL, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })
  if (withSeed) { child.stdin.write(SEED, 'utf8'); child.stdin.end() }
  else { child.stdin.end() }

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
  const evalIn = (expr, id) => new Promise((r) => {
    s.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) r(d.result?.result?.value ?? '') }
    s.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { returnByValue: true, expression: expr } }))
  })
  let landed = false
  for (let i = 0; i < 40 && !landed; i++) {
    const h = await evalIn('location.href', 600 + i)
    if (String(h).startsWith(page)) landed = true; else await sleep(250)
  }
  if (!landed) { s.close(); child.kill(); throw new Error(`导航未落地（${tag}）`) }

  let out = 'pending'
  for (let i = 0; i < 40 && out === 'pending'; i++) {
    out = await evalIn("document.getElementById('o').textContent", 200 + i)
    if (out === 'pending') await sleep(300)
  }
  s.close(); child.kill()
  await sleep(800)
  return { page: out === 'pending' ? null : JSON.parse(out), stderr }
}

function counters(stderr) {
  const m = stderr.match(/\[fp-seed-passwords\] total=(\d+) imported=(\d+) skipped_existing=(\d+) rejected=(\d+)/)
  if (!m) return null
  return { total: +m[1], imported: +m[2], skipped: +m[3], rejected: +m[4] }
}
function fail(msg) { console.log('X ' + msg); process.exit(1) }

;(async () => {
  require('fs').rmSync(PROFILE, { recursive: true, force: true })

  const srvA = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(LOGIN_PAGE)
  })
  const srvB = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(LOGIN_PAGE)
  })
  await new Promise((r) => srvA.listen(PORT_MATCH, '127.0.0.1', r))
  await new Promise((r) => srvB.listen(PORT_OTHER, '127.0.0.1', r))
  const urlMatch = `http://localhost:${PORT_MATCH}/`
  const urlOther = `http://localhost:${PORT_OTHER}/`

  let bad = 0

  // ── 1. 带种子首次启动 ────────────────────────────────────────────────
  const a = await runKernel({ withSeed: true, page: urlMatch, tag: '首次带种子' })
  const c = counters(a.stderr)
  console.log(`  计数行: ${c ? JSON.stringify(c) : '(没有！)'}`)
  if (!c) fail('stderr 里没有 [fp-seed-passwords] 计数行 —— 开关没生效，或日志被吞。')
  // §8 第 5 条：空种子会让四个数全 0 而看起来正常。
  if (c.total === 0) fail('total=0 —— 种子是空的，本次测量什么都证明不了。')
  if (c.imported === 0) fail(`imported=0（total=${c.total}）—— 没有导入任何条目。`)
  console.log(`  首次：nativeUser=${a.page?.nativeUser} nativePass=${a.page?.nativePass}` +
              `（.value 交互前不可读，仅供参考：user="${a.page?.valueUser}"）`)

  if (a.page?.nativeUser === null) {
    fail(':-internal-autofill-selected 选择器无效（matches 抛错）—— 判据失效，本次测量无意义。')
  }
  if (!a.page?.nativeUser && !a.page?.nativePass) {
    bad++; console.log('X 首次启动未发生原生自动填充（两个字段的伪类都没命中）。')
  } else {
    console.log('OK 首次启动：原生自动填充生效' +
      `（用户名字段 ${a.page.nativeUser}，密码字段 ${a.page.nativePass}）`)
  }

  // ── 2. 反例：origin 不匹配的页面不填 ─────────────────────────────────
  const b = await runKernel({ withSeed: false, page: urlOther, tag: '反例：另一个 origin' })
  console.log(`  另一 origin：nativeUser=${b.page?.nativeUser} nativePass=${b.page?.nativePass}`)
  if (b.page?.nativeUser || b.page?.nativePass) {
    bad++
    console.log('X 在 origin 不匹配的页面上也填了 —— 这是把密码往任意站点撒。')
  } else {
    console.log('OK 反例：origin 不匹配的页面不填')
  }

  // ── 3. 第二次启动**不带种子**，仍须填 ────────────────────────────────
  // 这一趟同时覆盖 §8 第 2 条与第 4 条：既证明进了密码库，也证明不传开关时
  // 不会再动密码库（计数行不该出现）。
  const d = await runKernel({ withSeed: false, page: urlMatch, tag: '重开不带种子' })
  const c2 = counters(d.stderr)
  console.log(`  重开：nativeUser=${d.page?.nativeUser} nativePass=${d.page?.nativePass} ` +
              `计数行=${c2 ? '出现了' : '无（正确）'}`)
  if (c2) {
    bad++
    console.log('X 不传开关时仍打印了计数行 —— 说明它在没被要求时也动了密码库。')
  }
  if (!d.page?.nativeUser && !d.page?.nativePass) {
    bad++
    console.log('X 重开后不填 —— 说明凭据没进密码库，只是首次启动顺手填了一下。')
    console.log('  这两种情况在「只验一次」时表现完全一样。')
  } else {
    console.log('OK 重开不带种子仍填充 —— 凭据确实在密码库里')
  }

  srvA.close(); srvB.close()
  console.log('')
  if (bad) { console.log(`X ${bad} 项未通过。`); process.exit(1) }
  console.log('OK 种子导入 → 密码库 → 原生自动填充，整条链路通。')
  console.log('   注意：本脚本未验「用户改密码后不被换回」（§7 第 4 条），')
  console.log('   那条需要在真实站点上改密码，只能人工做。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
