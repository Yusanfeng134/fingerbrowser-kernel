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

// ── 内核侧：从 hardwareProfile 段里抠出 FindXxx("key") ───────────────────
function kernelKeys(file) {
  if (!fs.existsSync(file)) fail(`找不到内核策略源码：${file}`)
  const src = fs.readFileSync(file, 'utf8')
  const i = src.indexOf('FindDict("hardwareProfile")')
  if (i < 0) fail(`${file} 里找不到 hardwareProfile 段 —— 结构变了，抠取规则失效。`)

  // 段落到下一个顶层 `  }` 为止。粗但够用；抠不到东西时下面的前提检查会喊。
  const rest = src.slice(i)
  const end = rest.search(/\n  \}\n/)
  const seg = end > 0 ? rest.slice(0, end) : rest

  const keys = new Set()
  for (const m of seg.matchAll(/Find(?:String|Int|Double|Bool)\("([^"]+)"\)/g)) {
    keys.add(m[1])
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
        for (const k of keys) {
          if (new RegExp(`\\b${k}\\b`).test(txt)) found.add(k)
        }
      }
    }
  }
  return { found, files }
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
  if (kk.size === 0) fail(`内核 ${k.name} 抠不出任何 hardwareProfile 键 —— 抠取规则失效，不能继续。`)

  const { found, files } = clientMentions(CLIENT_SRC, kk)
  if (files === 0) fail(`在 ${CLIENT_SRC} 下没扫到任何源码文件 —— 路径或后缀过滤有问题。`)

  const missingInClient = [...kk].filter((x) => !found.has(x)).sort()

  console.log(`内核 ${k.name}：读 ${kk.size} 个 hardwareProfile 键，客户端扫了 ${files} 个文件`)
  if (missingInClient.length) {
    bad++
    console.log(`  X 内核读了、客户端从不发（${missingInClient.length} 个）：`)
    for (const m of missingInClient) {
      console.log(`      ${m}  → 策略字段恒为空，内核回落到宿主真值`)
    }
  } else {
    console.log('  OK 内核读的每个键，客户端源码里都有出现')
  }
  console.log('')
}

// 反方向（客户端发了、内核不读）这里查不了：需要客户端那侧导出它写出的键集合。
// 明说而不是假装覆盖到了 —— 那正是本目录反复记录的假通过。
console.log('注意：本脚本只查「内核读了、客户端不发」一个方向。')
console.log('  反方向（客户端发了、内核不读，即 maxTouchPoints 那次）需要客户端导出')
console.log('  它实际写出的键集合，本脚本拿不到。目前靠人工对照客户端给的清单。')
console.log('  也只比键名，不比类型与取值范围 —— 那些要靠 run-policy-emit.cjs。')

process.exit(bad ? 1 : 0)
