---
id: gap-scenario-runner-playwright-executor-same-timeline
title: Scenario Runner 第二执行面：同一份时间线走 Playwright 假后端，证明纯面与浏览器面读数一致
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-scenario-runner-shared-timeline-pure-slice
---
## Proposal

纯执行面（`gap-scenario-runner-shared-timeline-pure-slice`）证明归约层的不变量；但它跑在进程里，证明不了**同一份时间线在真实浏览器 + 真实 server + 真实 `/voice-realtime` 代理下的读数一致**。本任务补上第二执行面：**导入同一份时间线构件**（不复制数组），在 Playwright 里对**假后端**执行。

**复用既有设施，不造平行框架**：
- `e2e/voiceRealtimeScriptedUpstream.ts` 已有 `startScriptedUpstream(port)` / `script(events)` / `dialFaults()`，且它**已经导入 server 侧的 `ScriptedEndpointEvent` 与 builders**——这正是既有的一半「两执行面」：同一套词汇，两处各自手写时间线数组。本任务要消掉的正是那个重复。
- `playwright.config.ts` 已用 `webServer` 起真 server + vite、`workers:1`、按 spec 注入 `VOICE_REALTIME_ENDPOINT` / 空 `DASHSCOPE_API_KEY` / egress guard，`reuseExistingServer:false`。
- 参考既有 spec 的形状：`e2e/voice-realtime-continuous-experience.spec.ts`（AC-361，fake mic 固定时间线）与 `e2e/voice-realtime-segmented-replay-20261012.spec.ts`（AC-352，按 journal 逐帧回放）。

**跨面一致性是读数，不是声明**：两个执行面对同一条时间线的**终态读数**必须逐项相等；若某族在浏览器面无法表达（例如纯内部归约），必须写明并给出替代读数，不许静默跳过。

## Plan

1. 让 e2e 侧 import 与纯侧**同一**时间线模块路径；删除或改造 `e2e/voiceRealtimeScriptedUpstream.ts` 中重复的时间线数组。
2. 写 Playwright 执行面：把时间线喂给假后端，驱动真实页面，读出终态。
3. 断言两执行面终态逐项相等；不可表达者显式列出替代读数与理由。
4. 零外联（沿用既有 egress guard）；同一种子连跑 3 次读数一致。

## AC

- [ ] AC1 `grep` 断言 e2e 执行面与纯执行面导入**同一**时间线模块路径，且 e2e 侧不再持有第二份时间线数组。
- [ ] AC2 `npx playwright test <newExecSpec>` 退出 0。
- [ ] AC3 两执行面对同一条时间线的终态读数**逐项相等**（写出比对断言；不可表达者列出替代读数与理由）。
- [ ] AC4 零外联：egress guard 读数存在且非空（沿用既有 `e2e/support/egress-guard.mjs`）。
- [ ] AC5 同一种子连跑 3 次读数一致（取假形态：把时间线改成依赖墙钟 ⇒ 三次不一致）。

## DoD

一份时间线、两个执行面；浏览器面的终态与纯面逐项一致，且 e2e 侧不再有第二份时间线拷贝。

## Touches

- e2e/session-lifecycle-scenario.spec.ts (new)
- e2e/voiceRealtimeScriptedUpstream.ts
- src/shared/scenarios/sessionLifecycle.timeline.ts
- tasks/gap-scenario-runner-playwright-executor-same-timeline.md

## Notes

⚠️ Playwright/e2e **不在 `scripts/test.sh` 的 lane 里**（见 `scripts/test.sh:2`），所以本任务的 spec 目前**不阻断合并**——这是既知缺口，由 gap-regression-gate-fan-in-lane-for-e2e-arm 承接。本条只负责让第二个执行面存在且读数一致。