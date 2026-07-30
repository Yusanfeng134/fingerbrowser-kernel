// P1 verification: do passkeys survive closing and reopening the environment?
//
// Run 1: register a passkey, then close the browser entirely.
// Run 2: SAME profile directory, ?mode=auth -- only sign in, register nothing.
//        Success means the credential (and its private key) came back from the
//        encrypted store on disk.
//
// A third check confirms isolation: a DIFFERENT profile must NOT see it.
const { spawn } = require('child_process')
const fs = require('fs')

const KERNEL = 'D:\\chromium-work-151\\src\\out\\FingerBrowser\\yunbrowser.exe'
const POLICY = 'D:\\chromium-work-151\\probe\\p0-passkey-policy.json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runOnce({ profile, url, port, label }) {
  const child = spawn(KERNEL, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--fingerbrowser-policy=${POLICY}`,
    url
  ], { stdio: 'ignore' })

  let ws = null
  for (let i = 0; i < 50 && !ws; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) ws = page.webSocketDebuggerUrl
    } catch (e) {}
  }
  if (!ws) { child.kill(); return { label, error: 'no devtools target' } }

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

  const deadline = Date.now() + 35000
  let title = ''
  while (Date.now() < deadline) {
    await sleep(1000)
    try {
      const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
      title = (r && r.result && r.result.value) || ''
      if (title.startsWith('WA:')) break
    } catch (e) {}
  }
  try { sock.close() } catch (e) {}
  child.kill()
  await sleep(2500)  // let the browser flush the store on shutdown
  return { label, result: title.startsWith('WA:') ? JSON.parse(title.slice(3)) : null, raw: title }
}

;(async () => {
  console.log('P1 verification starting; kernel =', KERNEL)
  if (!fs.existsSync(KERNEL)) { console.log('KERNEL NOT FOUND'); process.exit(1) }
  const profA = 'D:\\chromium-work-151\\probe\\prof-p1-a'
  const profB = 'D:\\chromium-work-151\\probe\\prof-p1-b'
  for (const p of [profA, profB]) {
    try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) {}
  }

  const r1 = await runOnce({ profile: profA, url: 'http://localhost:8791/webauthn', port: 9470, label: 'run1-register' })
  console.log('RUN1 (register):', r1.result ? r1.result.verdict : r1.raw || r1.error)

  const storePath = profA + '\\Default\\FingerBrowserPasskeys'
  const storeRoot = profA + '\\FingerBrowserPasskeys'
  const found = [storePath, storeRoot].filter((p) => fs.existsSync(p))
  console.log('STORE FILE:', found.length ? found[0] + ' (' + fs.statSync(found[0]).size + ' bytes)' : 'NOT FOUND')
  if (found.length) {
    const buf = fs.readFileSync(found[0])
    const looksPlain = buf.includes(Buffer.from('privateKey')) || buf.includes(Buffer.from('credentials'))
    console.log('PLAINTEXT LEAK CHECK:', looksPlain ? '*** FAIL: readable field names on disk ***' : 'OK (encrypted)')
  }

  const r2 = await runOnce({ profile: profA, url: 'http://localhost:8791/webauthn?mode=auth', port: 9471, label: 'run2-auth-same-profile' })
  console.log('RUN2 (same profile, auth only):', r2.result ? r2.result.verdict : r2.raw || r2.error)
  if (r2.result) console.log('   authenticate:', JSON.stringify(r2.result.authenticate))

  const r3 = await runOnce({ profile: profB, url: 'http://localhost:8791/webauthn?mode=auth', port: 9472, label: 'run3-auth-other-profile' })
  console.log('RUN3 (different profile, auth only):', r3.result ? r3.result.verdict : r3.raw || r3.error)
  if (r3.result) console.log('   authenticate:', JSON.stringify(r3.result.authenticate))
  console.log('')
  console.log('期望: RUN1 OK / RUN2 OK(凭据跨重启存活) / RUN3 FAILED(环境隔离)')
  process.exit(0)
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
