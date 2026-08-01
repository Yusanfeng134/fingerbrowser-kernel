// Accept-Language 的 pref 路径：ReduceAcceptLanguage 开启时，线上请求头由
// ReduceAcceptLanguageUtils 决定，它读的是 profile pref intl.accept_languages —— 
// **不走 ProfileNetworkContextService::ComputeAcceptLanguage() 里的伪装早退**。
//
// 所以只在 ComputeAcceptLanguage 里拦截是不够的，还必须把伪装语言写进 pref 本身。
// 缺了那一步的实测（本机宿主 zh-CN，人格 en-US）：
//
//   内核                          ReduceAcceptLanguage   线上 Accept-Language   JS
//   124（无 pref 写入）           关                     en-US,en;q=0.9         en-US
//   124（无 pref 写入）           开                     **zh-CN**              en-US
//   151（有 pref 写入）           开                     en-US,en;q=0.9         en-US
//
// 中间那行是缺陷：**JS 说 en-US，线上说 zh-CN** —— 一条 HTTP 请求即可拆穿，
// 且属于「矛盾」而非「未伪装」，危害高一级。
//
// ── 两处必须同时看 ──────────────────────────────────────────────────────
//
// 本脚本同时取线上请求头与 navigator.languages。只看后者会通过 —— 那正是这个
// 缺陷能长期存在的原因。**JS 里读到的值不是发到线上的值。**
//
// ── 必须显式开 ReduceAcceptLanguage ─────────────────────────────────────
//
// 该特性在 151 默认关闭（services/network/public/cpp/features.cc）。不开的话
// 两个内核都通过，这个缺陷完全不可见 —— 通过条件被一个与被测属性无关的前提
// 满足了。

function ensureFieldClear(image) {
  // 只清本探针自己的 profile，按 --user-data-dir 过滤，**不按镜像名**。
  // 这台机器上客户端外壳、店铺环境、探针内核共用同一个可执行文件名，按名字杀
  // 等于无差别清场 —— 已经造成两次实际破坏。见 probe-kill.cjs 的说明。
  const { killProbeKernels, foreignKernelCount } = require('./probe-kill.cjs')
  const killed = killProbeKernels(image)
  if (killed.length) console.log(`  清掉本探针上次残留的 ${killed.length} 个进程`)
  const foreign = foreignKernelCount(image)
  if (foreign) {
    console.log(`  注意：场上还有 ${foreign} 个非本探针的 ${image}（客户端在跑）——`)
    console.log('  不影响本次测量（profile 隔离），但异常时值得先想到这一点。')
  }
}

const http=require('http'),{spawn,execSync}=require('child_process'),WebSocket=require('ws')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function run(kernel,image,reduce,port,cdp,tag){
 ensureFieldClear(image)
 await sleep(1200)
 let hdr=null
 const srv=http.createServer((q,r)=>{ if(!hdr) hdr=q.headers['accept-language']||'(无)'
   r.writeHead(200,{'content-type':'text/html; charset=utf-8'}); r.end('<!doctype html><meta charset=utf-8><body>x')})
 await new Promise(r=>srv.listen(port,'127.0.0.1',r))
 const a=['--headless=new','--no-first-run','--disable-background-networking',
  '--fp-active','--fp-accept-lang=en-US','--fp-timezone=America/New_York',
  `--remote-debugging-port=${cdp}`,`--user-data-dir=D:/chromium-work-151/probe/prof-al-${tag}`]
 if(reduce) a.push('--enable-features=ReduceAcceptLanguage,ReduceAcceptLanguageHTTP')
 a.push(`http://localhost:${port}/`)
 const c=spawn(kernel,a,{stdio:'ignore'})
 for(let i=0;i<60&&!hdr;i++) await sleep(500)
 // 再取一次 JS 侧，用于对照「JS 通过 ≠ 线上通过」
 let js='(取不到)'
 try{
  const l=await(await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()
  const p=l.find(t=>t.type==='page')
  if(p){const s=new WebSocket(p.webSocketDebuggerUrl);await new Promise((r,j)=>{s.onopen=r;s.onerror=j})
   js=await new Promise(r=>{s.onmessage=m=>{const d=JSON.parse(m.data);if(d.id===1)r(d.result?.result?.value??'')}
    s.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{returnByValue:true,expression:'navigator.languages.join(",")'}}))})
   s.close()}
 }catch(e){}
 srv.close();c.kill();await sleep(600)
 return {hdr:hdr||'(没收到请求)',js}
}
;(async()=>{
 const K124='D:/chromium-work/chromium/src/out/FingerBrowser/chrome.exe'
 const K151='D:/yunbrowser-run/yunbrowser.exe'
 for(const [label,k,img,red,p,c,t] of [
   ['124（7/30，无 pref 写入）  ReduceAcceptLanguage 关', K124,'chrome.exe',false,8861,9545,'a'],
   ['124（7/30，无 pref 写入）  ReduceAcceptLanguage 开', K124,'chrome.exe',true, 8862,9546,'b'],
   ['151（有 pref 写入）        ReduceAcceptLanguage 开', K151,'yunbrowser.exe',true,8863,9547,'c'],
 ]){
  const r=await run(k,img,red,p,c,t)
  console.log(`  ${label}`)
  console.log(`      线上 Accept-Language: ${r.hdr}`)
  console.log(`      JS navigator.languages: ${r.js}`)
 }
})().catch(e=>{console.log('X '+e.message);process.exit(1)})
