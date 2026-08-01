// 完全越界的 getImageData 必须返回全零，不能被扰动。
//
// ── 被测属性 ────────────────────────────────────────────────────────────
//
// 读取区域与画布完全不相交时，readPixels 失败，缓冲区保持零初始化。若在这上面
// 施加 canvas 扰动，会产出 **非零 RGB + 零 alpha** —— 没有任何原生浏览器会这样。
//
// 危害等级要说清：本来是「未伪装」的无害情形（返回一片零，谁都一样），被我们
// 自己的噪声变成了「矛盾」。矛盾是**阳性证据** —— 它证明的不是画布内容，是
// 「这个浏览器被改过」。用一个防指纹的功能制造出一个指纹，是最坏的那种缺陷。
//
// 151 上不出现，因为上游在噪声块之前就早退了（`!snapshot_rect.Intersects(...)`
// 时直接 return）。那段是 124 之后才进上游的，所以 151 白拿了正确行为。
//
// ── 判据必须能区分三种情形 ──────────────────────────────────────────────
//
//   全零              正确
//   非零 RGB + 零 α   本缺陷：被扰动了
//   全非零            另一回事（读到了真实内容），说明测试构造错了，不是缺陷
//
// 只判「是不是全零」会把后两者混为一谈，而第三种意味着**这次测量根本没测到
// 越界读**，此时报「失败」是误报。

if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('X D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。')
  process.exit(1)
}

const http = require('http')
const { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

// 默认测 124（缺陷在那边）；用 CANVAS_OOB_KERNEL 指向 151 做对照。
const KERNEL = process.env.CANVAS_OOB_KERNEL ||
  'D:/chromium-work/chromium/src/out/FingerBrowser/chrome.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work/probe-canvas-oob'
const CDP = 9491
const HTTP_PORT = 8797

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureFieldClear(image) {
  // 只清本探针自己的 profile，按 --user-data-dir 过滤，**不按镜像名**。
  // 这台机器上客户端外壳、店铺环境、探针内核共用同一个可执行文件名，按名字杀
  // 等于无差别清场 —— 已经造成两次实际破坏。见 probe-kill.cjs 的说明。
  const { killProbeKernels, foreignKernelCount } = require('./probe-kill.cjs')
  const killed = killProbeKernels(image)
  if (killed.length) console.log(`  清掉本探针上次残留的 ${killed.length} 个进程`)
  const foreign = foreignKernelCount(image)
  if (foreign) {
    console.log(`  注意：场上还有 ${foreign} 个非本探针的 ${image}（客户端在跑）——`)
    console.log('  不影响本次测量（profile 隔离），但异常时值得先想到这一点。')
  }
}

// 画布必须 >= kMinCanvasNoisePixels（1024 像素）才会被扰动 —— 小画布本就豁免，
// 拿小画布测等于测了一个恒定通过的前提。64x64 = 4096，稳稳超过。
const PAGE = `<!doctype html><meta charset=utf-8><body><div id=o>pending</div>
<script>
(() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: false });
  // 画点东西，确保画布有真实内容 —— 全白画布上「被扰动」和「没扰动」都可能
  // 看起来像零，那样这次测量什么都证明不了。
  g.fillStyle = '#3366cc'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#ffcc00'; g.fillRect(8, 8, 20, 20);

  // 完全越界：从 (500,500) 读 16x16，与 64x64 画布毫无交集。
  const d = g.getImageData(500, 500, 16, 16).data;
  let rgbNonZero = 0, alphaNonZero = 0, allNonZero = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] || d[i+1] || d[i+2]) rgbNonZero++;
    if (d[i+3]) alphaNonZero++;
    if (d[i] && d[i+1] && d[i+2] && d[i+3]) allNonZero++;
  }
  // 同时取一次**界内**读作为前提检查：若界内读也全零，说明画布根本没画上，
  // 那么越界读全零就不构成证据。
  const inb = g.getImageData(0, 0, 16, 16).data;
  let inboundNonZero = 0;
  for (let i = 0; i < inb.length; i += 4) if (inb[i] || inb[i+1] || inb[i+2]) inboundNonZero++;

  document.getElementById('o').textContent = JSON.stringify({
    px: d.length / 4, rgbNonZero, alphaNonZero, allNonZero, inboundNonZero,
  });
})();
</script></body>`

;(async () => {
  ensureFieldClear(IMAGE)
  await sleep(800)

  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    r.end(PAGE)
  })
  await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r))
  const url = `http://localhost:${HTTP_PORT}/`

  // 必须带 canvas 种子，否则扰动整个不启用 —— 那样测出「全零」是因为功能没开，
  // 与「守卫生效」不可区分。
  const child = spawn(KERNEL, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-background-networking',
    '--fp-canvas-noise=855777316',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORKDIR}`, url,
  ], { stdio: 'ignore' })

  let ws = null
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500)
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      const p = l.find((t) => t.type === 'page')
      if (p) ws = p.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) { srv.close(); child.kill(); console.log('X 内核未起来'); process.exit(1) }

  const s = new WebSocket(ws)
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej })

  const evalIn = (expr, id) => new Promise((res) => {
    s.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) res(d.result?.result?.value ?? '') }
    s.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { returnByValue: true, expression: expr } }))
  })

  // 等导航落地：target 列表里的 URL 是「打算去哪」，不是「现在在哪」。
  let landed = false
  for (let i = 0; i < 40 && !landed; i++) {
    const href = await evalIn('location.href', 900 + i)
    if (String(href).startsWith(url)) landed = true; else await sleep(250)
  }
  if (!landed) { s.close(); srv.close(); child.kill(); console.log('X 导航未落地'); process.exit(1) }

  let out = 'pending'
  for (let i = 0; i < 20 && out === 'pending'; i++) {
    out = await evalIn("document.getElementById('o').textContent", 100 + i)
    if (out === 'pending') await sleep(300)
  }
  s.close(); srv.close(); child.kill()
  await sleep(400)

  if (!out || out === 'pending') { console.log('X 页面没写出结果'); process.exit(1) }
  const r = JSON.parse(out)
  console.log(`  内核: ${KERNEL.split('/').slice(-3).join('/')}`)
  console.log(`  越界读 ${r.px} 像素：RGB 非零 ${r.rgbNonZero}，alpha 非零 ${r.alphaNonZero}`)
  console.log(`  界内读 RGB 非零 ${r.inboundNonZero}（前提检查）`)
  console.log('')

  // 前提：界内读必须有内容，否则越界读全零不构成证据。
  if (r.inboundNonZero === 0) {
    console.log('X 界内读也全零 —— 画布没画上，或扰动没启用。')
    console.log('  这种情况下越界读全零**不能**说明守卫生效，本次测量无意义。')
    process.exit(1)
  }

  if (r.rgbNonZero === 0 && r.alphaNonZero === 0) {
    console.log('OK 越界读返回全零 —— 守卫生效。')
    process.exit(0)
  }
  if (r.allNonZero > 0 && r.alphaNonZero === r.px) {
    console.log('! 越界读拿到了完整像素（alpha 也满）—— 这不是本缺陷，')
    console.log('  是测试构造有问题：读取区域其实与画布相交了。')
    process.exit(1)
  }
  console.log(`X 越界读被扰动了：${r.rgbNonZero} 个像素有非零 RGB 而 alpha 为零。`)
  console.log('  没有任何原生浏览器会产出这种组合 —— 这是阳性的「被改过」证据，')
  console.log('  比不伪装更糟。')
  process.exit(1)
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
