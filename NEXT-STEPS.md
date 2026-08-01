# 重启后要做的（2026-08-01 记）

这台机器有一个**僵尸 renderer 进程**锁着
`D:/chromium-work/chromium/src/out/FingerBrowser/v8_context_snapshot.bin`：
`taskkill` 报「没有该任务的运行实例」，而 `Get-CimInstance` 说它还在 —— 已退出
但进程对象未释放。**只有重启能清。**

因此 124 至今**只能编译、不能链接**，四批改动全部只有 obj 级验证。

## 一、清场确认

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*chromium-work*' }
```
应为空。然后：

```powershell
Rename-Item D:\chromium-work\chromium\src\out\FingerBrowser\v8_context_snapshot.bin `
            v8_context_snapshot.bin.stale
```
能改名 = 锁已释放。改不动说明僵尸还在，别继续。

## 二、链接 124

```bash
cd /d/chromium-work/chromium/src
export DEPOT_TOOLS_WIN_TOOLCHAIN=0 PATH="/d/depot_tools:$PATH"
autoninja -C out/FingerBrowser -j 14 chrome
```

## 三、红转绿（两项，都已有探针）

```bash
cd /d/chromium-work-151/probe
node run-124-passkey-symptom.cjs                       # 期望 HANG -> RESOLVE（带策略）
PROBE_FORCE_KILL=1 node run-canvas-oob.cjs             # 期望 X -> OK
```

passkey 那条要带策略跑（`PK_POLICY=` 指向含 `passkeyAuthenticator: true` 的
JSON），并**用全新标签页**——reload 不取消挂着的 WebAuthn 请求，会给出 1ms 的
假读数，两侧各踩过一次。

## 四、导出补丁 0013 —— ⚠ 有一处需要拆

124 树目前四个待导出提交：

| 提交 | 内容 |
|---|---|
| `a8089735c3` | passkey 移植 **+ 混进了 dpr/touch 解析修复** |
| `2676570511` | canvas 越界读 |
| `7fc15193a9` | 单元测试断言 |
| `fbebbbccdb` | gpu_adapter 假注释 |

**`a8089735c3` 一次提交做了两件事，而消息只讲了 passkey。** 成因：暂存时按文件
路径 `git add chrome/browser/fingerbrowser/fingerbrowser_policy.cc`，而那个文件里
同时躺着 passkey 的 `passkeyAuthenticator` 解析、和更早插入但一直没提交的
dpr/touch 解析修复（27 行）。

导出时要把 dpr/touch 那部分单独成一个补丁：它与 151 的 0032 是同一件事，应当
对得上；绑在 passkey 里的话，将来单独回退任一方都做不到。

## 五、之后

- 全树校验：`./scripts/verify-patch-tree.sh 124` 应回到绿
- 删除 `patches/README.md` 开头那节「当前结果：红」——它是为这段时间写的
- `patches/README.md` 欠账 #1（dpr/touch）随之标记已修
