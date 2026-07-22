# patches/wip

未整理进编号补丁序列的工作树快照。

`scripts/apply-patches.sh` 用 `patches/*.patch` 平铺匹配，够不到这个子目录，
因此这里的文件不会被自动套用。这是刻意的：快照与编号序列有重叠，混进去会重复施加。

## fingerbrowser-worktree-snapshot.patch

`D:\chromium-work\chromium\src` 工作树中全部 FingerBrowser 相关改动的完整快照，
基线为 Chromium 124.0.6367.207（`a9001a6e39fbaa559510ca866052950457dd4e6b`）。

**这份快照包含 patch 0007 的全部内容**，因为该工作树的 HEAD 是原始 Chromium，
0001-0007 都以工作树修改的形式存在，无法在不重放 0007 的前提下单独 diff 出增量。
所以它**不能与 0007 叠加使用**——要么用 0001-0006 + 本快照，要么用完整编号序列。

### 涵盖的改动

按加入时间排序，其中后三项从未进入过编号序列：

1. L2 硬件画像：platform、hardwareConcurrency、deviceMemory、WebGL 厂商/渲染器、
   canvas 与音频噪声（原 patch 0007）
2. 时区与 Accept-Language 传递到渲染进程（原 patch 0008，文件已丢失）
3. 屏幕尺寸与地理位置（原 patch 0009，文件已丢失）
4. canvas 噪声改为按绝对坐标键控 —— 原实现按缓冲区偏移键控，导致
   `getImageData(sx,sy,w,h)` 与 `getImageData(0,0,W,H)` 对同一像素给出不同值，
   破坏了合法的局部读回图像运算
5. FingerBrowser profile 下不再清空高熵 Client Hints —— 上游在 `--user-agent`
   存在时提前返回，留下「UA 完整、brands 有值、但 platformVersion/uaFullVersion
   全空」的自相矛盾状态
6. WebGPU 适配器身份伪装 —— 此前只伪装了 WebGL，同一页面内 WebGPU 仍上报真实
   显卡，两个 API 互相矛盾

### 已知残留

WebGPU 的 `limits` 与 `features` 仍如实描述真实硬件，未伪造。伪造它们会让站点
请求一个我们声称支持、硬件实际没有的特性时 `requestDevice()` 失败，把指纹防护
变成白屏 bug。代价是伪装身份必须与宿主同厂商，该约束由客户端的 `gpu-profile.ts`
强制。

### 验证

生成时通过反向与正向 `git apply` 双向往返检查，工作树无残留差异。

导出于 2026-07-23，SHA-256 `8e562e20e37b1b7a97a46de38d057e706327812dcfcb9d98c7e3848a0822ab0f`。
