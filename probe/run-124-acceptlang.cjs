// 量 124 内核的 Accept-Language：JS 侧与**线上头**分别是什么。
//
// 124 里已经有两处钩子（ChromeContentBrowserClient::GetAcceptLangs、
// ProfileNetworkContextService），但 151 的教训正是「钩了这两处仍然漏」——
// 决定线上头的是 ReduceAcceptLanguageUtils，它从 intl.accept_languages 这个 pref
// 重建头部，命令行开关从未写进那个 pref。
//
// 所以不套用 151 的结论，也不假定 124 一样：直接起一个回显服务器读真实请求头。
// navigator.language 通过 ≠ Accept-Language 头通过，这两件事今天已经分开咬过一次。
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

  try { execSync('taskkill /IM chrome.exe /F /T', { stdio: 'ignore' }) } catch (e) {}
  await sleep(2000)
  require('fs').rmSync(PROFILE, { recursive: true, force: true })

  spawn(KERNEL, args, { stdio: 'ignore' })

  await sleep(12000)
  try { execSync('taskkill /IM chrome.exe /F /T', { stdio: 'ignore' }) } catch (e) {}
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
