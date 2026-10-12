---
id: gap-claude-resident-cancel-queued-capability-truth
title: 能力位 cancelQueuedInput 与 E9/E10-U4 实测一致：claude resident 置
  true，更正基于旧值的推理注释，不改运行时行为（D-11）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-350
---
## Proposal

### 现状（2026-10-12 复核）

- 能力矩阵 `server/modules/providers/services/provider-capabilities.service.ts:150` 写 `cancelQueuedInput: false, // not covered by E1–E8`。
- 但撤回能力已实现并实测：driver `claude-host-driver.provider.ts` `cancelQueuedInput()`（写 `cancel_async_message`，以 `state=cancelled` 为判据）、控制服务 `chat-control.service.ts` `cancelQueued`、MCP `session_cancel_queued`（AC-271）、聊天 UI `PendingResidentMessage.tsx` 撤回按钮。E9 实测撤回最新条目有效；E10/U4（`docs/proposals/claude-resident-sessions-experiments.md` §E10）实测撤回**非最新**条目有效。
- **无运行时代码读取该位**（服务端只有声明与类型 `server/shared/types.ts:3124`；前端 `useActivityControls.ts` 只读 `stopTask`/`backgroundTasks`）——它只在误导推理：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:189` 的 "WHY IT CANNOT BE A CANCELLATION. The provider's `cancelQueuedInput` slot is `false` …" 注释，以及 SPEC 早期版本。

### 要做的事（SPEC §0.3 D-11）

把该位改为 `true`，注释引用 E9 与 E10/U4；更正 ws-proxy 那段注释（准入轴仍为字节预算，理由改写为「撤回是 UI 的确定性动作，不是准入手段」，不改任何行为）；新增判据文件钉住矩阵值；同步 `server/modules/session-hosts/tests/lifecycle-mode.test.ts:844` 等既有钉子。⛔ 不改任何运行时行为，不给语音模型加工具。

<!-- dedup-ref --> 机制去重：open 任务对 `cancelQueuedInput` 能力位 0 命中。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 改位 + 注释；2. 更正 ws-proxy 注释；3. 新判据文件 + 既有钉子；4. quay-test-script 钉子与基线；typecheck / lint。

## AC

- [ ] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts` 退出 0；首条断言 `PROVIDER_CAPABILITIES.claude.residentFeatures.cancelQueuedInput === true`，文件内对「改回 false」的假形态断言会红。
- [ ] AC2：该文件扫描 `voice-realtime-ws-proxy.service.ts`，断言不再含「slot is `false`」类推理表述。
- [ ] AC3：`server/modules/session-hosts/tests/lifecycle-mode.test.ts` 及其余引用该位的既有测试（`claude-resident-control-queue.test.ts`、`chat-control-*.test.ts`、`debug-agent-host-driver.test.ts`、`mcp-not-found-semantics.test.ts`）退出 0。
- [ ] AC4：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

`GET` 能力矩阵（服务端读数或判据内直接读模块）显示 claude 的 `cancelQueuedInput: true`，且仓内无基于旧值的推理注释残留（`grep` 读数写入 `## Notes`）。

## Touches

- server/modules/providers/services/provider-capabilities.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts（仅注释）
- server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts (new)
- server/modules/session-hosts/tests/lifecycle-mode.test.ts（能力位钉子）
- server/modules/providers/tests/claude-resident-control-queue.test.ts（仅当钉住旧值）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-claude-resident-cancel-queued-capability-truth.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale「按建议推进」（GOAL-041 / AC-350，SPEC D-11）。
