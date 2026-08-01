// 验 --fp-seed-passwords 的五条错误路径各自出对的那一行。
//
// ── 为什么单独写一个 ────────────────────────────────────────────────────
//
// run-seed-passwords.cjs 只验成功路径。客户端会话的原话：**「错误路径不验，
// 等于只验了它成功的样子。」**
//
// 而错误行是客户端排查「填充没生效」时唯一的线索 —— 一条出不来、或者出错了
// 内容，就把一次可诊断的失败变成一次沉默的失败。
//
// ── 判据必须逐条可分辨 ──────────────────────────────────────────────────
//
// 只断言「stderr 里有 error=」是不够的：那样五种成因里任何一种都通过，而一个
// 「不管什么问题都报 not_json_object」的实现同样能过 —— 它会把排查引向错误
// 方向，比不报更贵。所以逐条断言**具体的那个 reason**。
//
// 反向也要断言：成功路径上**不该**出现任何 error= 行。少了这条，一个「总是
// 多打一行 error」的实现照样通过。

const { spawn } = require('child_process')

const KERNEL = process.env.SEED_KERNEL || 'D:/yunbrowser-run/yunbrowser.exe'
const IMAGE = KERNEL.split(/[\\/]/).pop()
const WORKDIR = 'D:/chromium-work-151/probe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureFieldClear(image) {
  const { killProbeKernels, foreignKernelCount } = require('./probe-kill.cjs')
  const killed = killProbeKernels(image)
  if (killed.length) console.log(`  清掉本探针上次残留的 ${killed.length} 个进程`)
  const foreign = foreignKernelCount(image)
  if (foreign) console.log(`  注意：场上还有 ${foreign} 个非本探针的 ${image}。`)
}

// 每条用例都用**全新 profile**：判重会让第二次跑变成 skipped_existing，
// 那会把「成功路径不该有 error」这条断言的前提悄悄换掉。
async function run(seedText, tag) {
  ensureFieldClear(IMAGE)
  await sleep(1000)
  const profile = `${WORKDIR}/prof-seed-err-${tag}`
  require('fs').rmSync(profile, { recursive: true, force: true })

  const child = spawn(KERNEL, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--fp-seed-passwords=stdin',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['pipe', 'ignore', 'pipe'] })

  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })
  if (seedText !== null) child.stdin.write(seedText, 'utf8')
  child.stdin.end()

  // 导入是异步的（读 stdin -> 解析 -> 查库 -> 写库），给足时间再收。
  await sleep(9000)
  child.kill()
  await sleep(800)
  return stderr
}

const FAKE = { origin: 'http://localhost:8891', username: 'probe@example.test',
               password: 'not-a-real-password-0003' }

const CASES = [
  { tag: 'notjson', seed: 'this is not json at all',
    wantError: 'not_json_object',
    why: '种子不是 JSON 对象' },
  { tag: 'noentries', seed: JSON.stringify({ version: 1 }),
    wantError: 'no_entries_list',
    why: 'JSON 合法但没有 entries 列表' },
  { tag: 'empty', seed: '',
    wantError: null, wantCounters: { total: 0 },
    why: '空 stdin —— 不是错误，应当四个数全 0' },
  { tag: 'badentry',
    seed: JSON.stringify({ version: 1, entries: [
      { origin: 'not-a-url', username: 'a@example.test', password: 'x' },
      { origin: 'ftp://example.test', username: 'b@example.test', password: 'x' },
      { origin: 'http://localhost:8891', username: 'c@example.test' },  // 缺 password
      FAKE,                                                             // 这条应当成功
    ] }),
    wantError: null, wantCounters: { total: 4, imported: 1, rejected: 3 },
    why: '三条畸形 + 一条合法 —— 计数应当分得清' },
  { tag: 'ok', seed: JSON.stringify({ version: 1, entries: [FAKE] }),
    wantError: null, wantCounters: { total: 1, imported: 1, rejected: 0 },
    why: '成功路径 —— **不该**出现任何 error= 行' },
]

function counters(s) {
  const m = s.match(/\[fp-seed-passwords\] total=(\d+) imported=(\d+) skipped_existing=(\d+) rejected=(\d+)/)
  return m ? { total: +m[1], imported: +m[2], skipped: +m[3], rejected: +m[4] } : null
}
function errors(s) {
  return [...s.matchAll(/\[fp-seed-passwords\] error=([a-z_]+)/g)].map((m) => m[1])
}

;(async () => {
  let bad = 0
  for (const c of CASES) {
    const s = await run(c.seed, c.tag)
    const errs = errors(s)
    const cnt = counters(s)
    console.log(`  [${c.tag}] ${c.why}`)
    console.log(`      error=${errs.length ? errs.join(',') : '(无)'}  计数=${cnt ? JSON.stringify(cnt) : '(无)'}`)

    if (c.wantError) {
      if (!errs.includes(c.wantError)) {
        bad++
        console.log(`  X 期望 error=${c.wantError}，实际 ${errs.length ? errs.join(',') : '没有任何 error 行'}`)
      } else if (errs.length > 1) {
        bad++
        console.log(`  X 期望只有 error=${c.wantError}，却出了 ${errs.length} 条：${errs.join(',')}`)
      } else {
        console.log(`  OK 报出了对的那一条：${c.wantError}`)
      }
    } else {
      // 反向断言：不该有 error 行。
      if (errs.length) {
        bad++
        console.log(`  X 本用例不该有 error 行，却出了：${errs.join(',')}`)
      } else {
        console.log('  OK 没有多余的 error 行')
      }
    }

    if (c.wantCounters) {
      if (!cnt) {
        bad++; console.log('  X 没有计数行')
      } else {
        for (const [k, v] of Object.entries(c.wantCounters)) {
          if (cnt[k] !== v) {
            bad++
            console.log(`  X 计数 ${k} 期望 ${v}，实际 ${cnt[k]}`)
          }
        }
        if (Object.entries(c.wantCounters).every(([k, v]) => cnt[k] === v)) {
          console.log(`  OK 计数相符（${Object.entries(c.wantCounters).map(([k, v]) => `${k}=${v}`).join(' ')}）`)
        }
      }
    }
    console.log('')
  }

  // 两条没覆盖的，明说而不是假装覆盖了：
  console.log('未覆盖：stdin_read_failed（要构造超过 1MB 的输入或让读失败）、')
  console.log('  cannot_read_existing_logins（要让密码库读取失败，需破坏 Login Data）。')
  console.log('  这两条的触发条件都不是客户端正常会遇到的，代价大于收益。')
  console.log('')
  if (bad) { console.log(`X ${bad} 项未通过。`); process.exit(1) }
  console.log('OK 错误路径逐条可分辨，成功路径无多余错误行。')
})().catch((e) => { console.log('X ' + e.message); process.exit(1) })
