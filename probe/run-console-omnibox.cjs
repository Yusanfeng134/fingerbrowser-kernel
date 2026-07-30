// 拒绝在陈旧内核上跑：同步未走完时 sync-kernel-run.ps1 会留下 STALE。
// 没有这道检查的话，「同步失败」只是一条没人读的日志 —— 今天已经因此白测过两轮。
if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('✗ D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。先跑 build-and-sync.sh。')
  process.exit(1)
}

// 验证管理台地址栏改写：把 127.0.0.1:<随机端口> 显示成产品名 + 挂锁。
//
// 复刻客户端的真实形态：本地 HTTP 服务用 listen(0) 拿 OS 分配的随机端口
// （见 Yunlogin/src/main/local-server.ts:424），SPA 路由走 hash。
// 这两点正是判定规则必须按 origin 而非整串 URL 比对的原因。
const http = require('http')
const { spawn } = require('child_process')

const KERNEL = 'D:\\chromium-work-151\\src\\out\\FingerBrowser\\yunbrowser.exe'
const PROFILE = 'D:\\chromium-work-151\\probe\\prof-console'
const TITLE = 'YunLogin 管理中心'

const page = (label) => `<!doctype html><meta charset=utf-8>
<title>${label}</title>
<body style="font:16px/1.8 system-ui;padding:40px">
<h2>${label}</h2>
<p>当前地址：<code id=u></code></p>
<p><a href="#/yunlogin-environments">切到 #/yunlogin-environments</a>
 · <a href="#/proxies">切到 #/proxies</a>
 · <a href="/settings">切到 /settings（子路径）</a></p>
<script>
 const show = () => document.getElementById('u').textContent = location.href
 show(); addEventListener('hashchange', show)
</script>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page(req.url === '/settings' ? '管理台 · 子路径' : '管理台 · 首页'))
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/`

  const child = spawn(KERNEL, [
    '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--fp-pinned-url=${url}`,
    `--fp-console-title=${TITLE}`,
    url,
  ], { stdio: 'ignore' })

  console.log(`
=========================================================
 管理台地址栏验证

 本次随机端口：${port}
 真实 URL    ：${url}
 期望显示    ：🔒 ${TITLE}

 请依次确认：

 1. 地址栏显示「${TITLE}」而不是 ${url}
 2. 左侧是挂锁，不是 http 的灰色 ⓘ
 3. 点一下地址栏 —— 不应露出真实 URL，且打不进字（只读）
 4. 点页内「#/yunlogin-environments」「#/proxies」
    —— 换路由后仍显示产品名（这条是按 origin 匹配的意义）
 5. 点「/settings」子路径 —— 同样仍显示产品名
 6. ★ 反例：新开一个标签页访问 https://example.com
    —— 必须正常显示 example.com，否则是规则放太松

 关掉浏览器即结束。
=========================================================
`)

  child.on('exit', () => { server.close(); console.log('已结束'); process.exit(0) })
  setTimeout(() => { try { child.kill() } catch (e) {} process.exit(0) }, 30 * 60 * 1000)
})
