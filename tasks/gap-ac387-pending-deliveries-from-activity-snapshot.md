---
id: gap-ac387-pending-deliveries-from-activity-snapshot
title: AC-387 前端待发行行按 deliveryId 从 activity
  快照派生：queued/started/completed/cancelled 的显示与重连恢复，旧帧存在时不双计，游标记录不受影响
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac383-delivery-activity-snapshot-channel
  - gap-ac385-send-deliveryid-runid-compat-window
  - gap-ac386-run-get-dual-id-delivery-wait
goal_ac: AC-387
---
## Proposal

SPEC `docs/proposals/resident-delivery-turn-ledger-SPEC.md` §9（S4 前端收口）承载本条 AC-387：**待发行的行身份改为 `deliveryId`，状态从 activity 快照的 `deliveries[]` 派生**，不再由 `command_lifecycle` 帧驱动；重连后行从快照恢复，不依赖重放 run 流。

现状（读基线代码）：
- 行由 `src/modules/chat/hooks/useSessionStore.ts` 的 `residentPendingRow`(:851) 铸造、`applyCommandLifecycleToRows`(:879) 与 `applyCommandLifecycle`(:1586) 折叠，键是 **commandUuid**：`queued`/`started` 保留文本、`cancelled` 清空文本但保留行、`completed` 从数组里删掉（离屏）。
- 状态来源是 `command_lifecycle` 帧：`src/modules/chat/hooks/useChatRealtimeHandlers.ts:475-481` 读 `commandUuid`/`commandState` 调 `applyCommandLifecycle`。行的键因此是 host 的 commandUuid，且只有「本客户端自己画过的行」会被更新。
- `src/modules/chat/hooks/useChatMessages.ts:408-415` 把 realtime 行映成 `ChatMessage`（`residentCommandUuid` / `residentCommandState`，`type: RESIDENT_PENDING_MESSAGE_TYPE`），`src/modules/chat/transcript/ChatMessagesPane.tsx:653-661` 渲染 `PendingResidentMessage.tsx`（DOM 属性 `data-command-uuid`）。
- 客户端 activity 快照的接收面：`src/modules/chat/hooks/useSessionActivity.ts` 的会话视图（`applyActivityFrame`，整份替换）与 `useChatRealtimeHandlers.ts:403-415` 的 `activity.snapshot` / `activity.upsert` 分支；`src/shared/types.ts` 的 `ActivitySnapshotFrame` 目前只有 `tasks`/`schedules`。

要做的事：待发行行改由 activity 快照的 `deliveries[]` 派生（AC-383 在服务端把它加进 `ActivityProtocolSnapshot`），键为 `deliveryId`；`queued` 画「排队中」、`started` 保留文本、`completed` 离屏、`cancelled` 清空文本但保留行（`id-relations` B-2 不变）；旧 `command_lifecycle` 帧在过渡期仍到达（已降级为会话级、无 `runId`/`seq`），与快照同时到达时按 `deliveryId` 去重，同一 delivery 只算一行；重连 = 取快照即恢复，不依赖谁重放 run 流；`replayCursor` 的 `{runId, seq}` 规则不变，无 `seq` 的会话级帧不进游标记录。

<!-- dedup-ref -->
阶段先后（`depends_on`，SPEC §12/§14）：本条是 S4，消费 S2 的 delivery 状态通道（gap-ac383-delivery-activity-snapshot-channel），并在 S3 出口 AC（gap-ac385-send-deliveryid-runid-compat-window、gap-ac386-run-get-dual-id-delivery-wait）之后落地。已用 `task-granularity-advice` 核对 Touches 不重叠（peers=[]、mentions=[]），无需合并。同批 S4 任务 AC-388（活动坞如实文案）与 AC-389（Escape 守卫）是不同机制、不同文件，本任务不含。

非目标：活动坞文案（AC-388）、全局 Escape 守卫（AC-389）、服务端账本与 API（S2/S3）、语音侧投递规则（GOAL-041/043/044，不得改其「一段音频一条文本」「不自动补发」等规则）。

## Plan

1. 先写判据 `src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx`（新建，vitest + jsdom）：渲染**真实的** `useSessionStore` 与真实的 `PendingResidentMessage`，按 AC-387 (a)–(e) 逐条断言。先看它红（文件不存在 ⇒ vitest `No test files found`，退出 1）。
2. 客户端 deliveries 视图：`src/shared/types.ts` 的 `ActivitySnapshotFrame` 增 `deliveries?: DeliveryView[]`（客户端形状：`deliveryId`/`state`/`source`/`priority`/`enqueuedAt`/`startedAt`/`endedAt`/`turnId`/`reason`/`text`），`src/modules/chat/hooks/useSessionActivity.ts` 的会话视图保留 `deliveries`（整份替换，缺字段按空数组）并暴露一个只读选择器。
3. `src/modules/chat/hooks/useChatRealtimeHandlers.ts` 把快照帧的 `deliveries` 交给该视图；`command_lifecycle` 帧的既有分支保留（过渡期双发）。
4. 待发行改由快照派生：`src/modules/chat/hooks/useSessionStore.ts` 的行按其 `deliveryId` 建键与折叠（四态按 B-2），`src/modules/chat/hooks/useChatMessages.ts` 的映射带上 `deliveryId`，`src/modules/chat/transcript/PendingResidentMessage.tsx` 把行的身份读数（`deliveryId`）暴露到 DOM。
5. 双源合一：按 `deliveryId` 去重——不以 runId、不以到达顺序为键。
6. 游标：确认无 `seq` 帧不进 `recordReplayCursor`（`useChatRealtimeHandlers.ts:323` 的 `typeof msg.seq === 'number'` 守卫保持），`src/modules/chat/utils/replayCursor.ts` 不改。
7. 跑守卫：新判据绿；既有 `src/modules/chat` 客户端测试保持绿（写下运行的文件清单与读数）；`npm run typecheck`、`npm run lint` 退出 0。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx` 退出 0。红态基线：文件不存在，vitest 报 No test files found（退出 1）。
- [x] AC2 (a) 行的键为 `deliveryId`、状态取自 activity 快照：`queued` 画「排队中」（`resident.pending.annotation` 文案）、`started` 保留文本、`completed` 离屏、`cancelled` 清空文本但保留行（`id-relations` B-2 不变）——在判据里逐条断言。
- [x] AC3 (b) 重连发生在排队中途：行从 `activity.snapshot` 恢复，判据只喂快照、不喂任何 run 流帧。
- [x] AC4 (c) 快照与旧 `command_lifecycle` 帧同时到达时同一 `deliveryId` 只算一行。
- [x] AC5 (d) 无 `seq` 的会话级帧不进游标记录，游标 `{runId, seq}` 规则不变（断言无 seq 帧不推进游标）。
- [x] AC6 (e) 取假形态：按 runId 给行做键 ⇒ (a) 红。先提交实现再变异，记录变异 diff、逐字失败行与恢复命令。
- [x] AC7 既有客户端测试不回退：写下运行的 vitest 文件清单与读数；`npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

- 判据渲染真实的 `useSessionStore` 与真实的 `PendingResidentMessage`（jsdom），不 mock 掉被测状态机；读数取自 DOM（`data-*` 属性与文案）与 store 的快照。
- 行为与 `id-relations` B-2 一致：`started` 不是终态、`completed`/`cancelled` 才是；`cancelled` 保留行、`completed` 离屏。
- 行的身份只来自 `deliveryId`；`runId` 不参与待发行的键（这正是 (e) 的假形态）。
- 重连恢复只读 activity 快照，不回放 run 流；游标 `{runId, seq}` 规则与 `replayCursor.ts` 不变。
- 遵守 `$frontend-module-standards`（`@/` 导入、`type` 不用 `interface`、`import type`、导出带消费方注释、跨模块只经 `index.ts` barrel、测试放 `src/modules/chat/tests/`）；若实现被迫写 `## Touches` 之外的路径，先用 task_write 加进 Touches 再写。
- 在 resident 会话的真实机制上运行：真实 store 收到真实形状的 activity 快照后驱动真实组件渲染，不以自造夹具替代。

## Touches

- src/shared/types.ts
- src/modules/chat/hooks/useSessionActivity.ts
- src/modules/chat/hooks/useChatRealtimeHandlers.ts
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/transcript/PendingResidentMessage.tsx
- src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx (new)
- tasks/gap-ac387-pending-deliveries-from-activity-snapshot.md

## AC6 (e) falsification record

Applied to the committed implementation (`9c0641c8f`, green at the time) — the row-set
key in `deliveryRowsFromSnapshot` replaced by the run/turn the delivery belongs to:

```diff
--- a/src/modules/chat/hooks/useSessionStore.ts
+++ b/src/modules/chat/hooks/useSessionStore.ts
@@ -1015,10 +1015,15 @@ function deliveryRowsFromSnapshot(
   const seen = new Set<string>();
   for (const delivery of deliveries) {
     const deliveryId = typeof delivery?.deliveryId === 'string' ? delivery.deliveryId : '';
-    if (!deliveryId || seen.has(deliveryId)) {
+    if (!deliveryId) {
       continue;
     }
-    seen.add(deliveryId);
+    // FALSE FORM (AC6/e): key the row set by the run/turn the delivery belongs to.
+    const key = delivery.turnId ?? '';
+    if (seen.has(key)) {
+      continue;
+    }
+    seen.add(key);
     const row = residentDeliveryRow(sessionId, delivery);
     if (row) {
       rows.push(row);
```

Verbatim failure — `npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx`,
1 failed | 3 passed, vitest exit 1:

```
 FAIL  src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx > (a) the pending row is keyed by deliveryId and its state comes from the snapshot > draws one row per delivery, and reads queued/started/cancelled/completed off the snapshot
AssertionError: one row per live-or-cancelled delivery: `completed` leaves the screen, and no delivery is merged with another — a row set keyed by the turn would draw two rows here
+ actual - expected

  [
    'd-1',
-   'd-2',
    'd-3',
-   'd-4'
  ]

 ❯ src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx:264:12
```

Only (a) reds; (b) / (c) / (d) stay green — the falsification lands on the keying claim itself,
not on the delivery channel. Restore: `git checkout -- src/modules/chat/hooks/useSessionStore.ts`
(re-read: 4 passed, exit 0).

## AC7 guard run

New criterion: `npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx`
⇒ 1 file, 4 tests passed, exit 0. Red-state baseline confirmed first (criterion file moved aside):
`No test files found, exiting with code 1`.

Every existing test file that imports a touched module (30 files), under
`scripts/with-memory-cap.sh` ⇒ 30 files, 164 tests passed, exit 0:
`src/modules/chat/hooks/tests/sessionLifecycleScenario.test.tsx`,
`src/modules/chat/hooks/tests/useSessionStoreCommandLifecycle.test.tsx`,
`src/modules/chat/tests/{activityDockControls,activityDockTaskSchedule,adjacentEchoCollapse,chatInterfaceEscapeAbort,chatRealtimeIgnoresActivityHeartbeat,echoSeparatedByToolRow,forkFromAssistantReply,liveRowIdentity,liveVoiceNewSessionEntry,machineOriginRow,pendingDeliveriesSnapshot,permissionPromptReplay,replayCursorAcrossRuns,sessionStoreTruncate,tokenBudgetSessionScope,tokenUsageFreshness,unviewedSessionStreamAccumulation,voiceEntryNewSessionSelection,voiceModePermissionBanner,workSegmentKeyStability}.test.tsx`,
`src/modules/chat/tests/{compactionRows,liveSubagentGrouping,monitorEventCollapse,sessionStoreWindow,useChatMessages,workSegmentAnchorStability,workSegmentGrouping}.test.ts`,
`src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx`.

Whole chat module (the module this task changes), same wrapper ⇒ 124 files,
921 passed | 1 skipped, exit 0.

`npm run typecheck` ⇒ exit 0 (tsconfig + server/tsconfig + scripts/tsconfig).
`npm run lint` ⇒ exit 0 (warnings only, none introduced by this task).
