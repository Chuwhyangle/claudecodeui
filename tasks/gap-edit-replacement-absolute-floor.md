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

- [x] AC1 阶段 0 用例翻绿：`npx vitest run src/modules/chat/tests/sessionStoreTruncate.test.tsx` 退出码 **0**；原 `KNOWN GAP` 用例已改为普通 `it`，edited 文本计数为 **1**；正控制 (a)(b) 同时绿。
- [x] AC2 纯函数原点判据：`npx vitest run src/modules/chat/tests/sessionMessageReconciliation.test.ts` 退出码 **0**；含 `serverWindowStart=18, absFloor=36` 退休、`absFloor` 越过窗口不误退休、两次同文发送一对一三条断言。
- [x] AC3 服务端起点：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sessions.service.test.ts` 退出码 **0**，且新增用例断言受限尾页的 `startIndex === total - messages.length`、无 `limit` 的整段读 `startIndex === 0`；`npm run typecheck` 退出码 **0**。
- [x] AC4 承重假形态：临时把 `truncateAt` 的 `absoluteCut` 改回 `cutIndex`（或消费端 `serverWindowStart` 固定 0）后，AC1 的同一用例失败，失败读数含两条 edited 文本；逐字登记命令/退出码/`actual`，随后还原，`git diff` 只剩最终改动。
- [x] AC5 `cutIndex < 0` 的安全切点：同文件新增用例——anchor 只在 realtime、replacement 存在时，不抛错、不丢 replacement，且 floor 记为 `slot.endIndex`（绝对）；anchor 与 replacement 都不存在时，store 状态逐字不变。两条各自独立可反红。
- [x] AC6 真实浏览器：假 provider + 真 claude CLI + MCP 浏览器，>20 条历史，编辑回合仍在飞行中时切走再切回，编辑后的 user 行 **1** 条（原位那条有 `Edit and resend`，末尾无 `local_` 副本）；整页刷新后仍 **1** 条；截图存 `tmp/` 并在完成记录贴出路径。无可用场景运行器场景，如实说明。
- [x] AC7 静态门：`npm run typecheck`、`npm run lint` 均退出码 **0**；单文件测试按 AGENTS.md 直接运行，不做无界 fan-out。

## DoD

真实浏览器里复现原故事并读回修复后的读数：会话 >20 条 normalized message；发送 → 中断 → 编辑改写 → 重发；在编辑后的回合仍显示处理中时切到另一会话再切回。修复前 transcript 末尾多一条只有 `Copy message` 的 edited user 行；修复后只有原位一条，刷新后仍只有一条。同时 `sessionStoreTruncate.test.tsx` 的窗口平移用例从 `it.fails` 翻绿，纯函数原点用例与两次同文发送的正控制同时绿；AC4 证明把坐标退回相对值会重新红。任何临时探针/日志必须还原，`git diff` 只落在 Touches 列出的文件上。

## 完成记录

- **AC1**：`npx vitest run src/modules/chat/tests/sessionStoreTruncate.test.tsx` → `Tests 13 passed (13)`，退出码 **0**。原 `KNOWN GAP` 标题改为 `retires the persisted replacement after the window origin moves` 的普通 `it`；断言 `drawnEditedRows(view)` 长度为 1。同文件正控制（窗口原点不变时退休、两次同文发送保留未配对行）同时绿。
- **AC2**：`npx vitest run src/modules/chat/tests/sessionMessageReconciliation.test.ts` → `Tests 10 passed (10)`，退出码 **0**。新增 `serverWindowStart=18, absFloor=36`（页内 18 退休）与 `absFloor=50`（越过窗口不误退休）两条；既有的 `two real same-text sends with one persisted echo keep the unpaired row` 作为一对一正控制。
- **AC3**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sessions.service.test.ts` → `tests 9 / pass 9 / fail 0`，退出码 **0**。新用例 `history pages carry the absolute subscript of their first row` 断言：limit=2/offset=0 时 `startIndex === total - messages.length === 3`；无 limit 的整段读 `startIndex === 0`；offset=2 的老页 `startIndex === 1`。
  - 服务端实现：`FetchHistoryResult.startIndex` 设为可选，避免强迫 claude/codex/cursor/opencode 四个 provider 越出 Touches 改动；`sessions.service.fetchHistory` 在缓存切片与直读两条路径统一按 `max(0, total - offset - messages.length)` 填充。客户端 `requestSessionHistoryPage` 读取 `data.startIndex`，缺省回退 `total - length`。
- **AC4（承重假形态，逐字）**：命令 `npx vitest run src/modules/chat/tests/sessionStoreTruncate.test.tsx -t 'retires the persisted replacement after the window origin moves'`。
  - 先只把生产者退回相对值（`absoluteCut = cutIndex`，消费端仍减原点）：退出码 **0**。原因是相对 floor 19 落在新窗口原点 21 之下，`max(0, 19-21)` 归零后反而扫描全页，这条单独改动不构成有效假形态（已记录，不冒充）。
  - 改为只把消费端退回「忽略窗口原点」（`firstEligibleIndex = replacesAfterRowCount`）：退出码 **1**，逐字 `actual`：
    ```
    [
      'last prompt, corrected',
      'last prompt, corrected'
    ]
    ```
  - 随后逐字还原；`git diff` 只剩最终改动（见文末 diff 清单）。
  - 浏览器级同款控制（throwaway spec 临时把 `- serverWindowStart` 去掉）：`editedRows while in flight` 从 **1** 变 **2**，退出码 **1**；还原后回到 **1**、退出码 **0**。
- **AC5**：`sessionStoreTruncate.test.tsx` 新增 `stamps an absolute floor when the anchor lives only in the live rows`（窗口 startIndex=20/endIndex=22，anchor 只在 realtime + replacement 存在 → 不截断 serverMessages、replacement 保留、`replacesAfterRowCount === 22`）与 `leaves the store untouched when neither the anchor nor a replacement exists`（serverMessages/realtimeMessages 引用不变、startIndex/endIndex/total/offset 逐字不变）。前者在旧实现（`cutIndex < 0` 直接 return）下会因 replacement 丢失而红；后者在旧实现下同样绿，故它钉的是「不做无意义写入」的独立面。
- **AC6（真实浏览器）**：真实 Chromium + 真实后端 + Vite，真 `claude` CLI（v2.1.310，`ANTHROPIC_BASE_URL` 走宿主 relay）回答编辑回合；历史由一个写入 `~/.claude/projects/` 的 27 条 normalized message 的 Claude JSONL 提供（>20，正是 >20 才让 tail page 原点滑动）。流程：打开会话 → 点末条 persisted user 行的 `Edit and resend` → 改写重发 → 等编辑回合已落至少一条 assistant 行（tail page 原点已从 7 移到 9）→ 切到另一会话再切回 → 读 DOM。
  - 读数：`editedRows while in flight=["edited prompt after the cutTXT4:19:23 PMU"]`（**1** 条）；`restPageAfterReload.startIndex=9, total=29`，刷新后 `editedRows after reload=[…]`（**1** 条）；`1 passed (15.5s)`，退出码 **0**。
  - 截图（worktree 内，`tmp/` 已 gitignore）：`tmp/gap-edit-replacement/1-before-edit.png`、`tmp/gap-edit-replacement/2-switched-back-in-flight.png`、`tmp/gap-edit-replacement/3-after-reload.png`。
  - 偏离与如实说明：仓库没有该流程的 `scripts/ui-scenario.mjs` 场景（runner 的语义面只覆盖 Quay wall），因此用一次性 Playwright spec 驱动真实页面；该 spec 与为它临时加的 `SPEC_BUDGET_MS` 条目在交付前均已删除/还原。另：本 harness 里「先发一条 → Stop → 编辑这条刚发的消息」不可用——abort 后该 user 行没有进入可刷新的 tail page（CLI 已写 `[Request interrupted by user]` 但客户端不自动重读），故改在已 persisted 的末条 user 行上走**同一条 `chat.edit-send` → rewind/resume-anchor → history_truncated → tail page 滑动**路径；缺陷机制与判据读数完全一致。修复前的对照读数由上面的浏览器假形态给出（2 条，末尾一条只有 `Copy message`，原位一条有 `Edit and resend`）。
- **AC7**：`npm run typecheck` 退出码 **0**（client + server + scripts 三个 tsconfig）；`npm run lint` 退出码 **0**（仅既有 warning，无 error）。全部测试均按单文件直接运行，无 `--test` fan-out。
- **独立缺口登记（Plan §4）**：`cutIndex < 0` 且本客户端**没有** replacement 行的路径（典型：另一标签页持有的窗口比被编辑锚点更新，它只收到 `history_truncated`）仍是 no-op——本条保证编辑者自己的替换行有绝对 floor，但不保证第三方旧窗口能截断不可见的旧行。该缺口不在阶段 1 范围，留给身份贯通阶段。
- **交付状态**：实现提交 `c679313c1`（8 个 Touches 内文件）；`docs/proposals/transcript-authored-message-identity.md` 在 develop 上不存在（仅在 author checkout 未跟踪），本条未改动它，也未新增该文件。所有探针已删除（`grep -rn __gapEdit src server` 为空）。
- **续轮：fan-in suite 红（兄弟判据旧设计）**：fan-in 的 suite 腿红在 `server/modules/providers/tests/session-window-around.test.ts`（AC-210 判据），该文件不在本条的源码 delta 内。按提示先单文件复现，**复现成功**（非环境抖动）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-window-around.test.ts` 退出码 **1**，逐字 `AssertionError [ERR_ASSERTION]: limit=10 offset=0 diverged from the tail contract`；读数 `actual.startIndex=1230`、`expected.startIndex=0`，其余字段（messages/total/hasMore/offset/limit/tokenUsage）逐字相同。真实原因：本条 AC3 给 `fetchHistory` 信封新增的 `startIndex` 是**按页**的绝对原点（约束尾页为 `total - page.length`），而该兄弟判据把整个信封与 `{...full, …}`（整段读的 `full.startIndex=0`）做 `deepEqual`——既有的 tail 契约字段未变，变宽的是信封本身。处理（非「取 develop 版本」）：在该判据的期望信封上补 `startIndex = Math.max(0, full.total - offset - page.length)`，从**同一套切片算术**推导而非复制响应值（页报错原点仍会红），并在文件头注明该字段的来源与不变量；同时把该文件登记进 Touches。修后：`session-window-around.test.ts` **7/7 pass** 退出码 **0**；`sessions.service.test.ts` **9/9 pass** 退出码 **0**；`npm run typecheck` 退出码 **0**。

## Touches

- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/utils/session/sessionMessageReconciliation.ts
- src/modules/chat/tests/sessionStoreTruncate.test.tsx
- src/modules/chat/tests/sessionMessageReconciliation.test.ts
- src/shared/types.ts
- server/shared/types.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/tests/sessions.service.test.ts
- server/modules/providers/tests/session-window-around.test.ts
- docs/proposals/transcript-authored-message-identity.md
- tasks/gap-edit-replacement-absolute-floor.md

## Blocker

**2026-10-24T08:28:39.434Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/providers/tests/session-window-around.test.ts:   AssertionError [ERR_ASSERTION]: limit=10 offset=0 diverged from the tail contract
- run_id：wk-prod-anchor
- session_id：c76de98d-ae10-4159-831b-7501838ffddd
