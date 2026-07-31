// 灵动岛把问题带进 AI 新标签页时，`?q=` 必须落在 `#` 之后。
//
// 客户端那页是 HashRouter，读的是 fragment 内部那段 query。看起来更规范、实际
// 会静默坏掉的写法是把 query 挪到 fragment 前面 —— 那样 `location.search` 里
// 确实有 q，但 HashRouter 看不见它，于是：**标签页照常打开、AI 页面照常渲染、
// 只是问题没带过去**。没有报错，截图也看不出区别。
//
// 这条不是假想。客户端会话实测确认了两种形状的解析差异，并指出触发方式很具体：
// 一次「把 query 挪到 fragment 前面」的善意重构。
//
// ── 这个脚本是什么，以及不是什么 ────────────────────────────────────────
//
// 它是一个**变更检测器**，不是正确性证明。它做的事：把 app.ts 里那行真正的
// href 表达式抠出来求值，检查产物的形状。它能发现「有人改了 URL 构造方式」，
// 不能发现「客户端换了路由方案所以这行该跟着变」。后者只有人能判断，脚本的
// 职责是**逼一次人工确认**，而不是假装自己确认过了。
//
// 之所以抠源码求值而不是在这里重写一遍拼接逻辑：那样测的是脚本自己的副本，
// 源码怎么改它都通过 —— 「通过条件被一个与被测对象无关的前提满足」的教科书
// 形态，本目录 README 里列的每一条假通过都是这个形状。
//
// 反例见文件末尾：同一个检查函数必须**拒绝**规范化后的 URL。否则这个检查对
// 任何输入都通过，等于没测。

const fs = require('fs')
const path = require('path')

const APP_TS = process.env.ISLAND_APP_TS ||
  'D:/chromium-work-151/src/chrome/browser/resources/dynamic_island/app.ts'

// 代表性的 base：与客户端 shell-launcher.ts 下发的 --fp-newtab-url 同形。
// 端口由 listen(0) 分配，每次不同，这里取任意值 —— 端口不参与被测属性。
const BASE = 'http://127.0.0.1:53483/newtab#/ai-newtab'
const Q = 'Kolarie 这个牌子在美国有多少竞品 & 定价 = ?'

function fail(msg) {
  console.log(`✗ ${msg}`)
  process.exit(1)
}

// ── 1. 前提检查：表达式必须真的被抠出来 ──────────────────────────────────
//
// 少了这一步，正则匹配不到时 exprs 为空，后面的循环零次迭代，脚本"通过"。
// 零断言的通过和真通过在输出上一模一样 —— 这是本目录反复踩到的那个洞。

if (!fs.existsSync(APP_TS)) {
  fail(`找不到 ${APP_TS}。若源码树在别处，用 ISLAND_APP_TS 指定。`)
}

const src = fs.readFileSync(APP_TS, 'utf8')

// 匹配 `a.href = <表达式>;`，跳过注释行。
const exprs = src
  .split('\n')
  .filter(l => !l.trim().startsWith('//'))
  .join('\n')
  .match(/\.href\s*=\s*([^\n;]+);/g)

if (!exprs || exprs.length === 0) {
  fail('在 app.ts 里没找到任何 `.href = ...;` —— 导航方式可能已经改了（比如换回 ' +
       'location.assign）。那会绕过宿主的 OpenURLFromTab 白名单，需人工确认。')
}
if (exprs.length > 1) {
  fail(`找到 ${exprs.length} 处 .href 赋值，无法判断哪一处是提交路径。请人工确认。`)
}

const raw = exprs[0].replace(/^\.href\s*=\s*/, '').replace(/;$/, '')
console.log(`  抠出的表达式: ${raw}`)

// ── 2. 求值真实表达式 ────────────────────────────────────────────────────

let built
try {
  built = new Function('base', 'q', `return ${raw}`)(BASE, Q)
} catch (e) {
  // 两种成因都归到「需人工确认」，但别把它们说成同一件事：
  //   a) 表达式引用了 base/q 之外的东西；
  //   b) 表达式跨了语句（如 IIFE），上面按 `;` 截断的抠法只拿到半截。
  // 实测变异「改用 URLSearchParams」走的是 (b) —— 拦住了，但若消息只写 (a)，
  // 下一个人会照着一条不成立的解释去查。
  fail(`表达式求值失败：${e.message}\n` +
       `  抠到的是：${raw}\n` +
       `  要么它引用了 base/q 之外的东西，要么它跨了语句、上面按 ";" 截断只拿到半截。\n` +
       `  两种都意味着 URL 构造方式变了，需人工确认 q 是否仍落在 fragment 内。`)
}
if (typeof built !== 'string') {
  fail(`表达式求值结果不是字符串（${typeof built}），构造方式变了，需人工确认。`)
}
console.log(`  求值结果:     ${built.slice(0, 70)}...`)

// ── 3. 被测属性：q 在 fragment 内，不在真 query 里 ───────────────────────

function checkQInFragment(url) {
  let u
  try { u = new URL(url) } catch (e) { return { ok: false, why: `不是合法 URL：${e.message}` } }

  if (u.search !== '') {
    return { ok: false, why: `q 落在了真正的 query 里（search="${u.search.slice(0, 40)}..."）—— HashRouter 看不见它` }
  }
  const i = u.hash.indexOf('?')
  if (i < 0) {
    return { ok: false, why: `fragment 里没有 query 段（hash="${u.hash}"）—— 问题根本没带上` }
  }
  const got = new URLSearchParams(u.hash.slice(i + 1)).get('q')
  if (got === null) {
    return { ok: false, why: 'fragment 的 query 段里没有 q' }
  }
  if (got !== Q) {
    return { ok: false, why: `q 的值对不上：期望 ${JSON.stringify(Q)}，取到 ${JSON.stringify(got)}` }
  }
  return { ok: true }
}

const r = checkQInFragment(built)
if (!r.ok) {
  fail(`app.ts 构造的 URL 不满足「q 落在 fragment 内」：${r.why}\n` +
       `  URL: ${built}\n` +
       `  这不必然是缺陷 —— 若客户端已改用非 HashRouter 的路由方案，这行本就该变。\n` +
       `  但它必须由人确认，不能让它悄悄通过。`)
}
console.log('✓ q 落在 fragment 内，值完整')

// ── 4. 反例：检查函数必须拒绝规范化后的形状 ──────────────────────────────
//
// 没有这一步，一个「对任何输入都返回 ok」的 checkQInFragment 也会让上面那条
// 打印出 ✓。反例证明这个检查真的能区分两种形状。

const normalized = `http://127.0.0.1:53483/newtab?q=${encodeURIComponent(Q)}#/ai-newtab`
const rn = checkQInFragment(normalized)
if (rn.ok) {
  fail('反例失效：检查函数接受了「query 挪到 fragment 之前」的形状。\n' +
       '  这说明检查本身坏了 —— 上面那条 ✓ 不能采信。')
}
console.log(`✓ 反例：规范化形状被拒（${rn.why}）`)

// 第二个反例：q 完全丢失时也必须拒。
const dropped = BASE
const rd = checkQInFragment(dropped)
if (rd.ok) {
  fail('反例失效：检查函数接受了完全没带 q 的 URL。')
}
console.log(`✓ 反例：不带 q 被拒（${rd.why}）`)

console.log('')
console.log('★ 通过。注意这只证明「URL 构造方式没变且形状正确」，')
console.log('  不证明客户端那端真的能读到 —— 那要端到端跑一次。')
