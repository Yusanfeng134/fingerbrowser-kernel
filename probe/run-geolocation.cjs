// geolocation：坐标要对，而且要和权限状态**自洽**。
//
// ── 被测属性 ────────────────────────────────────────────────────────────
//
// 法国人格报出杭州的坐标是矛盾。但把坐标改对**还不够** —— 伪装本身会造出第二个
// 矛盾，而且更容易被读到：
//
//   Geolocation::StartRequest 在任何权限检查之前就用伪装坐标应答并 return。
//   弹窗不出现，内容设置不被写，于是 permissions.query 仍报 'prompt'，
//   而 getCurrentPosition() 一毫秒就拿到坐标。
//
// 这一对在原版 Chrome 里够不着：'prompt' 意味着用户还没决定，要成功拿到位置就
// 必须弹窗、等用户、最后停在 'granted'。所以报 'prompt' 不是「没伪装好」，是
// **阳性的篡改证据** —— 和当年 headless Chrome 那个经典破绽同一个形状（通知权限
// 的声称与实际行为对不上）。站点两行 JS 就能读。
//
// 修法是在 Permissions::GetOrCreatePermissionStatusListener 里把 geolocation 的
// 状态改成 granted：这个浏览器确实会无条件应答地理位置，granted 才是对它的诚实
// 描述。
//
// ── 判据 ────────────────────────────────────────────────────────────────
//
//   1 坐标等于策略里配的值，且 accuracy > 0（真实设备不会报 0）
//   2 permissions.query 报 granted —— 与「一毫秒返回坐标」自洽
//   3 watchPosition 也拿到伪装坐标。它是第二个入口，只堵 getCurrentPosition
//     会被从这里绕过去
//   4 **反例**：策略里不配 geolocation 时，状态必须仍是 prompt、调用必须失败。
//     否则这个修改就成了「无条件放行地理位置」
//   5 **反例**：改动落在所有权限共用的收口上。notifications / camera 在
//     geolocation 被伪装时必须**不受影响**，否则就是把每种权限都放行了
//
// 4 和 5 比 1-3 重要：1-3 说明功能在做事，4-5 说明它**只做**该做的那件事。

const http = require('http')
const fs = require('fs')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.GEO_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const CDP = 9641
const HTTP_PORT = 8971
const LAT = 48.8566   // 巴黎
const LON = 2.3522
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!process.env.GEO_KERNEL && fs.existsSync('D:/yunbrowser-run/STALE')) {
  console.log('X D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。')
  process.exit(1)
}

function ensureFieldClear(image) {
  const { killProbeKernels, foreignKernelCount } = require('./probe-kill.cjs')
  const killed = killProbeKernels(image)
  if (killed.length) console.log(`  清掉本探针上次残留的 ${killed.length} 个进程`)
  const foreign = foreignKernelCount(image)
  if (foreign) console.log(`  注意：场上还有 ${foreign} 个非本探针的 ${image}。`)
}

const EXPR = `(async () => {
  const perm = async (name) => {
    try { return (await navigator.permissions.query({name})).state; }
    catch (e) { return 'err:' + e.name; }
  };
  const states = {
    geolocation: await perm('geolocation'),
    notifications: await perm('notifications'),
    camera: await perm('camera'),
  };
  const once = () => new Promise((res) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; res({outcome:'timeout'}); } }, 6000);
    navigator.geolocation.getCurrentPosition(
      (p) => { if (done) return; done = true; clearTimeout(to);
        res({outcome:'ok', lat:p.coords.latitude, lon:p.coords.longitude, acc:p.coords.accuracy}); },
      (e) => { if (done) return; done = true; clearTimeout(to);
        res({outcome:'error', code:e.code}); });
  });
  const watch = () => new Promise((res) => {
    let done = false, id = 0;
    const fin = (v) => { if (done) return; done = true; try { navigator.geolocation.clearWatch(id); } catch (e) {} res(v); };
    const to = setTimeout(() => fin({outcome:'timeout'}), 6000);
    id = navigator.geolocation.watchPosition(
      (p) => { clearTimeout(to); fin({outcome:'ok', lat:p.coords.latitude, lon:p.coords.longitude}); },
      (e) => { clearTimeout(to); fin({outcome:'error', code:e.code}); });
  });
  const t0 = performance.now();
  const cur = await once();
  const ms = Math.round(performance.now() - t0);
  const wat = await watch();
  return JSON.stringify({ states, ms, cur, wat });
})()`

async function run(withGeo, tag) {
  ensureFieldClear(IMAGE)
  await sleep(1000)
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html>geo')
  })
  await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r))
  const url = `http://localhost:${HTTP_PORT}/`
  const fp = {
    locale: 'fr-FR', timezone: 'Europe/Paris',
    windowSize: { width: 1280, height: 800 },
    permissionDefaults: 'ask', webrtcIpPolicy: 'default',
  }
  if (withGeo) fp.geolocation = { latitude: LAT, longitude: LON }
  const pf = `${WORKDIR}/policy-geo-${tag}.json`
  fs.writeFileSync(pf, JSON.stringify({
    schemaVersion: 1, profileId: 'geo', runtimeChannel: 'custom-kernel',
    fingerprintPolicy: fp,
  }), 'utf8')
  const child = spawn(KERNEL, ['--headless=new', '--no-first-run',
    '--disable-background-networking', `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${WORKDIR}/prof-geo-${tag}`,
    `--fingerbrowser-policy=${pf}`, '--fp-active', url], { stdio: 'ignore' })

  let ws = null
  for (let i = 0; i < 50 && !ws; i++) {
    await sleep(500)
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      const t = l.find((x) => x.type === 'page')
      if (t) ws = t.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) { srv.close(); child.kill(); throw new Error(`内核未起来（${tag}）`) }
  const s = new WebSocket(ws)
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej })
  const ev = (e, id, aw) => new Promise((r) => {
    s.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) r(d.result?.result?.value ?? '') }
    s.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { returnByValue: true, awaitPromise: !!aw, expression: e } }))
  })
  let landed = false
  for (let i = 0; i < 40 && !landed; i++) {
    const h = await ev('location.href', 700 + i)
    if (String(h).startsWith(url)) landed = true; else await sleep(250)
  }
  if (!landed) { s.close(); srv.close(); child.kill(); throw new Error('导航未落地') }
  const out = await ev(EXPR, 1, true)
  s.close(); srv.close(); child.kill()
  await sleep(800)
  return JSON.parse(out)
}

;(async () => {
  let bad = 0
  const on = await run(true, 'on')
  const off = await run(false, 'off')

  console.log(`  配了坐标   权限 geo=${on.states.geolocation} notif=${on.states.notifications} cam=${on.states.camera}`)
  console.log(`             getCurrentPosition ${on.cur.outcome} ${on.cur.lat},${on.cur.lon} acc=${on.cur.acc} (${on.ms}ms)`)
  console.log(`             watchPosition      ${on.wat.outcome} ${on.wat.lat},${on.wat.lon}`)
  console.log(`  没配坐标   权限 geo=${off.states.geolocation} notif=${off.states.notifications} cam=${off.states.camera}`)
  console.log(`             getCurrentPosition ${off.cur.outcome} code=${off.cur.code}`)
  console.log('')

  // 1 坐标
  if (on.cur.outcome !== 'ok' || on.cur.lat !== LAT || on.cur.lon !== LON) {
    bad++; console.log(`X getCurrentPosition 没给出配置的坐标（期望 ${LAT},${LON}）`)
  } else if (!(on.cur.acc > 0)) {
    bad++; console.log(`X accuracy 是 ${on.cur.acc} —— 真实设备不会报 0，这本身是个破绽。`)
  } else {
    console.log(`  OK 坐标 ${LAT},${LON}，accuracy ${on.cur.acc}`)
  }

  // 2 自洽
  if (on.states.geolocation !== 'granted') {
    bad++
    console.log(`X 伪装生效时 permissions.query 报 '${on.states.geolocation}'，而位置 ${on.ms}ms 就返回了 ——`)
    console.log("  'prompt' + 瞬时成功在原版 Chrome 里够不着，这是阳性的篡改证据。")
  } else {
    console.log(`  OK permissions.query 报 granted —— 与「${on.ms}ms 返回坐标」自洽`)
  }

  // 3 第二个入口
  if (on.wat.outcome !== 'ok' || on.wat.lat !== LAT || on.wat.lon !== LON) {
    bad++; console.log(`X watchPosition 没给出配置的坐标（${on.wat.outcome} ${on.wat.lat},${on.wat.lon}）—— 可从这里绕过去。`)
  } else {
    console.log('  OK watchPosition 同样是配置的坐标')
  }

  // 4 反例：没配就不该放行
  if (off.states.geolocation !== 'prompt') {
    bad++; console.log(`X 没配坐标时权限也变成了 '${off.states.geolocation}' —— 成了无条件放行。`)
  } else if (off.cur.outcome === 'ok') {
    bad++; console.log('X 没配坐标时竟拿到了位置。')
  } else {
    console.log("  OK 没配坐标时权限仍是 prompt、调用失败 —— 没有无条件放行")
  }

  // 5 反例：不得波及其他权限（改动在共用收口上）
  for (const [k, v] of Object.entries(on.states)) {
    if (k === 'geolocation') continue
    if (v === 'granted') {
      bad++
      console.log(`X ${k} 在 geolocation 被伪装时也变成了 granted —— 改动波及了整个权限收口。`)
    }
  }
  if (on.states.notifications !== 'granted' && on.states.camera !== 'granted') {
    console.log('  OK notifications / camera 未受影响 —— 改动只作用于 geolocation')
  }

  console.log('')
  if (bad) { console.log(`X ${bad} 项未通过。`); process.exit(1) }
  console.log('OK 坐标正确，且与权限状态自洽；未越界放行其他权限。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
