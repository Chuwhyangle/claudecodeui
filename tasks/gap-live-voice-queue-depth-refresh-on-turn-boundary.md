---
id: gap-live-voice-queue-depth-refresh-on-turn-boundary
title: 队列深度在回合边界排空时即刷新：无新事件也让 S-A 行与 session_status 归零（AC-338 落地后的残余缺口）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-344
---
## Proposal

### 现状（2026-10-12 复核 develop，`047f0b46` 落地后）

`gap-live-voice-queue-depth-host-lifecycle-truth`（AC-338，done）让 CLI 队列项改读 host 读数，但 `refreshHostQueue()` 只在三个事件上调用：`noteStatus`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:1182`）、投递结果（`:1403`）、中断（`:1843`）；文件内没有定时器。CLI 在**回合边界排空**时 relay 没有任何事件，于是排空后若用户不再说话，S-A 注入行与 `session_status`（读的是最后一次注入的读数）停在旧深度，直到下一次事件——与 SPEC §18.5「回合边界误差 = 0」和 AC-338 标题「回合排空即归零」不符。AC-338 判据按事件采样点断言，所以没有覆盖这段空窗。

### 要做的事

让回合边界本身成为一个刷新事件：优先订阅 host 的 `command_lifecycle`/`result`（driver 已有 `lifecycle`、`resultTimes` 读数），或在已有 S-A 限频窗口（2 s）内对 host 读数做有界轮询（仅当 phase≠idle 且 host 读数可用时），读数变化即走既有 compose+去重路径注入。⛔ 不新增周期性无变化注入（§8.3 event-driven 约束不变）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 回合边界信号（订阅优先，轮询兜底，写明选择理由）；2. 判据：排空后无新事件，≤ 2 s + 管线内 S-A 行与 `session_status` 归零；取假形态：去掉该信号 ⇒ 读数停在旧值；3. quay-test-script 钉子与基线；typecheck / lint。

## AC

- [ ] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-queue-depth-drain-refresh.test.ts` 退出 0；首组用例在「去掉回合边界信号」的假形态下断言读数停在旧值（证明会红），真形态下排空后无新事件、在限频窗口 + 管线内 S-A 注入行 `queued=0` 且 `session_status.queuedItems=0`。
- [ ] AC2：深度不变时不产生新注入（去重仍成立，给出注入计数读数）。
- [ ] AC3：`voice-realtime-queue-depth-truth.test.ts`、`voice-realtime-status-injection.test.ts`、`voice-realtime-status-tool.test.ts` 退出 0。
- [ ] AC4：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

真 proxy + 假 resident host 下：入队 3 条 → 回合边界排空 → 不再有任何语音事件，读到 S-A 注入行与 `session_status` 在窗口内归零（读数与时间写入 `## Notes`）；零云调用。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/index.ts（仅当需装配回合边界订阅 seam）
- server/modules/providers/services/provider-runtime.service.ts（仅当需暴露回合边界订阅）
- server/modules/providers/list/claude/claude-host-driver.provider.ts（仅当需暴露回合边界订阅）
- server/modules/voice-realtime/tests/voice-realtime-queue-depth-drain-refresh.test.ts (new)
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-queue-depth-refresh-on-turn-boundary.md

## Notes

立项：Opus 常驻架构会话 2026-10-12 复核 AC-338 落地代码时发现（GOAL-041）。挂 AC-344（诚实状态）；AC-338 已 achieved，是否重开由人决定，本任务不改其判据。
