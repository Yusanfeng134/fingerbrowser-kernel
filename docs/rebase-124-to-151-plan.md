# Rebase 124 → 151 迁移清单

把 FingerBrowser 内核从 Chromium 124.0.6367.207 迁到 151.x 的可执行计划。
结论:今天的成果绝大部分直接迁移,少数返工,极少作废。

基线数据来自实测:151 稳定版为 151.0.7922.x(约 2026-01);17 个接缝文件中
16 个在 151 原路径仍存在;`user_agent_utils.cc` 的关键代码段逐字未变;
geolocation 模块从 `modules/geolocation/` 搬到 `core/geolocation/`。

---

## A. 完全不受影响(与 Chromium 版本正交)

这些通过命令行开关 + policy JSON 与内核通信,接口不变则代码不变。
**rebase 时一行不用改。**

| 项 | 位置 |
| --- | --- |
| 内核启动器、启动网址、代理预检 | voyager-p0 `src/main/kernel-launcher.ts` |
| GPU 目录 + 同族校验 | voyager-p0 `src/main/gpu-profile.ts` |
| brand 从 UA 派生 | voyager-p0 `src/main/kernel-launcher.ts` |
| Cookie 管理(MV3 注入/回传) | voyager-p0 `src/main/cookie-*.ts` |
| proxy-chain ESM 修复 | voyager-browser `src/proxyForwarder.js` |
| Windows 构建脚本 + 故障文档 | fingerbrowser-kernel `scripts/`, `docs/` |
| `.gitattributes` | fingerbrowser-kernel |
| golden 基线 | voyager-p0 `qa/` |
| 全部测试脚本 | voyager-p0 `scripts/test-*.cjs` |
| 验证工具(CreepJS 探针、canvas 基准、往返验证) | `D:/chromium-work/fbtest/` |

这是今天工作量的大头。

---

## B. 直接迁移(接缝已确认存在,重新套用即可)

不是重写,是「把同样的修改重新打上去」。测试与验证方法直接复用。

| 补丁 | 文件 | 151 状态 |
| --- | --- | --- |
| 0007 全部 | 见 patches/0007 | 接缝存活(navigator_id/screen 等已核) |
| 0008 时区 | `core/timezone/timezone_controller.cc` | 存在 |
| 0008 语言 | `core/frame/navigator_language.cc` | 存在 |
| 0010 canvas | `modules/canvas/canvas2d/base_rendering_context_2d.cc` | 存在 |
| 0010 canvas | `platform/graphics/image_data_buffer.cc` | 存在 |
| 0011 高熵 CH | `components/embedder_support/user_agent_utils.cc` | **逐字相同**,提前返回逻辑与 kUACHOverrideBlank 特性都在 |
| 0011 brand | 同上,`GenerateBrandVersionList` | 存在,排列种子仍是编译版本号(自动等于 Chrome 151 排列) |
| 0011 WebGPU | `modules/webgpu/gpu_adapter.cc` | 存在(注意 M127+ 的 `info` 属性默认启用,见 D) |

**共享基础设施**(policy.cc/.h、render_process_host、fingerprint.h):
这些是我们自己新增的文件/代码块,不依赖上游结构,原样迁移。
`render_process_host_impl.cc` 的开关传递列表(`kSwitchNames`)需确认上游未重构该数组。

---

## C. 需要真正返工(少数)

| 项 | 变化 | 工作量 |
| --- | --- | --- |
| **geolocation**(0009 的一半) | 模块从 `modules/geolocation/` 搬到 `core/geolocation/`;`StartUpdating` 改名 `UpdateGeolocationState`;`GeoNotifier` 拆成 Blink/V8 两路但都汇入 `StartRequest`(挂钩点不变) | 中:换路径、改函数名,不重想设计 |
| **补丁编号规整** | rebase 后行号全变,0008-0011 需重新拆 | 低:方法完全复用(临时 index diff + 哈希验证脚本原样能跑) |
| **screen.cc**(0009 另一半) | 方法仍是 `width/height/availWidth/availHeight` 走 `GetRect`,已核存在;确认签名未变即可 | 低 |

---

## D. 可能作废或需重新设计

| 项 | 原因 | 处理 |
| --- | --- | --- |
| **deviceMemory 钳制** | M147 改了 deviceMemory 限值,客户端硬编码 `[1,2,4,8]`(gpu 无关,在 kernel-launcher `parseDeviceMemory`)可能不再匹配 | 几行,重新对齐上游限值 |
| **WebGPU `requestAdapterInfo()`** | 124 用 `requestAdapterInfo()`,M127+ 改用 `adapter.info` 属性且默认暴露 device/description | 我们在字段赋值处挂钩,两条路都覆盖;但需重测 `info` 属性下的表现 |

---

## E. rebase 才需要新增的工作(不是迁移,是补新面)

这才是 rebase 的真正成本大头。124→151 新增的指纹面(详见当时的调研):

- **WebGPU 扩张**:M127/132/136 的 GPUAdapterInfo 变化 + ~20 项新特征。我们已伪装身份,但新特征面需覆盖。
- **端侧 AI**(新模块 `ai`):`availability()` 泄露硬件档次/OS,完全未覆盖。
- **字体面扩张**(M133-M151 多项):字体指纹本就是待办,151 暴露面更大。
- **ICU 77 / Unicode 16**(M143):影响 Intl 输出,时区/语言伪装需重新验证。
- **Device Bound Session Credentials**(M135,新模块 `securesession`):TPM 绑定会话,对多账号是存在性威胁,需评估。
- **Reduced UA + ch-ua-high-entropy permissions policy**(M144/145):强化了我们已修的高熵 CH 缺陷的重要性。
- **分区变更**(Cookie/Blob/visited,M128/132):影响 Cookie 管理语义。
- **`donottrack` 模块**:151 有现成接缝,可一并做掉这个待办。

---

## 成本对比(决策用)

| | 不 rebase | rebase |
| --- | --- | --- |
| 今天的成果 | 照常有效 | ~90% 平移 |
| 版本号 | 停在 Chrome/124(两年前,自动更新场景下几乎不存在,本身是最强暴露信号) | 追平当前稳定版 |
| WebGPU 矛盾 | 已在 124 修复 | 迁移 + 覆盖新特征 |
| 新指纹面 | 未覆盖(端侧AI/字体/ICU 等) | 需补(真正的工作量) |
| 源码获取 | 现成 | 6-7 小时无人值守(已验证 1.6MB/s 直连可用) |

**结论:不是「白费 vs 保留」,是「在 124 封顶 vs 把已有成果搬到能持续用的基座」。**
迁移(A+B+C)工作量小且方法就绪;真正的投入在 E(补新面),而那些面即使
不 rebase 也是缺口。

---

导出于 2026-07-23,基于 124→151 接缝核查与新特征调研。
