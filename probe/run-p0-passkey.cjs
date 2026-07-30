// P0 verification: the kernel must provision a passkey authenticator purely
// from the policy file -- no CDP virtual authenticator involved.
//
// Control: the earlier `run-webauthn.cjs control` run, where
// navigator.credentials.create() hung forever (no authenticator present).
const { spawn } = require('child_process')

const KERNEL = 'D:\\chromium-work-151\\src\\out\\FingerBrowser\\yunbrowser.exe'
const POLICY = 'D:\\chromium-work-151\\probe\\p0-passkey-policy.json'
const PROFILE = 'D:\\chromium-work-151\\probe\\prof-p0-passkey'
const PORT = 9460

const child = spawn(KERNEL, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--fingerbrowser-policy=${POLICY}`,
  // localhost, not 127.0.0.1: a bare IP is not a valid WebAuthn RP ID.
  'http://localhost:8791/webauthn'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  let ws = null
  for (let i = 0; i < 50 && !ws; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) ws = page.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) { console.log('NO-TARGET'); child.kill(); process.exit(1) }

  const sock = new WebSocket(ws)
  let seq = 0
  const pending = new Map()
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject })
    sock.send(JSON.stringify({ id, method, params }))
  })
  await new Promise((r) => sock.addEventListener('open', r, { once: true }))

  const deadline = Date.now() + 40000
  let title = ''
  while (Date.now() < deadline) {
    await sleep(1000)
    try {
      const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
      title = (r && r.result && r.result.value) || ''
      if (title.startsWith('WA:')) break
    } catch (e) {}
  }
  console.log('---RESULT---')
  console.log(title.startsWith('WA:') ? title.slice(3) : 'STILL-PENDING (no authenticator provisioned) title=' + title)
  try { sock.close() } catch (e) {}
  child.kill()
  process.exit(0)
})().catch((e) => { console.error('ERROR:', e.message); try { child.kill() } catch (_) {} process.exit(1) })
