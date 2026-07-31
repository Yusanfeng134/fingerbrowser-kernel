// 量 124 内核的 Accept-Language：JS 侧与**线上头**分别是什么。
//
// 124 里已经有两处钩子（ChromeContentBrowserClient::GetAcceptLangs、
// ProfileNetworkContextService），但 151 的教训正是「钩了这两处仍然漏」——
// 决定线上头的是 ReduceAcceptLanguageUtils，它从 intl.accept_languages 这个 pref
// 重建头部，命令行开关从未写进那个 pref。
//
// 所以不套用 151 的结论，也不假定 124 一样：直接起一个回显服务器读真实请求头。
// navigator.language 通过 ≠ Accept-Language 头通过，这两件事今天已经分开咬过一次。

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

const KERNEL = 'D:/chromium-work/chromium/src/out/FingerBrowser/chrome.exe'
const PROFILE = 'D:/chromium-work-151/probe/prof-124-lang'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

;(async () => {
  const fs = require('fs')
  if (!fs.existsSync(KERNEL)) {
    console.log('✗ 找不到 124 内核: ' + KERNEL)
    process.exit(1)
  }

  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push({
      url: req.url,
      acceptLanguage: req.headers['accept-language'] || '(无)',
      // 高熵 Client Hints 也一并看：它们与 Accept-Language 属同一族「线上头」
      chLang: req.headers['sec-ch-lang'] || null,
      ua: (req.headers['user-agent'] || '').slice(0, 60),
    })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset=utf-8><title>lang</title><body>
<div id="js"></div>
<script>
  document.getElementById('js').textContent = JSON.stringify({
    language: navigator.language,
    languages: navigator.languages,
  });
  // 再发一个子请求：主文档的头与子资源的头可能不同路径生成
  fetch('/sub?x=1');
</script>`)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/`

  // 两组配置的差分。策略侧同时下发 --lang 与 --fp-accept-lang，若只靠 --lang
  // 起作用，那我们那两处钩子其实是死代码 —— 「能用」与「知道为什么能用」是两件
  // 事，而只测一组配置分不开这两者。
  const withLang = process.argv.includes('--no-lang') ? false : true
  const args = [
    '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    '--fp-active',
    ...(process.argv.includes('--no-fp') ? [] : ['--fp-accept-lang=en-US']),
    '--fp-platform=Win32',
  ]
  if (withLang) args.push('--lang=en-US')
  args.push(url)
  console.log(`配置：${withLang ? '带 --lang=en-US' : '**不带** --lang（仅靠 fp-accept-lang）'}`)

  ensureFieldClear('chrome.exe')
  await sleep(2000)
  require('fs').rmSync(PROFILE, { recursive: true, force: true })

  spawn(KERNEL, args, { stdio: 'ignore' })

  await sleep(12000)
  ensureFieldClear('chrome.exe')
  srv.close()

  console.log('\n=== 124 内核收到的请求 ===')
  if (!seen.length) { console.log('  （没有请求到达 —— 内核可能没起来）'); process.exit(1) }
  for (const r of seen) {
    console.log(`  ${r.url}`)
    console.log(`     Accept-Language: ${r.acceptLanguage}`)
  }

  console.log('\n=== 判定 ===')
  const main = seen[0]
  const ok = /^en-US/.test(main.acceptLanguage)
  console.log(`  ${ok ? '✓' : '✗'} 主文档 Accept-Language 以 en-US 开头 — 实得「${main.acceptLanguage}」`)
  if (!ok) {
    console.log('     → 线上头仍是宿主 locale。JS 侧通过与线上头通过是两件事。')
  }
  const subs = seen.slice(1)
  if (subs.length) {
    const subOk = subs.every(s => /^en-US/.test(s.acceptLanguage))
    console.log(`  ${subOk ? '✓' : '✗'} 子资源请求头一致 — ${subs.map(s => s.acceptLanguage).join(' / ')}`)
  } else {
    console.log('  ? 没有子资源请求到达，该项无法判定')
  }
  process.exit(ok ? 0 : 1)
})()
