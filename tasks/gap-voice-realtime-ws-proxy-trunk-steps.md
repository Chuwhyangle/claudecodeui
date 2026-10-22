---
id: gap-voice-realtime-ws-proxy-trunk-steps
title: voice-realtime-ws-proxy
  主干步骤注册：连接生命周期的横切步骤（握手后/每帧前后/中断决策/状态注入）做成可注册有序步骤表，中心只遍历（第三刀主干形态）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD 0acd5b0227fd）**：机制词 grep → 命中 `gap-voice-realtime-ws-proxy-frame-extension-point`（done，刀3）——它只把**入站帧 handler**（叶子）迁成了 frame registry；其余命中均为行为任务。**「把连接生命周期的横切步骤（主干）做成可注册步骤」无人认领，本条是刀3 的主干补集**。granularity `--touches voice-realtime-ws-proxy.service.ts` 报 `peers: []` ⇒ **separate**。

### 现状（立案时实测，archguard 新鲜读数）

- `voice-realtime-ws-proxy.service.ts` = **6576 行**；`handleVoiceRealtimeConnection` outDegree **66**（server scope 第二）。
- 刀3 迁出了帧 handler，但**连接生命周期仍内联**：握手（hello 协议协商）、每帧前后（解析→路由→状态注入→中断决策）、忙重试、连接关闭，以及横切 composer（`decideModelInterrupt` / `buildInterruptAftermathNote` / `createVoiceRealtimeNarratorQueue` / `createVoiceRealtimeExecStatus` / `describeBridgeError` / `describeTransportError`）。这正是 quay 刚定的「**主干没有注册位**」形态——叶子能注册，但「连接怎么走、每步前后做什么」这些编排步骤仍是硬编码的 if/else。
- perFile：**68 个已落地任务**碰过这个文件（中位 97 行/任务）——主干每加一个 voice 特性就再加一段。

### 改法

把连接生命周期的**横切步骤**做成可注册的有序步骤表（握手后 / 每帧前 / 每帧后 / 中断决策 / 状态注入 / 关闭前），`handleVoiceRealtimeConnection` 只负责遍历步骤表 + 帧路由（已注册）。**行为保持**：默认步骤逐字保持现有顺序与语义。

⛔ 护栏：新文件落 `server/modules/voice-realtime/` 同目录（不新建模块目录）；步骤表必须是**注册数据**（有序数组），不是四个可替换函数——否则就是 R1 提取、出度照升（quay 的判别标准）；步骤判据用**主干 Π**：正臂「钩子恰好 1 次」、负臂 0 次（计数断言，防重复调用）。quay 的 init.ts 主干四件套骨架落地后，本条的判据形态以其为准微调；在此之前按上面最小保守形态。

<!-- dedup-ref --> 相关但不同机制：`gap-voice-realtime-ws-proxy-frame-extension-point`（done）是本条的**前身**（拆帧 handler/叶子）；本条拆它的**补集**（连接生命周期/主干）。两者机制不同、验收独立，不构成前置。

## Plan

1. **盘点**：读 `handleVoiceRealtimeConnection` 的实际控制流，列出每个横切步骤及其顺序、每步的输入/副作用。
2. **定步骤表**：定义 `VoiceRealtimeTrunkStep`（name + source + 前置条件 + run(context)）与注册表（register/unregister/dispatch，未注册跳过）。
3. **迁步骤**：把横切步骤体逐字迁到兄弟 handler 文件、按默认顺序注册；连接处理函数只遍历。纯位移。
4. **判据**：正臂（非 ws-proxy 文件注册的步骤在对应时机被调用**恰好 1 次**）、负臂（未注册 0 次）、注入泄漏臂（去掉注册检查后同一断言红）。
5. **收口**：既有 voice-realtime 判据单跑仍绿、tsc/lint、collateral、范围受控。

## AC

- [x] (a) **步骤注册表存在且 ws-proxy 经它遍历**：`test -f server/modules/voice-realtime/voice-realtime-trunk-steps.ts` 退出 0；`grep -q "voice-realtime-trunk-steps" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 退出 0。
- [x] (b) **判据存在且跑通（正臂恰好 1 次）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-trunk-steps.test.ts` 退出 0；其打印读数显示「注册自非 ws-proxy 文件的步骤在对应时机被调用**恰好 1 次**」（计数断言，非存在性）。
- [x] (c) **负臂 0 次 + 注入泄漏臂**：同一判据含「未注册的步骤被调用 0 次」断言；且内存注入形态（去掉注册检查的 dispatcher）打红同一条断言函数（证负臂不真空）。
- [x] (d) **中心文件瘦身 + 静态门**：`test "$(wc -l < server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts)" -lt 6576` 退出 0（基线=立案实测 6576）；`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **既有行为判据不改一字仍绿**：`server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`、`voice-realtime-bridge.test.ts`、`voice-realtime-scripted-scenarios.test.ts` 各自单跑退出 0。
- [x] (f) **collateral**：新增一个 `server/**/*.test.ts` ⇒ quay-test-script 两条 pin 各 +1 及注释算术；覆盖率地板跌破 90% 才追加 suite-duration-baseline 行；单文件复跑 quay-test-script.test.ts 退出 0。
- [x] (g) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「一个新的连接生命周期步骤真的**从 ws-proxy 文件之外注册并生效**、未注册的不触发、既有连接行为不变」，不是「多了一个步骤文件」。必须贴出：①(b) 打印的原样输出（步骤来源路径、调用次数=1）；②正/负/注入三臂逐字读数；③(e) 三条判据单跑退出码；④(d) `wc -l` 前后与 tsc/lint；⑤纯位移核对（默认步骤体逐字迁出、顺序不变；无法原样迁的段逐条列出）；⑥`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`（横切步骤改经步骤表遍历，公开导出签名不变）
- `server/modules/voice-realtime/voice-realtime-trunk-steps.ts` (new)（步骤类型 + 注册表 + 默认步骤装配）
- `server/modules/voice-realtime/voice-realtime-trunk-step-handlers.ts` (new)（迁出的横切步骤体）
- `server/modules/voice-realtime/tests/voice-realtime-trunk-steps.test.ts` (new)（判据：正臂恰好 1 次 + 负臂 0 次 + 注入泄漏臂）
- `server/shared/tests/quay-test-script.test.ts`（collateral：两条 pin 各 +1 及注释算术）
- `scripts/suite-duration-baseline.tsv`（collateral：仅当覆盖率地板跌破 90%）
- `tasks/gap-voice-realtime-ws-proxy-trunk-steps.md`（自触）

## Verification

实现提交 `e3559bcb8`（task branch，develop 已 merge 进来，合并提交 `cdf0226f8`）。

### 形态

六个主干时机 `after-handshake` / `before-frame` / `after-frame` / `interrupt-decision` / `status-injection` / `before-close`，`VoiceRealtimeTrunkStepRegistry` 每个时机持**有序数组**（register 追加或同名原位替换、unregister 移除、`run` 按序执行并返回实际跑过的步骤；空时机跑 0 个、不抛、不回退内建体）。连接经可选 seam `trunkSteps` 注入，缺省 `createDefaultVoiceRealtimeTrunkSteps()`。

### ① (b) 正臂原样读数（每时机恰好 1 次，来源=判据文件≠proxy）

```
(b) positive-arm: wsProxySource=/…/server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts testSource=/…/server/modules/voice-realtime/tests/voice-realtime-trunk-steps.test.ts steps=5 tableTimings=6
(b) positive-arm: timing=after-handshake step=criterion.probe.after-handshake source=/…/voice-realtime-trunk-steps.test.ts triggered=1
(b) positive-arm: timing=before-frame step=criterion.probe.before-frame source=/…/voice-realtime-trunk-steps.test.ts triggered=1
(b) positive-arm: timing=after-frame step=criterion.probe.after-frame source=/…/voice-realtime-trunk-steps.test.ts triggered=1
(b) positive-arm: timing=status-injection step=criterion.probe.status-injection source=/…/voice-realtime-trunk-steps.test.ts triggered=1
(b) positive-arm: timing=before-close step=criterion.probe.before-close source=/…/voice-realtime-trunk-steps.test.ts triggered=1
(b) positive-arm: statusInjections=22 chars
```

驱动的是真连接（fake browser socket + fake upstream transport）：握手落地触发 `after-handshake`（其 shipped 步骤的 `advertiseInstructions` 触发 `status-injection`），一帧 `narrator_done` 触发 `before-frame`+`after-frame`，`socket.close()` 触发 `before-close`。

### ② 正/负/注入三臂

```
(c) negative-arm(table): triggered=0 registered=false
(c) negative-arm(injected): red=yes triggered=1 message=unregistered trunk step criterion.probe.after-frame was invoked (0 -> 1)
(c) negative-arm(restored): triggered=2 registered=true
```

注入臂打红的就是同一个 `assertTrunkStepNotInvoked`（`1 !== 0` 是 node:assert/strict 对被捕获的 AssertionError 打的差分）。三臂终值 = 注入 1 + 恢复臂 1，未注册臂 0。

### ③ (e) 三条既有判据单跑

- `voice-realtime-ws-proxy.protocol-simulation.test.ts`：tests 24 / pass 24 / fail 0（exit 0）
- `voice-realtime-bridge.test.ts`：tests 16 / pass 16 / fail 0（exit 0）
- `voice-realtime-scripted-scenarios.test.ts`：tests 31 / pass 31 / fail 0（exit 0）
- 另跑：`voice-realtime-interrupt-fence.test.ts` 6/6、`voice-realtime-frame-registry.test.ts` 4/4、`voice-realtime-segmented-protocol.test.ts` 21/21、`voice-realtime-trunk-steps.test.ts` 5/5。

### ④ (d) 瘦身与静态门

- `wc -l` 前后：6576 → **6512**（< 6576，exit 0）。
- `npx tsc --noEmit -p server/tsconfig.json` exit 0。
- `npm run lint` exit 0（oxlint 无新增 error/warning 落在本条文件上）。
- (f) quay-test-script：401 - 3 = 398 / 401 - 1 = 400（两 pin 各 +1 及注释算术），单文件复跑 14/14 绿；基线覆盖率 361/401 = **90.0%** ≥ 90% ⇒ 不追加 suite-duration-baseline 行。

### ⑤ 纯位移核对

逐字迁出：`readVoiceRealtimeInboundFrame`（before-frame 步骤体，含 raw→frame 收敛）、`decideModelInterrupt`（interrupt-decision 步骤体）、`whenConnected().then` 的 open/失败分支（after-handshake）、`bridge.sendSessionUpdate(composeVoiceRealtimeInstructions(...))`（status-injection）、`seams.audioCapture?.finalize()`（before-close）。两个对外导出的纯函数由 ws-proxy re-export，调用方路径不变。顺序不变：默认表按生命周期声明顺序注册，各时机内 shipped 步骤先于判据追加的探针。

无法原样迁、仍留在中心的段（逐条）：
1. `advertiseInstructions` 的 dedup key 计算、`context injected`/`status injected` 日志与 `onExecStatus` 回调仍在中心 —— 步骤只拿最终的注入动作，组合与日志是读数不是动作。
2. 中断路径中 `refreshInterruptCovers()`、covered 分支的 audit/日志/回执仍在中心 —— 步骤只做判决，不做回报。
3. teardown 的定时器清理、`flushOpenSegment`/`flushCoalesced`、speaker/uplink VAD 汇总行仍在中心 —— 它们读的是该函数自己的局部账本，不是横切步骤。
4. `after-frame` 刻意**无** shipped 步骤：它是纯扩展时机，判据探针是唯一注册者，用来证明「外部注册即生效、未注册即 0 次」。

### ⑥ 范围

`anti-drift-touches-check --train` 对 develop：`ANTI-DRIFT OK — 5 actual file(s), all within declared Touches (7 glob(s))`；实际 5 个文件 = 4 个实现/判据文件 + quay-test-script.test.ts。

不重启 :3001、不发布。
