---
id: gap-scenario-runner-shared-timeline-pure-slice
title: 统一 Scenario Runner 最小纵切：一份共享时间线 + 纯 reducer 执行面，覆盖 busy/队列/乱序/归并四族
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

第三次 Live Voice 实测暴露的一类语义缺陷——**busy 发送的气泡在 `command_lifecycle: started` 消失**（已由 gap-chat-lifecycle-started-must-not-blank-message 修）、**队列行残留**、**乱序/late event**、**刷新与历史归并**——现在各自散在四个不同文件里，各有自己的逐形态夹具，彼此不知道对方存在。而 `scripts/test.sh` 的 fan-in 门只跑 server `node:test` 与 client `vitest`，**Playwright e2e 完全不在门内**（`scripts/test.sh:2` 的 lane 清单里没有 e2e）。结果是同一个语义缺陷可以在四个面上分别回归而没有任何单一门拦住。

本任务建立**统一 Scenario Runner 的最小可运行纵切**：**一份**提交入库的时间线构件，被多个执行面**导入同一模块路径**执行。本任务只做**纯 reducer/module 执行面**，并刻意让它**已经在门内**——client lane 是 `vitest run` 全集，所以新增的 vitest 文件自动成为 fan-in 闸门，不需要新接线。

**优先复用设施，不造平行测试框架**（硬约束）：
- 复用 `src/modules/chat/voice-realtime/placeCaptions.ts` 已导出的纯函数（`voiceTranscriptRows` / `heardUtteranceRows` / `markDeliveredVoiceMessages` / `deliveryIsShown`）。
- 复用 `server/modules/websocket/services/chat-run-registry.service.ts`——它已是**可注入时钟**（`retentionMs`/`now`/`bootId`）的独立实例。
- `useSessionStore.ts` 的转移逻辑若仍困在 `useCallback` 闭包里（`addResidentPending` / `applyCommandLifecycle`），按**最小抽取**把它暴露成 `(slot, event) => slot` 的纯函数，供执行面逐步归约；**不得**另写第二套 store 或第二套归并实现。

口径沿用 `docs/proposals/chat-transcript-streaming-architecture.md` §529「验收：性质测试（取代现在的逐形态用例）」。

## Plan

1. 定时间线构件的最小形状：事件序列 + 初始态 + 期望不变量；落在**两个执行面都能 import 的同一路径**（`src/` 侧用 `@/` 别名可达，e2e 侧相对路径可达），且**只有一份**。
2. 最小抽取纯转移入口；其余纯函数保持私有，不动导出面。
3. 写纯执行面：读时间线 → 逐步归约 → 断言四条不变量。
4. 四族各配一个**取假形态**（破坏该不变量 ⇒ 对应性质必红），确保断言不是空转。
5. `npm run typecheck` / `npm run lint`；新文件按需进 `scripts/suite-duration-baseline.tsv`。

## AC

- [ ] AC1 存在**恰好一份**时间线构件，两个执行面导入**同一模块路径**（`grep` 断言恰好两处 import、且时间线数组没有第二份拷贝；取假形态：把数组复制进 exec 文件 ⇒ 断言红）。
- [ ] AC2 纯执行面 `npx vitest run <pureExecFile>` 退出 0。
- [ ] AC3 覆盖①「busy 发送 + `command_lifecycle: started` + 替代行未到 ⇒ 文本仍在」；取假形态：把 `started` 的清空行为改回 ⇒ 红。
- [ ] AC4 覆盖②「queued → running → completed ⇒ 无残留行」（含 voice pending row）；取假形态：`completed` 不删行 ⇒ 红。
- [ ] AC5 覆盖③「重复 / 乱序 / late event ⇒ 归约幂等」（同一事件重复应用终态不变；乱序到达不产生第二行）；取假形态：去掉幂等保护 ⇒ 红。
- [ ] AC6 覆盖④「refresh / live / history 归并 ⇒ 与『从未刷新』逐项相等」；取假形态：去掉归并 ⇒ 红。
- [ ] AC7 `npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

一份时间线、一个纯执行面，四条不变量各有性质断言与取假形态；由于 client lane 就是 `vitest run` 全集，这些性质**自动**成为 fan-in 合并门的阻断项，无需为新门接线。姊妹任务再把同一份时间线接到 Playwright 假后端。

## Touches

- src/shared/scenarios/sessionLifecycle.timeline.ts (new)
- src/modules/chat/hooks/tests/sessionLifecycleScenario.test.tsx (new)
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- tasks/gap-scenario-runner-shared-timeline-pure-slice.md

## Notes

如果找不到既满足「一份」又满足两侧可 import 的中立路径，允许调整落点，但**必须**在 Notes 里写明为何该落点两侧都可达——不许为了省事复制第二份时间线。抽取纯函数时只动 `useSessionStore.ts` 的必要入口，不做无关重构。