---
id: gap-edit-replacement-absolute-floor
title: 编辑重发：replacement 的退休改用绝对切点 + 窗口原点（阶段 1 止血）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-edit-replacement-window-shift-red
---
## Proposal

<!-- dedup-ref --> 本条是 `gap-edit-replacement-window-shift-red` 的翻绿任务，依赖它先落一条窗口原点 ≠ 0 的 `it.fails` 读数。设计依据：`docs/proposals/transcript-authored-message-identity.md` §8（阶段 1）。相邻任务 `gap-activity-send-retry-duplicates-user-row` 修的是配对候选表，不碰窗口坐标系；本条的机制是「`replacesAfterRowCount` 在一个窗口捕获、在另一个窗口消费」。不是重复。

**要修什么**：`truncateAt`（`src/modules/chat/hooks/useSessionStore.ts:1608`）把 `slot.serverMessages.findIndex(...)` 的相对下标写进 `replacesAfterRowCount`，而 `removeOptimisticUserEchoes`（`src/modules/chat/utils/session/sessionMessageReconciliation.ts:151`）把它当作**当前窗口**的下标下限。窗口一滑（切会话、fresh tail page），持久化 replacement 落到下限之下，乐观行不退休；`readSortTime`（`useSessionStore.ts:378-381`）再把它钉到末尾。

**本阶段只做坐标止血**：把切点改成绝对历史下标，把窗口原点显式传给两个消费点；不引入身份、不删除文本/时间匹配。身份贯通是阶段 2 的独立任务。

## Plan

1. **绝对切点**：`truncateAt` 中 `absoluteCut = slot.startIndex + cutIndex`；保留字段名 `replacesAfterRowCount` 以避免跨阶段 churn，但把 `src/shared/types.ts:1684-1697` 的注释改为“**绝对历史下标**（replacement 在完整 normalized history 中的位置）”。阶段 2 删除该字段。
2. **窗口原点贯穿**：
   - `removeOptimisticUserEchoes(serverMessages, realtimeMessages, serverWindowStart = 0)`；消费端 `effectiveFloor = Math.max(0, absFloor - serverWindowStart)`，再交给 `findServerEchoForLocalUser`。
   - `computeMerged(serverSource, realtimeSource, serverWindowStart = 0)`；`mergeSessionRows(server, realtime, serverWindowStart = 0)`。
   - `pruneRealtimeSupersededByServer(serverMessages, realtimeMessages, blockKeyByRowId, serverWindowStart = 0)`。
   - `recomputeMergedIfNeeded(slot)` 传 `slot.startIndex`；`fetchFromServer` 与 `refreshLatestSlotFromServer` 在设置完 `slot.startIndex` 之后调用 prune 时传同一个值。
3. **tail page 的绝对原点**：给 `FetchHistoryResult`（`server/shared/types.ts:1133`）增加 `startIndex`；`sessions.service.fetchHistory` 对缓存切片与 provider 直读都返回 `startIndex = max(0, total - messages.length)`（offset 页的绝对起点）；客户端 `requestSessionHistoryPage` 读取 `data.startIndex`（缺省仍回退 `total - length`）。
4. **`cutIndex < 0` 的安全切点**：
   - 先找 replacement 行，再找 anchor；
   - anchor 不在 `serverMessages`、但存在 `replacesAnchorId === anchorId` 的 replacement：把 `absoluteCut` 记为 `slot.endIndex`（replacement 只会在其后落盘），不截断 serverMessages（窗口里没有旧行可截），recompute/notify；
   - 两者都没有：不写任何 floor、不改状态。
   - 锚点比窗口更老的路径仍是独立缺口，不在本条范围；在完成记录中登记。
5. **翻绿**：把 `gap-edit-replacement-window-shift-red` 的 `it.fails` 改成 `it`，断言 edited 文本只出现 1 次；保留其正控制。
6. **纯函数判据**：在 `sessionMessageReconciliation.test.ts` 增加 `serverWindowStart ≠ 0` 的用例：
   - 绝对 floor 36、windowStart 18、echo 在页内 19 → 退休；
   - floor 在窗口之后（如 50）→ 无候选、乐观行保留；
   - 正控制：两次真实同文发送、只有一条 persisted echo → 未配对的第二条保留。
7. **假形态**：临时把 `truncateAt` 改回存 `cutIndex`，或把消费端 `serverWindowStart` 固定为 0 ⇒ 阶段 0 用例必须变红；记录逐字红文案后还原。
8. **真实浏览器 DoD**：假 provider + MCP 浏览器，会话 >20 条 normalized message；发消息、Stop、编辑重发，在编辑回合仍在处理中时切走再切回，断言编辑后的 user 行只有一条；刷新后仍只有一条；截图存 `tmp/`。仓库没有对应 `scripts/ui-scenario.mjs` 场景，store 级判据就是常规回归；如实登记。

## AC

- [ ] AC1 阶段 0 用例翻绿：`npx vitest run src/modules/chat/tests/sessionStoreTruncate.test.tsx` 退出码 **0**；原 `KNOWN GAP` 用例已改为普通 `it`，edited 文本计数为 **1**；正控制 (a)(b) 同时绿。
- [ ] AC2 纯函数原点判据：`npx vitest run src/modules/chat/tests/sessionMessageReconciliation.test.ts` 退出码 **0**；含 `serverWindowStart=18, absFloor=36` 退休、`absFloor` 越过窗口不误退休、两次同文发送一对一三条断言。
- [ ] AC3 服务端起点：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sessions.service.test.ts` 退出码 **0**，且新增用例断言受限尾页的 `startIndex === total - messages.length`、无 `limit` 的整段读 `startIndex === 0`；`npm run typecheck` 退出码 **0**。
- [ ] AC4 承重假形态：临时把 `truncateAt` 的 `absoluteCut` 改回 `cutIndex`（或消费端 `serverWindowStart` 固定 0）后，AC1 的同一用例失败，失败读数含两条 edited 文本；逐字登记命令/退出码/`actual`，随后还原，`git diff` 只剩最终改动。
- [ ] AC5 `cutIndex < 0` 的安全切点：同文件新增用例——anchor 只在 realtime、replacement 存在时，不抛错、不丢 replacement，且 floor 记为 `slot.endIndex`（绝对）；anchor 与 replacement 都不存在时，store 状态逐字不变。两条各自独立可反红。
- [ ] AC6 真实浏览器：假 provider + 真 claude CLI + MCP 浏览器，>20 条历史，编辑回合仍在飞行中时切走再切回，编辑后的 user 行 **1** 条（原位那条有 `Edit and resend`，末尾无 `local_` 副本）；整页刷新后仍 **1** 条；截图存 `tmp/` 并在完成记录贴出路径。无可用场景运行器场景，如实说明。
- [ ] AC7 静态门：`npm run typecheck`、`npm run lint` 均退出码 **0**；单文件测试按 AGENTS.md 直接运行，不做无界 fan-out。

## DoD

真实浏览器里复现原故事并读回修复后的读数：会话 >20 条 normalized message；发送 → 中断 → 编辑改写 → 重发；在编辑后的回合仍显示处理中时切到另一会话再切回。修复前 transcript 末尾多一条只有 `Copy message` 的 edited user 行；修复后只有原位一条，刷新后仍只有一条。同时 `sessionStoreTruncate.test.tsx` 的窗口平移用例从 `it.fails` 翻绿，纯函数原点用例与两次同文发送的正控制同时绿；AC4 证明把坐标退回相对值会重新红。任何临时探针/日志必须还原，`git diff` 只落在 Touches 列出的文件上。

## Touches

- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/utils/session/sessionMessageReconciliation.ts
- src/modules/chat/tests/sessionStoreTruncate.test.tsx
- src/modules/chat/tests/sessionMessageReconciliation.test.ts
- src/shared/types.ts
- server/shared/types.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/tests/sessions.service.test.ts
- docs/proposals/transcript-authored-message-identity.md
- tasks/gap-edit-replacement-absolute-floor.md
