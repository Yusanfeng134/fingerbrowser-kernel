// 拒绝在陈旧内核上跑：同步未走完时 sync-kernel-run.ps1 会留下 STALE。
// 没有这道检查的话，「同步失败」只是一条没人读的日志 —— 今天已经因此白测过两轮。
if (require('fs').existsSync('D:/yunbrowser-run/STALE')) {
  console.log('✗ D:/yunbrowser-run 带 STALE 标记：内核可能是旧的。先跑 build-and-sync.sh。')
  process.exit(1)
}

// 验证原生 profile 的创建路径被堵住了。
//
// 这个需求最容易假通过的地方：只看「头像面板里那几项没了」。原生 profile 至少有
// 三条可达路径，换掉气泡只拿掉其中一条，而洞还在——菜单里看不见和做不到是两回事。
//
// 所以这里逐条验**能力**，不数菜单项：
//   1. chrome://profile-picker 能否导航到（地址栏直达，不走命令）
//   2. IDC_ADD_NEW_PROFILE / IDC_OPEN_GUEST_PROFILE / IDC_MANAGE_CHROME_PROFILES
//      是否已禁用（禁用则头像气泡与三点菜单里的项一并失效）
//   3. ★ 不传 --fp-shell 时上述一切照旧（否则就是把普通 Chromium 用法也砸了）
//
// 第 3 条是反例：只验「堵住了」而不验「该通的仍通」，等于无法区分「精确堵洞」
// 和「一刀切砸掉功能」。

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

const { spawn, execSync } = require('child_process')

const KERNEL = 'D:\\yunbrowser-run\\yunbrowser.exe'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const WebSocket = require('ws')

async function probe({ label, shell, cdp, profile }) {
  ensureFieldClear('yunbrowser.exe')
  await sleep(1500)

  const args = ['--no-first-run', '--no-default-browser-check',
                `--user-data-dir=${profile}`, `--remote-debugging-port=${cdp}`]
  if (shell) args.push('--fp-shell')
  args.push('about:blank')
  spawn(KERNEL, args, { stdio: 'ignore' })
  await sleep(9000)

  const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()
  const target = list.find(t => t.type === 'page')
  if (!target) throw new Error(`${label}: 浏览器没起来`)

  // 用一个新标签页导航到 profile-picker，看是否被拒。
  const nav = await fetch(`http://127.0.0.1:${cdp}/json/new?chrome://profile-picker/`,
                          { method: 'PUT' }).catch(() => null)
  await sleep(3500)
  const after = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()
  const picker = after.find(t => (t.url || '').startsWith('chrome://profile-picker'))

  // 验页面内容，不验标题。Chromium 在页面加载失败时把 URL 当标题，于是「标题非空」
  // 对失败页同样成立 —— 用标题判断会把「被挡住」读成「可达」。这里直接问文档里
  // 有没有东西：真正的选择器有 shadow DOM 宿主元素，错误页/空文档没有。
  let pickerReachable = false
  let evidence = '(未创建标签)'
  if (picker && picker.webSocketDebuggerUrl) {
    const ws2 = new WebSocket(picker.webSocketDebuggerUrl)
    await new Promise(r => ws2.on('open', r))
    const val = await new Promise((resolve) => {
      const id = 991
      ws2.on('message', (m) => {
        const d = JSON.parse(m)
        if (d.id === id) resolve(d.result?.result?.value)
      })
      ws2.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        expression: `(() => {
          const el = document.querySelector('profile-picker-app');
          return JSON.stringify({
            hasApp: !!el,
            bodyLen: (document.body ? document.body.innerText.length : 0),
            title: document.title
          });
        })()`, returnByValue: true } }))
      setTimeout(() => resolve(null), 8000)
    })
    ws2.close()
    const info = val ? JSON.parse(val) : null
    pickerReachable = !!(info && info.hasApp)
    evidence = info ? `profile-picker-app=${info.hasApp}, 正文${info.bodyLen}字, 标题「${info.title}」` : '(求值超时)'
  }

  ensureFieldClear('yunbrowser.exe')
  return { pickerReachable, pickerTitle: evidence }
}

;(async () => {
  console.log('【外壳形态：传 --fp-shell，应堵住】')
  const shell = await probe({
    label: 'shell', shell: true, cdp: 9481,
    profile: 'D:\\chromium-work-151\\probe\\prof-hole-shell',
  })
  console.log(`  chrome://profile-picker 可达: ${shell.pickerReachable ? '✗ 仍可达' : '✓ 已挡住'}  — ${shell.pickerTitle}`)

  console.log('\n【普通形态：不传 --fp-shell，应一切照旧（反例）】')
  const plain = await probe({
    label: 'plain', shell: false, cdp: 9482,
    profile: 'D:\\chromium-work-151\\probe\\prof-hole-plain',
  })
  console.log(`  chrome://profile-picker 可达: ${plain.pickerReachable ? '✓ 仍可达（正确）' : '✗ 被误伤'}  — ${plain.pickerTitle}`)

  const ok = !shell.pickerReachable && plain.pickerReachable
  console.log(`\n${ok ? '★ 程序验通过' : '★ 程序验未通过'}`)
  console.log(`
---------------------------------------------------------
 【需要你看】命令禁用只能靠肉眼——菜单启用状态 CDP 读不到。

 请用外壳形态（带 --fp-shell）起一个窗口，检查：

 A. 三点菜单 → 个人资料子菜单
    「添加新的个人资料」「打开访客资料」「管理…个人资料」
    → 应为**灰色不可点**

 B. 右上角头像气泡里的同名三项
    → 同样应为灰色不可点

 C. 随便点一下，确认真的点不动（不是只看着灰）
---------------------------------------------------------`)
  process.exit(ok ? 0 : 1)
})()
