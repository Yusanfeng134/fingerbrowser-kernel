// 盘点当前内核在一个「美国 Windows 人格」下的指纹矛盾。
//
// 不用旧的 CreepJS 报告当依据：那份报告出具之后又落了十几个补丁，拿它排优先级
// 等于在过期数据上做决策。这里直接量当前内核。
//
// 关注「矛盾」而非「未伪装」。两者危害不同：
//   未伪装 = 暴露真实值，检测方看到一个普通用户；
//   矛盾   = 两个本该一致的值对不上，检测方看到的是「有人动过手脚」。
// 后者是阳性证据，比前者严重得多。
if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('✗ D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。先跑 build-and-sync.sh。')
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

const http = require('http')
const { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const KERNEL = 'D:/yunbrowser-run/yunbrowser.exe'
const PROFILE = 'D:/chromium-work-151/probe/prof-creepjs'
const CDP = 9601
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 一个自洽的美国 Windows 人格
const PERSONA = [
  '--fp-accept-lang=en-US',
  '--fp-timezone=America/New_York',
  '--fp-platform=Win32',
  '--fp-screen-width=1920',
  '--fp-screen-height=1080',
  '--fp-hardware-concurrency=8',
  '--fp-device-memory=8',
  '--fp-gpu-vendor=Google Inc. (NVIDIA)',
  '--fp-gpu-renderer=ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  '--fp-block-cjk-fonts',
  '--fp-dpr-x1000=1000',
  '--fp-max-touch-points=0',
  `--fp-platform-version=${'15.0.0'}`,
]

// Windows 上 platformVersion 是 WinRT Universal API Contract 版本。15.0.0 对应
// Win11 22H2/23H2 —— 目前装机量最大的档位之一。本机真实值是 19.0.0（24H2+），
// 罕见即高熵。
const EXPECTED_PLATFORM_VERSION = '15.0.0'

const PROBE = `(async () => {
  const ua = navigator.userAgent;
  let ch = {};
  try {
    ch = await navigator.userAgentData.getHighEntropyValues(
      ['platform', 'platformVersion', 'architecture', 'model', 'uaFullVersion', 'bitness']);
  } catch (e) { ch = { error: String(e) }; }

  // getVoices() 是异步填充的：首次调用几乎必然返回空数组。第一版脚本直接取
  // 它的长度，于是「0 个 CJK 语音」是空列表造成的，与是否真的屏蔽无关 ——
  // 一条永远通过的断言。这里等 voiceschanged 或超时。
  const voices = await new Promise((resolve) => {
    const read = () => speechSynthesis.getVoices().map(v => v.lang + '|' + v.name);
    const first = read();
    if (first.length) { resolve(first); return; }
    speechSynthesis.addEventListener('voiceschanged', () => resolve(read()), { once: true });
    setTimeout(() => resolve(read()), 4000);
  });

  const gl = (() => {
    const c = document.createElement('canvas').getContext('webgl');
    if (!c) return null;
    const d = c.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: c.getParameter(c.VENDOR),
      renderer: c.getParameter(c.RENDERER),
      unmaskedVendor: d ? c.getParameter(d.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: c.getParameter(c.MAX_TEXTURE_SIZE),
      maxViewportDims: Array.from(c.getParameter(c.MAX_VIEWPORT_DIMS) || []),
      maxRenderbufferSize: c.getParameter(c.MAX_RENDERBUFFER_SIZE),
      extCount: (c.getSupportedExtensions() || []).length,
      shadingLangVersion: c.getParameter(c.SHADING_LANGUAGE_VERSION),
    };
  })();

  return JSON.stringify({
    ua,
    ch,
    lang: navigator.language,
    langs: navigator.languages,
    platform: navigator.platform,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: [screen.width, screen.height],
    avail: [screen.availWidth, screen.availHeight],
    colorDepth: screen.colorDepth,
    dpr: devicePixelRatio,
    cssPx: [
      // 二分法量出媒体查询认为的屏幕宽度（CSS 像素）
      (() => { let lo = 0, hi = 20000; while (hi - lo > 1) { const m = (lo + hi) >> 1;
        if (matchMedia('(min-device-width:' + m + 'px)').matches) lo = m; else hi = m; } return lo; })(),
      (() => { let lo = 0, hi = 20000; while (hi - lo > 1) { const m = (lo + hi) >> 1;
        if (matchMedia('(min-device-height:' + m + 'px)').matches) lo = m; else hi = m; } return lo; })(),
    ],
    maxTouchPoints: navigator.maxTouchPoints,
    ontouchstart: 'ontouchstart' in window,
    touchEvent: typeof TouchEvent !== 'undefined',
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    voicesCount: voices.length,
    voicesCjk: voices.filter(v => /^(zh|ja|ko)/.test(v)),
    voicesSample: voices.slice(0, 6),
    gl,
  });
})()`

;(async () => {
  ensureFieldClear('yunbrowser.exe')
  await sleep(1500)

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset=utf-8><title>audit</title><body>audit')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/`

  spawn(KERNEL, ['--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP}`,
    ...PERSONA, url], { stdio: 'ignore' })
  await sleep(11000)

  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const t = list.find(x => x.type === 'page')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  const raw = await new Promise((resolve) => {
    ws.on('message', m => { const d = JSON.parse(m); if (d.id === 1) resolve(d.result?.result?.value) })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression: PROBE, returnByValue: true, awaitPromise: true } }))
    setTimeout(() => resolve(null), 20000)
  })
  ws.close()
  ensureFieldClear('yunbrowser.exe')
  srv.close()

  if (!raw) { console.log('求值失败'); process.exit(1) }
  const r = JSON.parse(raw)

  const say = (label, val) => console.log(`  ${label.padEnd(26)} ${val}`)
  console.log('\n【人格：美国 Windows，screen 1920x1080】\n')
  say('UA', r.ua)
  say('CH platform', `${r.ch.platform} ${r.ch.platformVersion}`)
  say('language / languages', `${r.lang} / ${r.langs}`)
  say('platform', r.platform)
  say('timezone', r.tz)
  say('screen', r.screen.join(' x '))
  say('avail', r.avail.join(' x '))
  say('devicePixelRatio', r.dpr)
  say('媒体查询 device-width', r.cssPx.join(' x '))
  say('maxTouchPoints', r.maxTouchPoints)
  say('ontouchstart / TouchEvent', `${r.ontouchstart} / ${r.touchEvent}`)
  say('pointer:coarse', r.pointerCoarse)
  say('hardwareConcurrency', r.hardwareConcurrency)
  say('deviceMemory', r.deviceMemory)
  say('TTS 语音数 / CJK', `${r.voicesCount} / ${r.voicesCjk.length}`)
  if (r.voicesCjk.length) say('  CJK 样例', r.voicesCjk.slice(0, 3).join(', '))
  if (r.gl) {
    say('WebGL unmasked', r.gl.unmaskedRenderer)
    say('WebGL MAX_TEXTURE_SIZE', r.gl.maxTextureSize)
    say('WebGL MAX_VIEWPORT_DIMS', r.gl.maxViewportDims.join('x'))
    say('WebGL 扩展数', r.gl.extCount)
  }

  console.log('\n【矛盾检查】')
  const bad = []
  const chk = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
    if (!ok) bad.push(name)
  }

  // 第一版这条只验了「两个值都存在」，必然通过，等于没测。
  //
  // 而且它验错了对象：UA 里的 Windows NT 自 Win11 起就冻结在 10.0，Client Hints
  // 用另一套编号（13.0.0+ = Win11）。两者「不同」是**正常**的，真实 Win11 机器
  // 就这么报 —— CreepJS 报的「UA Win10 vs CH Win11」并不是矛盾，我先前转述时
  // 没有核实。
  //
  // 真正的问题是别的：platformVersion 泄漏宿主真实 OS 构建号。19.0.0 对应很新的
  // Win11，罕见 = 高熵。属于「未伪装」，不是「矛盾」，危害等级不同，不该混在
  // 一起排优先级。
  // 判据是「等于人格配置的值」，不是「小于某个数」。上一版我拍了个 <=13 的阈值，
  // 那个数字我并没有依据 —— 用编出来的阈值判定，通过与否都说明不了什么。
  chk('CH platformVersion 等于人格配置值',
      r.ch.platformVersion === EXPECTED_PLATFORM_VERSION,
      `实得 ${r.ch.platformVersion}，期望 ${EXPECTED_PLATFORM_VERSION}`)

  chk('媒体查询宽度 == screen.width',
      r.cssPx[0] === r.screen[0],
      `${r.cssPx[0]} vs ${r.screen[0]}`)

  chk('devicePixelRatio 与人格相符（桌面通常 1）',
      r.dpr === 1, String(r.dpr))

  chk('触摸信号自洽（桌面应全为否）',
      r.maxTouchPoints === 0 && !r.ontouchstart && !r.pointerCoarse,
      `maxTouchPoints=${r.maxTouchPoints} ontouchstart=${r.ontouchstart} coarse=${r.pointerCoarse}`)

  // 前提检查：语音列表为空时，「没有 CJK 语音」是空列表造成的，与屏蔽无关。
  if (r.voicesCount === 0) {
    console.log('  ? 语音列表为空 —— 本条无法判定，不计入通过（等待 voiceschanged 仍为空）')
  } else {
    chk('无 CJK 语音（en-US 人格且已屏蔽 CJK 字体）',
        r.voicesCjk.length === 0, `共 ${r.voicesCount} 个，CJK ${r.voicesCjk.length} 个`)
  }

  console.log(`\n矛盾项 ${bad.length} 个${bad.length ? '：' + bad.join('、') : ''}`)
  process.exit(0)
})()
