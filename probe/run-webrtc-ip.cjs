// webrtcIpPolicy：WebRTC 不得漏出宿主真实公网 IP。
//
// ── 被测属性 ────────────────────────────────────────────────────────────
//
// 这是**矛盾**里最贵的一种：HTTP 走代理出法国，WebRTC 的 srflx 候选却带着宿主
// 在杭州的真实公网 IP。站点两边一比就知道代理是假的 —— 而且这条不需要任何指纹
// 技巧，一个 RTCPeerConnection 加一个公共 STUN 就能读到。
//
// ── 实现 ────────────────────────────────────────────────────────────────
//
// 策略 `disable_non_proxied_udp` 在渲染侧被翻成 `enable_nonproxied_udp = false`，
// P2PPortAllocator 据此设上 PORTALLOCATOR_DISABLE_UDP | DISABLE_STUN |
// DISABLE_UDP_RELAY。没有 UDP 就没有 STUN 往返，也就没有 srflx。
//
// 注意这条不是走 pref：kWebRTCIPHandlingPolicy 那个 pref 在本构建里没人写，
// 渲染侧直接读 `fp-webrtc-ip-policy` 开关。这正是当初漏 IP 的成因。
//
// ── 判据 ────────────────────────────────────────────────────────────────
//
// 三趟，全部走**策略 JSON 路径**（不是命令行直传 fp-* —— 0026 的三处失效就是
// 从那个缝里逃掉的）：
//
//   A `webrtcIpPolicy: 'default'`
//       必须收到一个带公网 IP 的 srflx 候选。这一趟同时是**前提**和**反例**：
//       · 前提 —— STUN 不通时「没有 srflx」什么都证明不了
//       · 反例 —— 证明这个探针**看得见**泄漏，而不是恒返回「没漏」
//
//   B `webrtcIpPolicy: 'disable_non_proxied_udp'`
//       不得有 srflx，且 A 里那个 IP 不得出现在任何候选里。
//
//   C `webrtcIpPolicy: 'default_public_interface_only'`
//       内核必须**拒绝启动**。这个值在渲染侧其实有实现，但策略层只收 default 和
//       disable_non_proxied_udp 两个 —— 而实测表明它**照样漏公网 IP**（它只去掉
//       host 候选，srflx 原样保留）。一个听起来像在保护你、实际不保护的值，能被
//       策略层挡住，这件事本身值得钉住。
//
// C 还顺带验了一条更重要的性质：非法策略是 **fail-closed** 的 —— 中止启动，而不是
// 带着宿主真实指纹裸奔。这个方向如果哪天被改成「忽略非法字段继续跑」，本条会响。
//
// ── 这个探针**没有**覆盖什么 ────────────────────────────────────────────
//
// 真正的危害是「代理 IP ≠ WebRTC IP」，验它需要一个真代理。这里验的是产生那个
// 矛盾的**机制**（srflx 候选）被掐掉了。挂代理后的端到端一致性仍需人工确认。

const http = require('http')
const fs = require('fs')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.WEBRTC_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const CDP = 9631
const HTTP_PORT = 8961
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!process.env.WEBRTC_KERNEL && fs.existsSync('D:/yunbrowser-run/STALE')) {
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

const policyFor = (v) => ({
  schemaVersion: 1, profileId: 'webrtc', runtimeChannel: 'custom-kernel',
  fingerprintPolicy: {
    locale: 'fr-FR', timezone: 'Europe/Paris',
    windowSize: { width: 1280, height: 800 },
    permissionDefaults: 'deny',
    webrtcIpPolicy: v,
  },
})

const GATHER = `(async () => {
  const pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  const cands = [];
  pc.onicecandidate = e => { if (e.candidate) cands.push(e.candidate.candidate); };
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise(r => { const t = setTimeout(r, 10000);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } }; });
  const state = pc.iceGatheringState;
  pc.close();
  return JSON.stringify({ state, cands });
})()`

// 一趟：起内核、收候选。返回 null 表示内核没起来（C 期望的就是这个）。
async function gather(policyValue, tag) {
  ensureFieldClear(IMAGE)
  await sleep(1000)
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html>webrtc')
  })
  await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r))
  const url = `http://localhost:${HTTP_PORT}/`
  const pf = `${WORKDIR}/policy-webrtc-${tag}.json`
  fs.writeFileSync(pf, JSON.stringify(policyFor(policyValue)), 'utf8')
  const child = spawn(KERNEL, ['--headless=new', '--no-first-run',
    '--disable-background-networking', `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${WORKDIR}/prof-webrtc-${tag}`,
    `--fingerbrowser-policy=${pf}`, '--fp-active', url], { stdio: 'ignore' })

  let exitCode = null
  child.on('exit', (c) => { exitCode = c })

  let ws = null
  for (let i = 0; i < 50 && !ws && exitCode === null; i++) {
    await sleep(500)
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      const t = l.find((x) => x.type === 'page')
      if (t) ws = t.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) {
    // 再给退出事件一点时间落地，好区分「拒绝启动」与「起得太慢」。
    for (let i = 0; i < 10 && exitCode === null; i++) await sleep(300)
    srv.close(); child.kill()
    return { started: false, exitCode }
  }
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
  if (!landed) { s.close(); srv.close(); child.kill(); throw new Error(`导航未落地（${tag}）`) }
  const out = await ev(GATHER, 1, true)
  s.close(); srv.close(); child.kill()
  await sleep(800)
  return { started: true, ...JSON.parse(out) }
}

const srflxOf = (cands) => cands.filter((c) => c.includes('typ srflx'))
const ipOf = (cand) => (cand.match(/ (\d+\.\d+\.\d+\.\d+) /) || [])[1] || null

;(async () => {
  let bad = 0

  // ── A：基线，必须能看见泄漏 ──
  const a = await gather('default', 'default')
  if (!a.started) { console.log('X 基线内核没起来 —— 后面两趟无从比较。'); process.exit(1) }
  const aSrflx = srflxOf(a.cands)
  const leakedIp = aSrflx.length ? ipOf(aSrflx[0]) : null
  console.log(`  A default                        候选 ${a.cands.length} 个，srflx ${aSrflx.length} 个`)
  a.cands.forEach((c) => console.log('      ' + c.slice(0, 110)))

  if (!leakedIp) {
    console.log('')
    console.log('? 基线拿不到 srflx 候选 —— STUN 不通（离线 / 出网被拦 / UDP 被防火墙挡）。')
    console.log('  这种情况下「屏蔽后没有 srflx」与「本来就没有」不可区分，本条测不了。')
    process.exit(2)
  }
  console.log(`  → 基线确实漏出公网 IP ${leakedIp} —— 探针看得见泄漏，反例成立。`)
  console.log('')

  // ── B：屏蔽 ──
  const b = await gather('disable_non_proxied_udp', 'blocked')
  if (!b.started) { console.log('X disable_non_proxied_udp 让内核起不来了 —— 合法值不该被拒。'); process.exit(1) }
  const bSrflx = srflxOf(b.cands)
  console.log(`  B disable_non_proxied_udp        候选 ${b.cands.length} 个，srflx ${bSrflx.length} 个`)
  b.cands.forEach((c) => console.log('      ' + c.slice(0, 110)))
  if (b.state !== 'complete') {
    console.log(`  ! gathering 状态是 ${b.state}，不是 complete —— 可能只是还没收完，`)
    console.log('    而不是真的没有候选。下面的结论按「已收完」判，注意这层不确定。')
  }
  if (bSrflx.length) {
    bad++
    console.log('X 屏蔽后仍有 srflx 候选 —— 公网 IP 照漏。')
  } else {
    console.log('  OK 屏蔽后无 srflx 候选')
  }
  if (b.cands.some((c) => c.includes(leakedIp))) {
    bad++
    console.log(`X 屏蔽后仍有候选带着基线那个公网 IP ${leakedIp}。`)
  } else {
    console.log(`  OK 基线那个公网 IP ${leakedIp} 未出现在任何候选里`)
  }
  console.log('')

  // ── C：契约边界 + fail-closed ──
  const c = await gather('default_public_interface_only', 'rejected')
  console.log(`  C default_public_interface_only  started=${c.started} exitCode=${c.exitCode}`)
  if (c.started) {
    bad++
    console.log('X 策略层接受了这个值 —— 但它只去掉 host 候选，srflx 里的公网 IP 原样保留，')
    console.log('  也就是说它看起来在保护你、实际不保护。策略层应当拒绝它。')
  } else if (c.exitCode === 0 || c.exitCode === null) {
    bad++
    console.log(`X 内核没起来，但退出码是 ${c.exitCode} —— 分不清是拒绝启动还是崩了/超时。`)
  } else {
    console.log(`  OK 内核拒绝启动（退出码 ${c.exitCode}，非零）—— 非法策略 fail-closed，`)
    console.log('     不会带着宿主真实指纹裸奔。（不钉具体码值：它由上游枚举推导，会随版本漂。）')
  }

  console.log('')
  if (bad) { console.log(`X ${bad} 项未通过。`); process.exit(1) }
  console.log('OK WebRTC 不再漏出宿主真实公网 IP，且非法策略值被挡在启动前。')
  console.log('   未覆盖：挂真代理后「代理 IP == 出口 IP」的端到端一致性，需人工确认。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
