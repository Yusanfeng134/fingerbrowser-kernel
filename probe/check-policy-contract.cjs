// 双向核对策略 JSON 的契约：**内核读的键** 与 **客户端发的键** 必须一致。
//
// ── 这个检查为什么必须存在 ──────────────────────────────────────────────
//
// 两侧任一方漏一个键，症状都是**静默失效**：功能代码在、开关判断写得很仔细、
// 没有任何报错，就是不生效。而且两个方向的成因完全不同，分别踩过：
//
//   客户端发了、内核不读   maxTouchPoints / devicePixelRatio
//                          → 开关永不下发，渲染侧覆盖是死代码
//   内核读了、客户端不发   platformVersion
//                          → 策略字段恒为空，回落到宿主真值（正是要隐藏的那个）
//
// 补丁 0026「消除四处指纹矛盾」的四项里有三项因此在生产路径上从未生效，而它
// **验收通过了** —— 探针直接在命令行传 `--fp-*` 开关，两侧的契约缝隙一个都没
// 走到。唯一真正生效的那项，恰恰是复用了已有开关、不需要端到端新增契约的那项。
//
// 所以这个检查的对象不是任何一侧的代码，是**两侧之间那条缝**。没有哪一边的
// 单元测试能覆盖它。
//
// ── 它不能做什么 ────────────────────────────────────────────────────────
//
// 只比对**键名**，不比对语义、类型或取值范围。键名对上了，仍可能：
//   · 客户端发字符串 "1.5"，内核用 FindDouble 读 → 静默丢弃（真实踩过的坑）
//   · 客户端发的值超出内核的校验范围 → 被拒，同样静默
// 那两类要靠 run-policy-emit.cjs 那种端到端探针。这里只堵最粗的一层。

const fs = require('fs')
const path = require('path')

// 客户端仓库不在本仓库内，路径可覆盖。
const CLIENT_SRC = process.env.YUNLOGIN_SRC ||
  'C:/Users/MARS_01_WYF/Desktop/Yunlogin/src'

const KERNELS = [
  { name: '151', policy: 'D:/chromium-work-151/src/chrome/browser/fingerbrowser/fingerbrowser_policy.cc' },
  { name: '124', policy: 'D:/chromium-work/chromium/src/chrome/browser/fingerbrowser/fingerbrowser_policy.cc' },
]

function fail(msg) { console.log('X ' + msg); process.exit(1) }

// ── 内核侧：抠出整个策略解析函数读的所有键 ─────────────────────────────
function kernelKeys(file) {
  if (!fs.existsSync(file)) fail(`找不到内核策略源码：${file}`)
  const src = fs.readFileSync(file, 'utf8')
  // 覆盖**整个策略解析函数**，不只 hardwareProfile 段。
  //
  // 此前只查 hardwareProfile。**那个范围漏掉了真问题**：passkeyAuthenticator 在
  // fingerprintPolicy 顶层，于是「内核读它、客户端从不发」一直没被发现 ——
  // 151 的 passkey 功能因此在生产路径上从未激活，而它的探针是「通过」的：探针
  // 用自己手写的策略 JSON，那份里有这个键。
  //
  // 教训不是「范围定小了」，是**「已知限制」写在输出里不等于它不会咬人**。
  // 当时我确实明说了「只覆盖 hardwareProfile」，说明白了，然后照样被它咬。
  // 能扩大覆盖就扩大，别指望下一个人读限制说明。
  const i = src.indexOf('FindDict("fingerprintPolicy")')
  if (i < 0) fail(`${file} 里找不到 fingerprintPolicy 段 —— 结构变了，抠取规则失效。`)
  const j = src.indexOf('return policy;', i)
  if (j < 0) fail(`${file} 里找不到解析函数结尾（return policy;），抠取规则失效。`)
  const seg = src.slice(i, j)

  const keys = new Set()
  for (const m of seg.matchAll(/Find(?:String|Int|Double|Bool|Dict|List)\("([^"]+)"\)/g)) {
    keys.add(m[1])
  }
  // 结构名不是数据字段：客户端「下发」的是它们的内容，不是这些名字本身。
  // 留着会产生假阴性（客户端一定会提到 hardwareProfile，于是它永远「通过」），
  // 也会产生假阳性（若某天客户端换了嵌套写法）。
  for (const structural of ['fingerprintPolicy', 'hardwareProfile', 'windowSize',
                            'geolocation']) {
    keys.delete(structural)
  }
  return keys
}

// ── 客户端侧：递归扫源码里出现的候选键 ──────────────────────────────────
//
// 这里刻意**不硬编码候选清单**去客户端里查有没有 —— 那样内核新增一个键时，
// 清单不更新就查不到，检查会静默漏掉正是它要防的那种情况。做法反过来：
// 拿内核读的键去客户端里找，找不到就是缺口。
function clientMentions(dir, keys) {
  const found = new Set()
  const stack = [dir]
  let files = 0
  while (stack.length) {
    let entries
    try { entries = fs.readdirSync(stack.pop(), { withFileTypes: true }) } catch (e) { continue }
    for (const e of entries) {
      const p = path.join(e.parentPath || e.path, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') stack.push(p)
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(e.name)) {
        files++
        let txt
        try { txt = fs.readFileSync(p, 'utf8') } catch (e2) { continue }

        // 先剥注释再匹配。裸 \bkey\b 会把注释里的提及也算成「客户端发了」——
        // 实测过：platformVersion 在客户端有 3 处命中，其中 2 处是注释，只有
        // 1 处是真赋值。若那天只有注释，这个检查会通过，而字段实际没下发。
        // 「提到过」不等于「发出去了」，这正是本目录反复记录的假通过形态。
        const stripped = txt
          .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避开 http:// 里的 //）

        for (const k of keys) {
          if (new RegExp(`\\b${k}\\b`).test(stripped)) found.add(k)
        }
      }
    }
  }
  return { found, files }
}

// 客户端的权威键清单：从它的 buildPolicy 实际返回值导出，不是扫源码。
// 拿不到时返回 null —— 调用方据此把结论降级，而不是当作「没有键」。
function clientEmittedKeys() {
  const repo = path.dirname(CLIENT_SRC)
  const script = path.join(repo, 'scripts', 'dump-policy-keys.cjs')
  if (!fs.existsSync(script)) return null
  try {
    const out = require('child_process').execSync(
      `node "${script}" --json`, { cwd: repo, encoding: 'utf8', timeout: 120000 })
    const j = JSON.parse(out)
    const all = Object.values(j).filter(Array.isArray).flat()
    return all.length ? new Set(all) : null
  } catch (e) {
    return null
  }
}

if (!fs.existsSync(CLIENT_SRC)) {
  console.log(`X 找不到客户端源码：${CLIENT_SRC}`)
  console.log('  用 YUNLOGIN_SRC 环境变量指定，或在有客户端仓库的机器上跑。')
  console.log('  **不要把「找不到」当成通过** —— 这个检查的全部意义就在于两侧都在场。')
  process.exit(1)
}

let bad = 0
for (const k of KERNELS) {
  if (!fs.existsSync(k.policy)) { console.log(`  跳过内核 ${k.name}：源码树不在 ${k.policy}`); continue }

  const kk = kernelKeys(k.policy)

  // 前提检查：抠不出键时必须喊，否则空集合与空集合的差也是空，"通过"。
  if (kk.size === 0) fail(`内核 ${k.name} 抠不出任何策略键 —— 抠取规则失效，不能继续。`)

  const { found, files } = clientMentions(CLIENT_SRC, kk)
  if (files === 0) fail(`在 ${CLIENT_SRC} 下没扫到任何源码文件 —— 路径或后缀过滤有问题。`)

  console.log(`内核 ${k.name}：读 ${kk.size} 个策略键，客户端扫了 ${files} 个文件`)

  // ── 三态，不是两态 ────────────────────────────────────────────────────
  //
  // grep 只能证明「这个标识符在客户端源码里出现过」，不能证明「它被写进了
  // 下发的策略」。实际咬过：passkeyAuthenticator 出现在客户端的
  // kernel-capabilities.ts 里（那是**能力声明**，读内核的 capabilities 清单），
  // 于是 grep 命中、检查通过，而策略里从来没有这个字段 —— 151 的 passkey 功能
  // 因此在生产路径上从未激活。
  //
  // 剥注释解决了「注释里提到」，解决不了「**在另一个语境里提到**」。
  //
  // 客户端的 `npm run policy:keys --json` 从 buildPolicy 的实际返回值取键，
  // 是权威来源。但它目前只覆盖 hardwareProfile，所以：
  //   权威通过  —— 在导出清单里，确定会下发
  //   弱证据    —— 不在导出清单里，但源码里出现过。**可能只是碰巧提到**
  //   缺失      —— 两者都没有
  // 把「弱证据」单列出来而不是并进 OK，是这次修复的全部意义。
  const authoritative = clientEmittedKeys()
  const missing = [], weak = [], strong = []
  for (const key of [...kk].sort()) {
    if (authoritative && authoritative.has(key)) strong.push(key)
    else if (found.has(key)) weak.push(key)
    else missing.push(key)
  }

  if (missing.length) {
    bad++
    console.log(`  X 内核读了、客户端从不发（${missing.length} 个）：`)
    for (const m of missing) console.log(`      ${m}  → 策略字段恒为空，内核回落到宿主真值`)
  }
  if (authoritative) {
    console.log(`  OK 权威确认会下发：${strong.length} 个`)
    if (weak.length) {
      console.log(`  ? 仅有弱证据（源码里出现过，但不在导出清单内）：${weak.length} 个`)
      console.log(`      ${weak.join(' ')}`)
      console.log('      这些**可能只是碰巧被提到**。要么让客户端把导出扩到整个策略，')
      console.log('      要么逐个人工确认它确实被写进下发的策略。')
    }
  } else {
    console.log(`  ? 拿不到客户端的权威键清单，全部 ${weak.length} 个只有 grep 弱证据。`)
    console.log('      在客户端仓库可用时跑，结论才有力度。')
  }
  console.log('')
}

// ── deviceMemory 合法集合的漂移检测 ─────────────────────────────────────
//
// 策略校验器里硬编码着 deviceMemory 的合法取值集合，而**真相在 blink 里，且随
// Chromium 版本变化**。124 桌面只有「>8 封顶到 8」、无下限，可达 {0.25…8}；
// 151 改成钳到 [kMinMemory, kMaxMemory] = [2, 32]（8 只在 Android 分支），可达
// {2,4,8,16,32}。校验器一直写的是 124 时代的 {1,2,4,8}，于是在 151 上两头错：
// 接受 151 产生不了的 1（=暴露「这不是真实浏览器」），拒掉合法常见的 16/32。
//
// 这类漂移没有任何编译错误、没有运行时报错，只有在有人恰好去读上游那个文件时
// 才会发现。所以从上游源码里把常量抠出来，跟校验器实际接受的集合比。
function checkDeviceMemorySet(kernelName, policyFile, blinkFile) {
  if (!fs.existsSync(blinkFile)) {
    console.log(`  ? 内核 ${kernelName}：找不到 ${blinkFile}，deviceMemory 合法集合未检查`)
    return 0
  }
  const blink = fs.readFileSync(blinkFile, 'utf8')

  // 上游有两种形态：151 的 kMinMemory/kMaxMemory 变量，124 的裸 `> 8` 封顶。
  let lo = null, hi = null
  const mMax = blink.match(/float\s+kMaxMemory\s*=\s*([\d.]+)f/)
  const mMin = blink.match(/float\s+kMinMemory\s*=\s*([\d.]+)f/)
  if (mMax && mMin) {
    lo = parseFloat(mMin[1]); hi = parseFloat(mMax[1])
  } else {
    const legacy = blink.match(/approximated_device_memory_gb_\s*>\s*(\d+)\)/)
    if (legacy) { lo = 0.25; hi = parseFloat(legacy[1]) }
  }
  if (lo === null) {
    console.log(`  X 内核 ${kernelName}：从 ${path.basename(blinkFile)} 抠不出钳位常量 —— 抠取规则失效，不能判定。`)
    return 1
  }

  // 算法产出 2 的幂 / 1024 GB，再钳到 [lo, hi]。
  const reachable = []
  for (let v = 0.25; v <= 4096; v *= 2) {
    const c = Math.min(Math.max(v, lo), hi)
    if (!reachable.includes(c)) reachable.push(c)
  }
  reachable.sort((a, b) => a - b)

  const pol = fs.readFileSync(policyFile, 'utf8')
  const seg = pol.slice(pol.indexOf('FindInt("deviceMemory")'))
  const accepted = [...seg.slice(0, 400).matchAll(/\*device_memory\s*==\s*(\d+)/g)]
    .map((m) => parseInt(m[1], 10)).sort((a, b) => a - b)
  if (accepted.length === 0) {
    console.log(`  X 内核 ${kernelName}：抠不出校验器接受的 deviceMemory 集合。`)
    return 1
  }

  const illegal = accepted.filter((x) => !reachable.includes(x))
  const missing = reachable.filter((x) => Number.isInteger(x) && !accepted.includes(x))
  console.log(`  内核 ${kernelName} deviceMemory：上游可达 [${reachable.join(', ')}]，校验器接受 [${accepted.join(', ')}]`)
  if (illegal.length) {
    console.log(`    X 接受了上游产生不了的值：${illegal.join(', ')}`)
    console.log('      配上它 → 报出原生浏览器不可能有的值 → 暴露「这不是真实浏览器」')
  }
  if (missing.length) {
    console.log(`    X 拒掉了上游合法的值：${missing.join(', ')} → 那类人格无法表达`)
  }
  if (!illegal.length && !missing.length) console.log('    OK 两边一致')
  return (illegal.length || missing.length) ? 1 : 0
}

console.log('── deviceMemory 合法集合（上游钳位 vs 策略校验器）──')
for (const k of KERNELS) {
  if (!fs.existsSync(k.policy)) continue
  const blink = path.join(k.policy.split('/chrome/browser/')[0],
    'third_party/blink/common/device_memory/approximated_device_memory.cc')
  bad += checkDeviceMemorySet(k.name, k.policy, blink)
}
console.log('')

// 反方向（客户端发了、内核不读）这里查不了：需要客户端那侧导出它写出的键集合。
// 明说而不是假装覆盖到了 —— 那正是本目录反复记录的假通过。
console.log('注意：本脚本只查「内核读了、客户端不发」一个方向。')
console.log('  覆盖范围已从 hardwareProfile 扩到整个策略解析函数 —— 上一版的范围')
console.log('  恰好漏掉了 passkeyAuthenticator（它在 fingerprintPolicy 顶层），')
console.log('  而那正是 151 的 passkey 功能从未在生产路径激活的原因。')
console.log('  反方向（客户端发了、内核不读，即 maxTouchPoints 那次）需要客户端导出')
console.log('  它实际写出的键集合，本脚本拿不到。目前靠人工对照客户端给的清单。')
console.log('  也只比键名，不比类型与取值范围 —— 那些要靠 run-policy-emit.cjs。')

process.exit(bad ? 1 : 0)
