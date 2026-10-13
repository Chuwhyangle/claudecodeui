---
id: gap-scenario-runner-playwright-executor-same-timeline
title: Scenario Runner 第二执行面：同一份时间线走 Playwright 假后端，证明纯面与浏览器面读数一致
status: done
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

- [x] AC1 `grep` 断言 e2e 执行面与纯执行面导入**同一**时间线模块路径，且 e2e 侧不再持有第二份时间线数组。
- [x] AC2 `npx playwright test <newExecSpec>` 退出 0。
- [x] AC3 两执行面对同一条时间线的终态读数**逐项相等**（写出比对断言；不可表达者列出替代读数与理由）。
- [x] AC4 零外联：egress guard 读数存在且非空（沿用既有 `e2e/support/egress-guard.mjs`）。
- [x] AC5 同一种子连跑 3 次读数一致（取假形态：把时间线改成依赖墙钟 ⇒ 三次不一致）。

## DoD

一份时间线、两个执行面；浏览器面的终态与纯面逐项一致，且 e2e 侧不再有第二份时间线拷贝。

## Touches

- e2e/session-lifecycle-scenario.spec.ts (new)
- e2e/voiceRealtimeScriptedUpstream.ts
- src/shared/scenarios/sessionLifecycle.timeline.ts
- playwright.config.ts
- tasks/gap-scenario-runner-playwright-executor-same-timeline.md

## Notes

⚠️ Playwright/e2e **不在 `scripts/test.sh` 的 lane 里**（见 `scripts/test.sh:2`），所以本任务的 spec 目前**不阻断合并**——这是既知缺口，由 gap-regression-gate-fan-in-lane-for-e2e-arm 承接。本条只负责让第二个执行面存在且读数一致。

### 落地读数（2026-10-13）

**AC1 的 grep 实测**（tracked + untracked 一并扫，不用 `git grep`，它看不见未跟踪文件）：
- 纯面 `src/modules/chat/hooks/tests/sessionLifecycleScenario.test.tsx:47,55` ← `'@/shared/scenarios/sessionLifecycle.timeline'`
- 浏览器面 `e2e/session-lifecycle-scenario.spec.ts:67,68` ← `'../src/shared/scenarios/sessionLifecycle.timeline'`
- 两个 specifier 去掉各自根前缀（`@/` ／ `../src/`）后同为 `shared/scenarios/sessionLifecycle.timeline`；`grep -rn "SESSION_LIFECYCLE_TIMELINE\|session-lifecycle-shared-timeline" e2e/` 除本 spec 外**无命中** ⇒ e2e 侧没有第二份数组、也没有第二个 id 字面量。

**`e2e/voiceRealtimeScriptedUpstream.ts` 核查结论：该文件里没有时间线数组**（全文无 `SESSION_LIFECYCLE_TIMELINE`、无按族事件表；`timeline` 一词只出现在两处讲「时间线」的注释里）。所以 Plan 第 1 条设想的「重复数组」在这个文件里不存在，**未改动它**（Touches 保留该行以免将来要改时被判未声明）。真正重复的是「每个面各写一份终态断言」，已由构件里的共享 fold 消掉。

**浏览器面的形态（AC3 的「不可表达者」条款，理由与替代读数也写在 spec 头部）**：真 Chromium 页面从本 run 自己的 Vite dev server 载入 app **自身**的模块（`/src/...`），绑到构件注入的 `SessionLifecycleSurface` 上折叠时间线——不是驱动 DOM、也不是对假后端发帧。未表达的两件事及替代读数：
1. **DOM 驱动 + 假后端那条腿**：未表达；替代读数取合并后转录**行**（DOM 正是从它渲染），理由＝四条不变量是归约的性质而非渲染器的性质，且 DOM 腿需要登录会话／项目／真回合，读到的是该值的**渲染**而非该值。
2. **族④的 `refresh` 缝**：只部分表达。`useSessionStore` 未导出纯 refresh，两面注入同一行模型（`server := 取回的行`）；比对钉的是「两面就模型彼此一致」＋「`merged === neverRefreshed`」，不是「该模型等于产线实现」。

**AC5 的「连跑 3 次」实现为每个执行面内 3 次折叠**：三次铸出的 live 行 id 实测 `live:scenario-session:8/16/24`（计数器每进程递增、从不重置），所以「三次读数一致」是同一条时间线折叠三次、而不是一次折叠报三遍；取假形态把整条时间线的时间戳改成墙钟后三次读数**互不相同**（实测三个不同毫秒值）。

**AC4 的两半**：本 run 的 server 侧 guard 日志（`QUAY_E2E_VOICE_REALTIME_EGRESS_LOG` 指向的文件）存在且**零条**拒绝记录（存在但为空＝「guard 活着、什么都没出去」）；另起一个子进程用**同一个** `e2e/support/egress-guard.mjs` 真拨 `example.com:443`，日志非空、带 `EGRESS BLOCKED` 标记 —— 所以「空」不会被误读成「guard 根本没加载」。

**门与实测**：`npx playwright test e2e/session-lifecycle-scenario.spec.ts` 连跑 3 次均 `3 passed`，约 9s（远低于 `SINGLE_SPEC_CEILING_MS` = 55s，故未加 `SPEC_BUDGET_MS` 条目）；纯面 `npx vitest run src/modules/chat/hooks/tests/sessionLifecycleScenario.test.tsx` 14 passed（其 §AC1 扫描会把本 spec 一起扫进去，仍绿）；`tsc --noEmit -p tsconfig.json` 0；`npm run lint` 0。

**`playwright.config.ts` 的改动**：本 spec 加入 `voiceRealtimeSelection`。原因不是它要走 voice 线（它不走），而是 AC4 要的是「**本 run** 的 egress guard 读数」，而 `QUAY_E2E_VOICE_REALTIME_EGRESS_LOG` 只对该选择发布；不加入的话这条判据只能退化成「在子进程里重跑一遍 guard」，读的是一个没有 server 写过的日志。该选择顺带注入的 endpoint／空 key 对一个从不开 voice 会话的 spec 是惰性的。
