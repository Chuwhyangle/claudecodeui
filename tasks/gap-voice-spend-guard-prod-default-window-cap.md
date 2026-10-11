---
id: gap-voice-spend-guard-prod-default-window-cap
title: Live Voice 速率保护：生产路径不再回落写死的 ¥0.015/30s 窗口上限，阈值只在显式配置时存在（诊断路由仍显式
  0.05）；防失控交给 TOOL_LOOP_GUARD
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on: []
---
## Proposal

**现状（2026-10-11 本轮亲自复核，逐行读到）**

| 事实 | 实测 |
|---|---|
| 触发点 | `server/index.ts:487`：`maxCnyPerWindow: input.spendWindowLimitCny ?? Number(process.env.VOICE_REALTIME_MAX_CNY_PER_30S ?? 0.015)`。生产路径是 `server/index.ts:665` 的 `buildVoiceRealtimeSeams` 调用，它**不传** `spendWindowLimitCny` ⇒ 吃写死的 0.015 |
| 谁自带阈值 | 只有开发/测试路径自带：`server/index.ts:988`（HTTP 诊断路由）显式传 `spendWindowLimitCny: 0.05`。**唯一依赖写死默认的恰恰是生产路径** |
| 有无环境分流 | 无。`server/index.ts:1533` 的 `isProduction` 是 `fs.existsSync(distIndexPath)`，只决定是否 serve 打包前端，够不到 voice seams；全仓 `grep -rn "VOICE_REALTIME_MAX_CNY"` 只命中 `server/index.ts:487-489` 与 `docs/operations/voice-realtime-test-stages.md:62-63` |
| 超限的后果 | 不可恢复：`SPEND_LIMIT` 不在 `RECOVERABLE_ERROR_CODES`（`voice-realtime-ws-proxy.service.ts:505-518`），`reportTransportError` 直接 `teardown()`（`:1167-1171`），用户读到 `:539` 的文案后连接结束。文案原文：`Voice spending guard: this connection used about ¥… (limit ¥…), so it was ended. Start Live Voice again to continue.` |
| 实测的一次误触 | 人于 2026-10-11 在真机 Live Voice 上读到 `Voice spending guard: this connection used about ¥0.017 in 30 s (limit ¥0.015), so it was ended.`（记于本轮 live voice 会话） |
| 该限制的既有定位 | 立它的 commit `a3e29098`（2026-10-10）自述动机是「A model retrying a tool call in a loop cost ¥0.49 in a minute (300,121 input tokens, 89 calls)」。文档 `docs/operations/voice-realtime-test-stages.md:62` 写的是「Every Live Voice connection is metered…」 |

**为什么这是缺陷，不是调参**

1. **SPEC 要求的动态阈值没实现。** `docs/proposals/voice-realtime-segmented-relay-SPEC.md:230`（C5）白纸黑字要求窗口阈值**随上下文包线性放宽**：`windowLimit = 0.015 + 0.003 × (包 token / 1000)`。实现里没有这一段，是平的 `0.015`。按 SPEC 自己测出的包大小（同文件 `:378`，`usage.input_tokens` p50 = 1036）算，阈值应是 `0.015 + 0.003 × 1.036 ≈ ¥0.0181` —— **人读到的 ¥0.017 低于它，按规格书实现这一次不会触发**。所以误触的直接成因就是这个缺失的缩放。
2. **补不上是结构问题，不是漏一行。** seams 在 `server/index.ts` 启动时装配一次，上下文包却是每连接在 proxy 里现读（`voice-realtime-settings.ts:103` `loadVoiceRealtimeSettings`），而 `createTransport(reportError)`（`voice-realtime-ws-proxy.service.ts:340`）的签名**不携带包大小** ⇒ SPEC 的每连接缩放今天没有任何通路能到达 transport。补齐它要改签名，属另一个任务（见「边界」）。
3. **阈值对正常工具使用本来就紧。** 按 `estimateRealtimeCostCny`（`voice-realtime-dashscope-transport.ts:164-177`；文本入 ¥0.0015/1k、文本出 ¥0.0045/1k、音频入 ¥0.006/1k），一次带 1.04k 包文本入、约 18 token 出的响应约 ¥0.0016 ⇒ ¥0.015 只够**约 9 次响应 / 30 秒**。而每次工具往返就是一次完整重读上下文的响应，工具密集的**正常**对话本来就能在 30 秒里跑掉 9 次 —— 这正是它炸在正常使用而不是失控上的原因。

**本任务要做什么**（方案由人 yale 于 2026-10-11 本轮选定：方案 B）

生产路径不再给默认窗口上限。`maxCnyPerWindow` **只在显式配置时存在**：要么 `input.spendWindowLimitCny`（诊断路由的 0.05 走这条），要么 `VOICE_REALTIME_MAX_CNY_PER_30S` 被设置。两者都没有 ⇒ 组装出的 `spendGuard` **不带** `maxCnyPerWindow`，窗口分支永不触发。`maxCnyTotal`（`VOICE_REALTIME_MAX_CNY_PER_CONNECTION`）**保持现状**：它本来就是显式 opt-in，不动。

防失控不靠这个阈值：`TOOL_LOOP_GUARD`（`voice-realtime-bridge.service.ts:307` `MAX_CALLS_PER_UTTERANCE = 6`、`:764` 抛错）独立覆盖了当初做守卫的那起事故 —— 89 次调用 ≫ 6，同一形态会被循环守卫拦住；且它按「用户说话」重置（`:702`），用户不说话时循环有硬上界。所以拿掉生产默认不会重新打开 ¥0.49 那个洞。

**解析必须落到一个纯函数，而不是留在组装点内联**，理由与本仓既有的两次同形改造一致（`gap-voice-segmented-relay-rollout-and-reconcile` 的 `resolveVoiceRealtimeMode`、`gap-voice-realtime-turn-detection-configurable-comparison` 的 `resolveTurnDetection`）：纯函数才可被**从这个调用点**读到默认，测试不必自行传入，从而不会出现「测试读一份、组装读另一份」的漂移。

**边界（不做）**：不做 SPEC C5 的包大小缩放（方案 A）—— 那要改 `createTransport` 签名把包 token 带进去，另立任务；不改诊断路由的 0.05；**不给生产造新的默认值**（0.05/0.1/无限都不给 —— 人的规则是「生产不设该限制，也不弹该提示」）；不改 `TOOL_LOOP_GUARD` 的阈值与语义；不改 `estimateRealtimeCostCny` 的价格与公式；不动 `src/`（前端）—— `describeTransportError` 的 `SPEND_LIMIT` 分支**保留**，显式配置的部署仍会用到它；不重跑实验、不改 `experiments/` 与 `docs/experiments/`。

<!-- dedup-ref --> 同机制去重（2026-10-11 本轮实测）：`grep -rln "VOICE_REALTIME_MAX_CNY_PER_30S\|maxCnyPerWindow\|SPEND_LIMIT\|spendWindowLimitCny" tasks/` **零命中** —— 该机制在任务库里从未被立案，立此守卫的 commit `a3e29098` 也不带任务引用（`git log -1 --format=%B a3e29098` 无 AC-/gap- 行）。Touches 判重：`buildVoiceRealtimeSeams` / `voice-realtime-spend-guard` / `voice-realtime-test-stages.md` 在 `tasks/*.md` 里的命中来自 `gap-live-voice-upstream-stall-no-answer`、`gap-voice-realtime-uplink-audio-capture`、`gap-voice-segmented-relay-protocol-server-commit`、`gap-voice-realtime-turn-detection-configurable-comparison`、`gap-voice-segmented-relay-rollout-and-reconcile`、`gap-voice-realtime-test-files-restore-quay-test-script-pins` 六条，**逐条 `grep -m1 '^status:'` 全是 `done`**，无在飞占用。本任务与它们无重叠读数：那六条分别管上游停顿通知、上行音频采集、分段协议服务端提交、turn_detection 可配、P4 默认开启与对账、测试文件计数 pin。

## AC

- [ ] AC1 纯解析函数的四条读数，且**不新增测试文件**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-spend-guard.test.ts` 退出 0。新增用例把 env 与 override **当参数喂**（不设 `process.env`），逐条打印：(a) `{} + override undefined` ⇒ `maxCnyPerWindow === undefined`；(b) `{} + override 0.05` ⇒ `=== 0.05`；(c) `{'VOICE_REALTIME_MAX_CNY_PER_30S':'0.02'} + override undefined` ⇒ `=== 0.02`；(d) 两者都给 ⇒ `override` 胜。**⛔ 不新增 `*.test.ts` 文件** —— `scripts/test.sh` pin 了 server 测试文件计数（见 `gap-voice-realtime-test-files-restore-quay-test-script-pins`，其 Touches 就含本判据文件），新增会把它顶红；本条的读数一律加进既有文件。
- [ ] AC2 非法值不静默（沿用 `resolveVoiceRealtimeMode` 的「不可静默」取向）：env 给 `'abc'`（`NaN`）、`'0'`、`'-1'`、`'  '` 时，读数打印 `invalid` 与 `maxCnyPerWindow === undefined`，并断言该解析结果带一条**可打印的报告**（形状照 `describeVoiceRealtimeMode` 返回非空串）。理由写进读数：今天 `Number('abc')` = `NaN`，而 `inWindow > NaN` 恒为 `false` ⇒ 打字错误静默地把守卫关掉，且日志里看不出来。
- [ ] AC3 组装面读数（源码读，沿用本仓既有手法）：读 `server/index.ts` 源码断言 —— (a) `buildVoiceRealtimeSeams` 的 `spendGuard` 构造里**不再出现** `0.015` 字面量；(b) 新解析函数在该文件里被调用**恰好一次**（词边界计数，避免 `VOICE_REALTIME_MAX_CNY_PER_30S` 这类子串误计）；(c) `server/index.ts:988` 那条诊断路由仍传 `spendWindowLimitCny: 0.05`；(d) `spendGuard.maxCnyTotal` 仍只在 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` 被设置时出现。逐条打印 `literalGone=<b> resolverCalls=<n> diagnoseLimit=<…> totalOptIn=<b>`。
- [ ] AC4 transport 语义未变 + 一条「不设上限 ⇒ 真的不设」的正读数：既有三条用例（runaway 触发、普通使用不触发、总额兜底）逐条绿。**新增**一条：`spendGuard: { windowMs: 30_000 }`（**无** `maxCnyPerWindow`）下，喂与 runaway 用例同一串响应（`usage(5_600, 100, 30)` × 5，约 ¥0.0084 each ⇒ 合计远超 ¥0.015）⇒ **不出现** `SPEND_LIMIT` 帧、`socket.readyState !== WS.CLOSED`。这是一条**正读数不是空过**：同一串响应在 AC1(d) 的配置下必须触发（打印两边的 `cny` 之和做对照）。
- [ ] AC5 既有契约不回归（逐条打印退出码，不是空过）：`voice-realtime-cost-replay.test.ts`、`voice-realtime-dashscope-transport.test.ts`、`voice-realtime-segmented-default.test.ts`、`voice-realtime-bridge.test.ts` 各退出 0。
- [ ] AC6 静态门：`npm run typecheck`（根 + `server/tsconfig.json`）退出 0；`npm run lint` 退出 0。
- [ ] AC7 文档与新语义一致：`docs/operations/voice-realtime-test-stages.md` 的 "Spend guard" 段落按新语义改写 —— 说明**默认不设窗口上限**（`VOICE_REALTIME_MAX_CNY_PER_30S` 未设时 `spendGuard` 不含 `maxCnyPerWindow`）、只在显式配置时存在、诊断路由仍用 ¥0.05 窗口、总额上限仍由 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` 显式开启；并把该文件 `:62` 那句 "**Every** Live Voice connection is metered …" 的现状描述改掉（它今天与代码不符）。另在同段落留一条注记：`docs/proposals/voice-realtime-segmented-relay-SPEC.md:230` 的 C5 包大小缩放（`0.015 + 0.003 × 包token/1000`）**是未实现的设计**，不属本任务，⛔ 不改 SPEC 正文（它是设计记录）。
- [ ] AC8 如实登记：判据输出与本任务的完成记录里写明「本条只做窗口上限的默认移除与纯函数化解析；未做 SPEC C5 的包缩放；未改诊断路由的 0.05；未改 `TOOL_LOOP_GUARD`；判据全程用既有假上游 harness，未接触真实上游、未起真实进程的部分由 DoD 覆盖」。

## DoD

一个**真实对象**被这套机制操作过（DIR-026 读法 A）：用**备用端口**起一份真实服务（`HOME=<隔离目录> SERVER_PORT=397x JWT_SECRET=x VITE_IS_PLATFORM=true npx tsx --tsconfig server/tsconfig.json server/index.ts`，⛔ 不要重启操作者那个 :3001 实例），**不设** `VOICE_REALTIME_MAX_CNY_PER_30S`，并用 `VOICE_REALTIME_ENDPOINT` 指向一个自托管的 stand-in 上游（该 override 正是为 criterion 存在的通路，见 `server/index.ts:436-442` 的注释与本条既有的 `socketFactory` 分支），再用一个真实 WS 客户端走**浏览器协议**的完整连接（`handleVoiceRealtimeConnection` 那条路，不是直接调 transport），让 stand-in 回一串 `response.done`，其 usage 之和在 30 秒窗口内 **> ¥0.015**（用 `estimateRealtimeCostCny` 现场算出并**打印这个数**）⇒ 读数必须是：**不出现** `SPEND_LIMIT` 帧、连接保持 open、没有 `Voice disconnected` 文案。

**正对照（这一条让「不触发」不是空集上的不触发）**：同一次装配加 `VOICE_REALTIME_MAX_CNY_PER_30S=0.001` 重起，喂**同一串**响应 ⇒ **出现** `SPEND_LIMIT` 帧且连接被 `teardown()`。两个方向都在真实服务上读到，才证明结论是「默认没有了，配了还在」而不是「守卫整个坏了」。

Evidence 里至少要有这些读数：`git log` 看得到本次改动提交；`git diff --name-status develop...HEAD` 与 `## Touches` 一致；上面两段读数（无配置 / 配 0.001）的逐字打印，含两边的 `Σcost` 数值；`voice-realtime-spend-guard.test.ts` 的完整退出码与 `elapsed-ms`。测试变绿是必要但不充分 —— **真机（真实服务 + 真实 WS 路径）两个方向可读**才是交付物。

## Touches

- server/modules/voice-realtime/voice-realtime-spend-guard.ts (new)（纯解析函数 + env 名常量；形状照 voice-realtime-mode.ts：入参显式给 env 与 override，不读 process.env、不日志、不碰 socket）
- server/modules/voice-realtime/index.ts (导出该解析函数与 env 名常量，供组装面经 barrel 引入 —— 后端标准要求跨模块只走 barrel)
- server/index.ts (生产路径不再回落 0.015 字面量；改调该解析函数；诊断路由的 0.05 与总额 opt-in 不动)
- server/modules/voice-realtime/tests/voice-realtime-spend-guard.test.ts (AC1/AC2/AC4 的读数；⛔ 不新增 test 文件)
- docs/operations/voice-realtime-test-stages.md (Spend guard 段落按新语义改写 + C5 未实现的注记)
- tasks/gap-voice-spend-guard-prod-default-window-cap.md (self)