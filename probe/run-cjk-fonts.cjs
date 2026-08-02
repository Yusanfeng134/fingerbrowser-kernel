// blockCjkFonts：枚举看不到 CJK 字体，但 CJK 文本仍然正常渲染。
//
// ── 被测属性 ────────────────────────────────────────────────────────────
//
// 一个声称 fr-FR / 美国用户的人格，装着「微软雅黑」「宋体」，是**矛盾**：
// 字体清单是高熵指纹项，而它直接暴露宿主的系统语言。
//
// 但屏蔽必须只作用于**枚举**，不能作用于**渲染**。实现的注释写得很清楚：
// 拦在显式字族查询（GetFontData / IsPlatformFamilyMatchAvailable）上，
// 不拦共享的 GetFontPlatformData —— 后者也是系统字形回退的必经之路，拦在那里
// 会让 CJK 文本渲染成豆腐块。
//
// ── 所以两条必须一起验，缺一条都会放过一个坏实现 ────────────────────────
//
//   只验「枚举看不到」   → 一个把 CJK 彻底禁掉的实现通过，而用户看到满屏豆腐
//   只验「能渲染」       → 一个什么都没做的实现通过
//
// 前者不是理论风险：实现注释说那正是第一版的行为。
//
// ── 判据 ────────────────────────────────────────────────────────────────
//
// 枚举用**经典的宽度差法**：拿一串西文在 `"目标字体", monospace` 与 `monospace`
// 下各量一次宽。目标存在则两者不同，不存在则回退到 monospace、两者相同。
//
// 这里踩过两个坑，都写下来因为它们各自坏的方式不同：
//
//   · `document.fonts.check('12px "X"')` **恒返回 true**，连 NoSuchFont123 都是。
//     它检的是「字体规范能否解析」，不是「字体是否存在」——**这个 API 从来就不能
//     用来枚举字体**。用它做判据等于用了一个恒真的东西。
//
//   · 量**中文**宽度没有判别力：CJK 字形全角等宽，8 字 × 32px 恒为 256，换任何
//     字体都一样。实测基线上 cjk / bogus / latin 三个宽度全是 256。
//     所以探测串必须是**西文**。
//
// 两条对照缺一不可：
//   Arial          屏蔽前后都必须 present —— 证明没波及不该动的
//   NoSuchFont123  屏蔽前后都必须不 present —— 证明这个技术真的有判别力，
//                  而不是「什么都报不存在」
//
// 逐字族前提检查：基线上探测不到的字族标为**不可判别**，不计入通过也不计入
// 失败。宿主没装、或该字体的度量恰好与 monospace 相同，都会落在这里。

const http = require('http')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const KERNEL = process.env.CJK_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const CDP = 9591
const HTTP_PORT = 8921
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!process.env.CJK_KERNEL && require('fs').existsSync('D:/yunbrowser-run/STALE')) {
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

const EXPR = `(() => {
  const c = document.createElement('canvas').getContext('2d');
  // 西文探测串：混合宽窄字符，放大字族间的度量差异。
  const S = 'mmmmmmmmmmlli WWWW ABC xyz 12345';
  const w = (font) => { c.font = '48px ' + font; return c.measureText(S).width };
  const probe = (family) => {
    const base = w('monospace');
    const test = w('"' + family + '", monospace');
    return Math.abs(test - base) > 0.5;   // 与回退不同 = 该字族存在
  };
  const seen = {};
  for (const f of ['Microsoft YaHei', '微软雅黑', 'SimSun', '宋体',
                   'MS Gothic', 'Malgun Gothic', 'Arial', 'NoSuchFont123'])
    seen[f] = probe(f);
  // 渲染仍须正常：屏蔽只该作用于枚举。CJK 文本宽度在屏蔽前后应当不变。
  c.font = '32px "Microsoft YaHei"';
  const cjkWidth = c.measureText('中文测试').width;
  return JSON.stringify({ seen, cjkWidth });
})()`

async function measure(block, tag) {
  ensureFieldClear(IMAGE)
  await sleep(1000)
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    r.end('<!doctype html><meta charset=utf-8><body>cjk')
  })
  await new Promise((r) => srv.listen(HTTP_PORT, '127.0.0.1', r))
  const url = `http://localhost:${HTTP_PORT}/`
  const args = ['--headless=new', '--no-first-run', '--disable-background-networking',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORKDIR}/prof-cjk-${tag}`]
  if (block) args.push('--fp-block-cjk-fonts')
  args.push(url)
  const child = spawn(KERNEL, args, { stdio: 'ignore' })

  let ws = null
  for (let i = 0; i < 60 && !ws; i++) {
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
  const ev = (e, id) => new Promise((r) => {
    s.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) r(d.result?.result?.value ?? '') }
    s.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { returnByValue: true, expression: e } }))
  })
  let landed = false
  for (let i = 0; i < 40 && !landed; i++) {
    const h = await ev('location.href', 700 + i)
    if (String(h).startsWith(url)) landed = true; else await sleep(250)
  }
  if (!landed) { s.close(); srv.close(); child.kill(); throw new Error('导航未落地') }
  const out = await ev(EXPR, 1)
  s.close(); srv.close(); child.kill()
  await sleep(600)
  return JSON.parse(out)
}

;(async () => {
  const base = await measure(false, 'base')
  const blk = await measure(true, 'block')

  const CJK = ['Microsoft YaHei', '微软雅黑', 'SimSun', '宋体', 'MS Gothic', 'Malgun Gothic']
  let bad = 0, undecidable = 0, checked = 0

  console.log('  字族'.padEnd(22) + '基线      屏蔽后')
  for (const f of CJK) {
    const b = base.seen[f], a = blk.seen[f]
    console.log('  ' + f.padEnd(20) + String(b).padEnd(10) + String(a))
    if (!b) { undecidable++; continue }   // 基线就探测不到 -> 不可判别
    checked++
    if (a) { bad++; console.log(`  X ${f} 屏蔽后仍可探测到`) }
  }
  console.log('  ' + 'Arial（对照）'.padEnd(18) + String(base.seen['Arial']).padEnd(10) + String(blk.seen['Arial']))
  console.log('  ' + 'NoSuchFont（对照）'.padEnd(16) + String(base.seen['NoSuchFont123']).padEnd(10) + String(blk.seen['NoSuchFont123']))
  console.log(`  CJK 文本宽度        ${base.cjkWidth}       ${blk.cjkWidth}`)
  console.log('')

  // 前提：至少有一个 CJK 字族在基线上探测得到，否则本条测不了。
  if (checked === 0) {
    console.log('? 基线上一个 CJK 字族都探测不到 —— 宿主可能没装，或度量恰好与')
    console.log('  monospace 相同。「屏蔽后探测不到」于是什么都证明不了。')
    process.exit(2)
  }
  // 对照一：技术必须有判别力。
  if (base.seen['NoSuchFont123'] || blk.seen['NoSuchFont123']) {
    console.log('X 对照失败：不存在的字族被探测为「存在」—— 这个技术在此环境无判别力，')
    console.log('  上面所有结论都不可信。')
    process.exit(1)
  }
  // 对照二：不该波及西文。
  if (!base.seen['Arial'] || !blk.seen['Arial']) {
    bad++
    console.log('X Arial 在屏蔽前后不都为 present —— 波及了不该动的字族。')
  }
  // 渲染必须未受影响。
  if (blk.cjkWidth !== base.cjkWidth) {
    bad++
    console.log(`X CJK 文本宽度变了（${base.cjkWidth} -> ${blk.cjkWidth}）—— 屏蔽拦进了渲染路径。`)
  }

  if (!bad) {
    console.log(`OK ${checked} 个可判别的 CJK 字族在屏蔽后全部探测不到`)
    console.log('OK 对照成立：不存在的字族两次都探测不到、Arial 两次都在')
    console.log('OK CJK 文本渲染宽度未变 —— 屏蔽只作用于枚举')
  }
  if (undecidable) console.log(`   （${undecidable} 个字族基线就探测不到，不可判别，未计入）`)
  console.log('')
  if (bad) { console.log(`X ${bad} 项未通过。`); process.exit(1) }
  console.log('OK 枚举屏蔽生效，且未波及渲染。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
