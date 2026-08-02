// fp-* 开关三方契约的机械检查：策略下发 / 渲染进程转发白名单 / blink 消费。
//
// ── 为什么要有这个 ──────────────────────────────────────────────────────
//
// 一个 fp-* 开关要在渲染进程里生效，同一个字符串必须在**三处**逐字一致：
//
//   1 chrome/browser/fingerbrowser/fingerbrowser_policy.cc   下发（裸字面量）
//   2 content/browser/renderer_host/render_process_host_impl.cc  转发白名单（裸字面量）
//   3 third_party/blink/renderer/platform/fingerbrowser/…h    消费（constexpr 常量）
//
// 三处全是字符串字面量，**拼错一个字符编译器不会有任何反应**。少了第 2 步，
// 渲染进程永远读到空字符串，功能静默回落到宿主真值 —— 而所有直传 `--fp-*` 的
// 探针都照样通过，因为它们绕开了这条链路。补丁 0026 的三处失效就是这么逃掉的。
//
// 两份源文件的注释都写着「keep in sync / names must match」。这个脚本就是把那句
// 话变成能跑的东西。
//
// ── 四条规则 ────────────────────────────────────────────────────────────
//
// 硬错（必然是缺陷）：
//   R1 blink 头文件里声明的每个 kXxxSwitch，在 blink/renderer 下必须有读取点。
//      没有 = 死常量。它不只是没用，还会**误导下一个人**按错误的方式实现。
//   R2 在 blink/renderer 下被读取的每个 fp-* 开关，必须在转发白名单里。
//      不在 = 渲染进程永远读不到，功能静默失效。
//
// 提示（可能对、需要人看）：
//   R3 策略下发的 fp-* 开关，若既不在 blink 消费、也无浏览器侧读取点 —— 死开关。
//   R4 转发白名单里有、但策略从不下发的 —— 要么由客户端直传，要么是残留。
//
// R3/R4 不是硬错，因为**浏览器进程自读**是完全正当的架构：fp-active / fp-shell /
// fp-passkey / fp-brand / fp-platform-version 都是浏览器侧消费（UA-CH metadata 走
// mojo 下发，不走命令行），它们不在白名单里是对的。一次审计把这五个全当成缺口，
// 全部被反驳 —— 教训是**别假定所有 fp-* 都该进渲染进程**。
//
// ── 自检 ────────────────────────────────────────────────────────────────
//
// `--self-test` 用掺假的输入跑同一套比对逻辑，断言每条规则都真的会响。
// 一个恒绿的检查器比没有更糟：它在其余场景里正常工作，持续提供「已经防住了」
// 的证据。这条在 probe/README.md 里已经吃过亏。

const fs = require('fs')
const { execFileSync } = require('child_process')

const SRC = process.env.FB_SRC || 'D:/chromium-work-151/src'
const POLICY = `${SRC}/chrome/browser/fingerbrowser/fingerbrowser_policy.cc`
const RPHI = `${SRC}/content/browser/renderer_host/render_process_host_impl.cc`
// FB_HEADER 可覆盖，用于拿历史版本的头文件端到端回验采集器（自检只覆盖比对逻辑，
// 不经过采集器 —— 而采集器才是更容易出错的一半）。
const HEADER = process.env.FB_HEADER ||
  `${SRC}/third_party/blink/renderer/platform/fingerbrowser/fingerbrowser_fingerprint.h`
const BLINK = `${SRC}/third_party/blink/renderer`

// 由**浏览器进程**自读、按设计不进转发白名单的开关。值是读取它的文件（相对 SRC）。
//
// 这不是「先记下来免得报错」的地毯 —— 每条都会被回查：文件里必须仍出现该开关的
// 字面量，否则报错。消费者被删或改名时会响，而不是静静变成空转。
//
// 这五个曾被一次审计全判成「转发缺口」，全部被反驳：UA-CH metadata 在浏览器进程
// 组装后走 mojo 下发，WebAuthn 的认证器选择完全在浏览器进程，fp-shell 是 UI 外壳
// 门控。**别假定所有 fp-* 都该进渲染进程。**
const BROWSER_SIDE = {
  // Client Hints 品牌列表 / Accept-Language / 登录一致性的总闸门
  'fp-active': ['components/embedder_support/user_agent_utils.cc',
                'chrome/browser/chrome_content_browser_client.cc',
                'chrome/browser/net/profile_network_context_service.cc'],
  // 浏览器外壳（垂直标签栏 / 侧边栏 / 灵动岛 / 管理台）门控，与指纹无关
  'fp-shell': ['chrome/browser/ui/browser_command_controller.cc'],
  // 填进 UA-CH brand list，再随 UserAgentMetadata 经 mojo 下发
  'fp-brand': ['components/embedder_support/user_agent_utils.cc'],
  // UA-CH platformVersion，同上；没有对应的 JS 属性，所以不需要进渲染进程
  'fp-platform-version': ['components/embedder_support/user_agent_utils.cc'],
  // WebAuthn 认证器发现与选择全在浏览器进程完成
  'fp-passkey': ['content/browser/webauth/authenticator_environment.cc'],
}

// ── 采集 ────────────────────────────────────────────────────────────────

// 策略下发的 fp-* 开关：AppendSwitch / AppendSwitchASCII 的裸字面量。
// 只认 "fp-" 开头的 —— 用 switches:: 常量下发的（--lang / --window-size /
// --deny-permission-prompts）是上游开关，自有上游的转发安排，不归本契约管。
function collectEmitted(text) {
  const out = new Map()
  const re = /AppendSwitch(?:ASCII|Native)?\s*\(\s*"(fp-[a-z0-9-]+)"/g
  let m
  while ((m = re.exec(text))) {
    const line = text.slice(0, m.index).split('\n').length
    if (!out.has(m[1])) out.set(m[1], line)
  }
  return out
}

// 转发白名单：kSwitchNames 数组里的 fp-* 裸字面量。
// 只取数组内部，避免把注释或别处的字面量算进来。
function collectForwarded(text) {
  const start = text.indexOf('static const char* const kSwitchNames[]')
  if (start < 0) throw new Error('在 render_process_host_impl.cc 里找不到 kSwitchNames 数组')
  // 结尾锚到消费它的那行调用，而不是匹配大括号：数组的 "};" 是缩进的，而且里面
  // 有大量 #if 分支，靠括号配平容易错。CopySwitchesFrom 那行是数组的唯一用途。
  const end = text.indexOf('CopySwitchesFrom(browser_cmd, kSwitchNames)', start)
  if (end < 0) throw new Error('找不到 CopySwitchesFrom(browser_cmd, kSwitchNames) —— 转发机制可能变了')
  const body = text.slice(start, end)
  const out = new Set()
  const re = /"(fp-[a-z0-9-]+)"/g
  let m
  while ((m = re.exec(body))) out.add(m[1])
  return out
}

// blink 头文件里声明的常量：名字 -> 开关字面值。
function collectDeclared(text) {
  const out = new Map()
  const re = /inline\s+constexpr\s+char\s+(k\w*Switch)\s*\[\]\s*=\s*"(fp-[a-z0-9-]+)"/g
  let m
  while ((m = re.exec(text))) out.set(m[1], m[2])
  return out
}

// blink/renderer 下每个常量名的读取点（声明那一行本身不算）。
// 头文件内部的 helper 也会读这些常量，那算正当读取点。
function collectReads(names) {
  let raw = ''
  try {
    raw = execFileSync('grep', ['-rn', '--include=*.cc', '--include=*.h',
      '-E', 'k[A-Za-z0-9_]*Switch', BLINK], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    // grep 无命中时退出码为 1；但这里必然有命中，无命中说明搜错了地方。
    raw = e.stdout || ''
  }
  if (!raw.trim()) throw new Error(`在 ${BLINK} 下一个 kXxxSwitch 都没搜到 —— 搜索本身坏了`)
  const reads = new Map()
  for (const n of names) reads.set(n, [])
  for (const line of raw.split('\n')) {
    const mm = line.match(/^(.*?):(\d+):(.*)$/)
    if (!mm) continue
    const [, file, ln, body] = mm
    // 声明行本身不算读取点。
    if (/inline\s+constexpr\s+char\s+k\w*Switch\s*\[\]/.test(body)) continue
    // 注释里提到常量名**不算读取点**。这条不是洁癖：第一版没有它，结果一句
    // 「这里曾有一个 kDoNotTrackSwitch」的注释就把那个死常量伪装成「有人在读」，
    // R1 于是永远不会响 —— 检查器给出假绿。删掉真实读取点、留一句注释提到它，
    // 是完全可能发生的改法。
    const code = body.split('//')[0]
    if (!code.trim()) continue
    for (const n of names) {
      if (code.includes(n)) reads.get(n).push(`${file}:${ln}`)
    }
  }
  return reads
}

// ── 比对 ────────────────────────────────────────────────────────────────

function evaluate({ emitted, forwarded, declared, reads }) {
  const errors = []
  const notes = []

  // R1 声明了但没人读 = 死常量
  for (const [name, sw] of declared) {
    if ((reads.get(name) || []).length === 0) {
      errors.push({ rule: 'R1', sw,
        msg: `${name} ("${sw}") 在 blink 头文件里声明，但 blink/renderer 下无任何读取点 —— 死常量。` })
    }
  }

  // R2 blink 要读，但不在转发白名单 = 渲染进程永远读到空
  for (const [name, sw] of declared) {
    if ((reads.get(name) || []).length === 0) continue   // 已由 R1 报过
    if (!forwarded.has(sw)) {
      errors.push({ rule: 'R2', sw,
        msg: `${name} ("${sw}") 在渲染进程被读取，但不在 render_process_host_impl.cc 的转发白名单里` +
             ` —— 渲染进程永远读到空，功能静默回落到宿主真值。` })
    }
  }

  // R3 策略下发了，但 blink 不消费 —— 要么是已知的浏览器侧自读，要么是死开关
  const declaredValues = new Set([...declared.values()])
  for (const [sw, line] of emitted) {
    if (declaredValues.has(sw)) continue
    const owners = BROWSER_SIDE[sw]
    if (!owners) {
      errors.push({ rule: 'R3', sw,
        msg: `策略在 fingerbrowser_policy.cc:${line} 下发 "${sw}"，但 blink 侧无对应常量，` +
             `也不在已知的浏览器侧消费清单里 —— 要么是死开关，要么该往 BROWSER_SIDE 里补一条并说明谁读它。` })
      continue
    }
    // 白名单不是地毯：记在册的读取点必须还在。
    const missing = owners.filter((rel) => {
      try { return !fs.readFileSync(`${SRC}/${rel}`, 'utf8').includes(`"${sw}"`) }
      catch (e) { return true }
    })
    if (missing.length) {
      errors.push({ rule: 'R3', sw,
        msg: `"${sw}" 记在册的浏览器侧读取点已不含它：${missing.join(', ')}` +
             ` —— 消费者被删了或改名了，开关成了空转。` })
    }
  }

  // R4 白名单有、策略不发
  for (const sw of forwarded) {
    if (!emitted.has(sw)) {
      notes.push({ rule: 'R4', sw,
        msg: `转发白名单含 "${sw}"，但 fingerbrowser_policy.cc 从不下发它 —— 客户端直传，或是残留。` })
    }
  }

  return { errors, notes }
}

// ── 自检：掺假输入必须让每条硬规则都响 ──────────────────────────────────

function selfTest() {
  let bad = 0
  const base = {
    emitted: new Map([['fp-alpha', 10], ['fp-beta', 20]]),
    forwarded: new Set(['fp-alpha', 'fp-beta']),
    declared: new Map([['kAlphaSwitch', 'fp-alpha'], ['kBetaSwitch', 'fp-beta']]),
    reads: new Map([['kAlphaSwitch', ['x.cc:1']], ['kBetaSwitch', ['y.cc:2']]]),
  }
  const clean = evaluate(base)
  if (clean.errors.length || clean.notes.length) {
    bad++
    console.log('X 自检：干净输入本该零告警，实际 ' +
      `${clean.errors.length} 错 / ${clean.notes.length} 提示`)
  } else {
    console.log('  OK 干净输入 -> 零告警')
  }

  // R1：把 kBetaSwitch 的读取点抹掉
  const r1 = evaluate({ ...base, reads: new Map([['kAlphaSwitch', ['x.cc:1']], ['kBetaSwitch', []]]) })
  if (!r1.errors.some((e) => e.rule === 'R1' && e.sw === 'fp-beta')) {
    bad++; console.log('X 自检 R1 没响：删掉读取点后仍未报死常量')
  } else { console.log('  OK R1 响了（死常量）') }

  // R2：把 fp-beta 从白名单里拿掉
  const r2 = evaluate({ ...base, forwarded: new Set(['fp-alpha']) })
  if (!r2.errors.some((e) => e.rule === 'R2' && e.sw === 'fp-beta')) {
    bad++; console.log('X 自检 R2 没响：白名单缺失后仍未报')
  } else { console.log('  OK R2 响了（未转发）') }

  // R2 的拼写变体：白名单里写错一个字符
  const r2b = evaluate({ ...base, forwarded: new Set(['fp-alpha', 'fp-bata']) })
  if (!r2b.errors.some((e) => e.rule === 'R2' && e.sw === 'fp-beta')) {
    bad++; console.log('X 自检 R2 没响：白名单拼写错误未被发现')
  } else { console.log('  OK R2 响了（白名单拼写错误）') }

  // R3：策略发了个 blink 不认识、也不在浏览器侧清单里的 -> 现在是硬错
  const r3 = evaluate({ ...base, emitted: new Map([...base.emitted, ['fp-gamma', 30]]) })
  if (!r3.errors.some((e) => e.rule === 'R3' && e.sw === 'fp-gamma')) {
    bad++; console.log('X 自检 R3 没响：下发了一个无人消费、也未登记的开关')
  } else { console.log('  OK R3 响了（下发无消费者且未登记）') }

  // R3 的另一半：登记在册但读取点已消失。用一个必然不存在的文件模拟。
  const savedKey = 'fp-zeta'
  BROWSER_SIDE[savedKey] = ['no/such/file/that/exists.cc']
  const r3b = evaluate({ ...base, emitted: new Map([...base.emitted, [savedKey, 40]]) })
  delete BROWSER_SIDE[savedKey]
  if (!r3b.errors.some((e) => e.rule === 'R3' && e.sw === savedKey)) {
    bad++; console.log('X 自检 R3 没响：白名单登记的读取点已失效却未报')
  } else { console.log('  OK R3 响了（白名单登记的读取点已失效）') }

  // R4：白名单多一个策略不发的
  const r4 = evaluate({ ...base, forwarded: new Set([...base.forwarded, 'fp-delta']) })
  if (!r4.notes.some((n) => n.rule === 'R4' && n.sw === 'fp-delta')) {
    bad++; console.log('X 自检 R4 没响')
  } else { console.log('  OK R4 响了（白名单多余）') }

  console.log('')
  if (bad) { console.log(`X 自检 ${bad} 项失败 —— 这个检查器本身不可信。`); process.exit(1) }
  console.log('OK 自检通过：四条规则都有判别力，干净输入不误报。')
}

// ── 主流程 ──────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

for (const f of [POLICY, RPHI, HEADER]) {
  if (!fs.existsSync(f)) { console.log(`X 找不到 ${f}`); process.exit(1) }
}

const emitted = collectEmitted(fs.readFileSync(POLICY, 'utf8'))
const forwarded = collectForwarded(fs.readFileSync(RPHI, 'utf8'))
const declared = collectDeclared(fs.readFileSync(HEADER, 'utf8'))
const reads = collectReads([...declared.keys()])

// 采集本身要合理，否则下面的比对是在拿空集比空集。
if (emitted.size === 0 || forwarded.size === 0 || declared.size === 0) {
  console.log(`X 采集异常：下发 ${emitted.size} / 转发 ${forwarded.size} / 声明 ${declared.size}`)
  console.log('  三者都不该为 0 —— 多半是源码结构变了，正则没匹配上。')
  process.exit(1)
}

console.log(`  策略下发 fp-* ${emitted.size} 个`)
console.log(`  转发白名单 fp-* ${forwarded.size} 个`)
console.log(`  blink 声明常量 ${declared.size} 个，其中有读取点的 ` +
  `${[...declared.keys()].filter((n) => (reads.get(n) || []).length).length} 个`)
console.log('')

const { errors, notes } = evaluate({ emitted, forwarded, declared, reads })

for (const e of errors) console.log(`X [${e.rule}] ${e.msg}`)
for (const n of notes) console.log(`  · [${n.rule}] ${n.msg}`)
console.log('')

if (errors.length) {
  console.log(`X ${errors.length} 条硬错。`)
  process.exit(1)
}
console.log(`OK 三方契约一致（${notes.length} 条提示需人工确认，见上）。`)
