// 盘点 WebGL 参数与扩展，判断「不伪装」到底暴露了什么。
//
// 先不急着加开关：MAX_TEXTURE_SIZE 这类上限在 ANGLE/D3D11 后端上很多是 ANGLE
// 自己钉死的，跨 GPU 一致；而另一些确实随硬件变。分不清这两类就加开关，客户端
// 填一个与所声称 GPU 不符的值，等于把「未伪装」换成「矛盾」—— 后者更严重。
//
// 所以本脚本只做一件事：把全部参数与扩展列出来，并对照「声称的 GPU」标注哪些
// 值是可疑的。判断该不该伪装、伪装成什么，需要一张真实设备的参照表，这台机器
// 给不出。
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

const http = require('http')
const { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const KERNEL = 'D:/yunbrowser-run/yunbrowser.exe'
const CDP = 9655
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const PROBE = `(() => {
  const out = {};
  for (const ver of ['webgl', 'webgl2']) {
    const gl = document.createElement('canvas').getContext(ver);
    if (!gl) { out[ver] = null; continue; }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const names = [
      'VENDOR','RENDERER','VERSION','SHADING_LANGUAGE_VERSION',
      'MAX_TEXTURE_SIZE','MAX_CUBE_MAP_TEXTURE_SIZE','MAX_RENDERBUFFER_SIZE',
      'MAX_VIEWPORT_DIMS','MAX_TEXTURE_IMAGE_UNITS',
      'MAX_COMBINED_TEXTURE_IMAGE_UNITS','MAX_VERTEX_TEXTURE_IMAGE_UNITS',
      'MAX_VERTEX_ATTRIBS','MAX_VERTEX_UNIFORM_VECTORS',
      'MAX_FRAGMENT_UNIFORM_VECTORS','MAX_VARYING_VECTORS',
      'ALIASED_LINE_WIDTH_RANGE','ALIASED_POINT_SIZE_RANGE',
      'RED_BITS','GREEN_BITS','BLUE_BITS','ALPHA_BITS','DEPTH_BITS','STENCIL_BITS',
      'SUBPIXEL_BITS','MAX_SAMPLES','MAX_3D_TEXTURE_SIZE','MAX_ARRAY_TEXTURE_LAYERS',
      'MAX_DRAW_BUFFERS','MAX_ELEMENT_INDEX','MAX_UNIFORM_BUFFER_BINDINGS',
    ];
    const params = {};
    for (const n of names) {
      if (!(n in gl)) continue;
      try {
        const v = gl.getParameter(gl[n]);
        params[n] = (v && v.length !== undefined && typeof v !== 'string')
            ? Array.from(v).join(',') : v;
      } catch (e) { /* 该版本不支持，跳过 */ }
    }
    // 各着色器阶段的精度也随硬件/驱动变
    const prec = {};
    try {
      for (const st of ['VERTEX_SHADER', 'FRAGMENT_SHADER']) {
        for (const p of ['HIGH_FLOAT', 'MEDIUM_FLOAT', 'HIGH_INT']) {
          const r = gl.getShaderPrecisionFormat(gl[st], gl[p]);
          prec[st + '.' + p] = r ? [r.rangeMin, r.rangeMax, r.precision].join('/') : null;
        }
      }
    } catch (e) {}

    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      params.MAX_ANISOTROPY = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    }

    out[ver] = {
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      params, prec,
      extensions: (gl.getSupportedExtensions() || []).sort(),
    };
  }
  return JSON.stringify(out);
})()`

async function measure(label, extraArgs, profile) {
  ensureFieldClear('yunbrowser.exe')
  await sleep(1500)
  const srv = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    s.end('<!doctype html><meta charset=utf-8><body>gl')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/`
  spawn(KERNEL, ['--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`,
    ...extraArgs, url], { stdio: 'ignore' })
  await sleep(11000)
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  const t = list.find(x => x.type === 'page')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  const raw = await new Promise((resolve) => {
    ws.on('message', m => { const d = JSON.parse(m); if (d.id === 1) resolve(d.result?.result?.value) })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression: PROBE, returnByValue: true } }))
    setTimeout(() => resolve(null), 15000)
  })
  ws.close()
  ensureFieldClear('yunbrowser.exe')
  srv.close()
  return raw ? JSON.parse(raw) : null
}

;(async () => {
  // 对照组：不伪装 GPU，拿到宿主真实值
  const real = await measure('真实', [],
    'D:/chromium-work-151/probe/prof-gl-real')
  // 实验组：伪装成另一块卡
  const fake = await measure('伪装', [
    '--fp-gpu-vendor=Google Inc. (Intel)',
    '--fp-gpu-renderer=ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ], 'D:/chromium-work-151/probe/prof-gl-fake')

  if (!real || !fake) { console.log('测量失败'); process.exit(1) }

  console.log('\n=== 声称的 GPU ===')
  console.log('  真实组: ' + real.webgl.unmaskedRenderer)
  console.log('  伪装组: ' + fake.webgl.unmaskedRenderer)

  console.log('\n=== 伪装 GPU 后，哪些参数**没有**跟着变（即仍是宿主真值）===')
  let same = 0, diff = 0
  for (const k of Object.keys(real.webgl.params)) {
    const a = real.webgl.params[k], b = fake.webgl.params[k]
    if (String(a) === String(b)) { same++ } else { diff++; console.log(`  ≠ ${k}: ${a} -> ${b}`) }
  }
  console.log(`  相同 ${same} 项，不同 ${diff} 项`)

  console.log('\n=== 扩展列表是否随伪装变化 ===')
  const ra = real.webgl.extensions, fa = fake.webgl.extensions
  const onlyReal = ra.filter(x => !fa.includes(x))
  const onlyFake = fa.filter(x => !ra.includes(x))
  console.log(`  真实 ${ra.length} 个，伪装 ${fa.length} 个`)
  if (onlyReal.length) console.log('  仅真实组有: ' + onlyReal.join(', '))
  if (onlyFake.length) console.log('  仅伪装组有: ' + onlyFake.join(', '))
  if (!onlyReal.length && !onlyFake.length) console.log('  完全一致')

  console.log('\n=== 着色器精度是否随伪装变化 ===')
  let precDiff = 0
  for (const k of Object.keys(real.webgl.prec)) {
    if (real.webgl.prec[k] !== fake.webgl.prec[k]) {
      precDiff++; console.log(`  ≠ ${k}: ${real.webgl.prec[k]} -> ${fake.webgl.prec[k]}`)
    }
  }
  if (!precDiff) console.log('  完全一致')

  // 真正该守的性质：GPU 身份只应出现在我们控制的那两个字符串里。参数值与扩展名
  // 若出现厂商词，说明有第二条泄漏通道 —— 那才是需要伪装的东西。
  //
  // 这条断言不脆：它不锁定具体数值（ANGLE 升级、驱动更新都会改数值），只锁定
  // 「厂商信息不从别处漏出去」这个不变量。
  console.log('\n=== 厂商词是否只出现在 unmasked 字符串里 ===')
  const VENDOR_WORDS = /nvidia|geforce|intel|amd|radeon|adreno|mali|apple|qualcomm/i
  const leaks = []
  for (const [k, v] of Object.entries(fake.webgl.params)) {
    if (VENDOR_WORDS.test(String(v))) leaks.push(`参数 ${k} = ${v}`)
  }
  for (const e of fake.webgl.extensions) {
    if (VENDOR_WORDS.test(e)) leaks.push(`扩展 ${e}`)
  }
  for (const [k, v] of Object.entries(fake.webgl.prec)) {
    if (VENDOR_WORDS.test(String(v))) leaks.push(`精度 ${k} = ${v}`)
  }
  if (leaks.length === 0) {
    console.log('  ✓ 无泄漏 —— 厂商信息仅存在于 unmaskedVendor / unmaskedRenderer')
  } else {
    console.log('  ✗ 存在第二条泄漏通道：')
    leaks.forEach(l => console.log('     ' + l))
  }

  console.log('\n=== 宿主真实参数全量（供判断哪些值可疑）===')
  for (const [k, v] of Object.entries(real.webgl.params)) console.log(`  ${k.padEnd(34)} ${v}`)
  console.log('\n  扩展: ' + ra.join(', '))
  process.exit(0)
})()
