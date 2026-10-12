---
id: gap-live-voice-pending-utterance-withdraw
title: 语音待投递条目逐条撤回：UI 确定性按钮复用 cancelQueued 链路，只撤单条、不给模型工具、不清空队列（阶段 2，D-11）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-interrupt-after-revision-enqueued
  - gap-live-voice-interrupt-run-utterance-fence
goal_ac: AC-351
---
## Proposal

### 问题与裁定（SPEC §0.3 D-11，阶段 2）

用户说错一句时，今天只能再说一句修正、靠模型中断来覆盖。已入 CLI 队列但未出队的话语其实可以**单条撤回**（E9、E10/U4 实测 `cancel_async_message` 有效）。打字消息已有这条链路：`src/modules/chat/transcript/PendingResidentMessage.tsx`（待执行行，按 `command_lifecycle` 三态渲染，`queued` 态带撤回按钮）→ `ChatInterface.tsx:999` `handleWithdrawResidentCommand` → 控制服务 `cancelQueued`。

**待核实的第一件事**：语音投递走 MCP `session_send` → 控制服务（不经聊天 websocket 的 send），这些消息今天是否也渲染成 `PendingResidentMessage` 行、是否带得到 `queuedMessageUuid`。本任务第一步先取读数并写进 `## Notes`，再决定是复用该行还是在 Live Voice 行上接同一撤回动作。

### 约束

- 仅 UI 确定性按钮（I-4）；只撤单条；⛔ 不给语音模型撤回/清空工具（C-1、D-2）；⛔ 不做清空队列。
- 撤回不触发 abort；撤回后深度读数（AC-338 的 host 对账）同步减一。
- 与栅栏（`gap-live-voice-interrupt-run-utterance-fence`）一致：被撤回的 `utteranceSeq` 不再计入任何 run 的 `covers`。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 读数：语音投递在聊天 UI 的渲染与 uuid 可得性；2. 接入撤回（复用优先）；3. vitest 判据；4. 若涉及服务端，新测试同步 quay-test-script 钉子；typecheck / lint。

## AC

- [ ] AC1（取假形态排最前）：`npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 退出 0；文件内对「撤回按钮不调 cancelQueued」的假形态断言会红。
- [ ] AC2：语音投递且 `queued` 的话语有撤回按钮，`started` 后按钮消失（两条断言）。
- [ ] AC3：点撤回 ⇒ `cancelQueued(sessionId, queuedMessageUuid)` 被调用一次；`cancelled` ⇒ 行标记已撤回；`already-started` ⇒ 诚实提示无法撤回；均不调用 abort。
- [ ] AC4：语音工具面仍恰为 `session_send`/`session_interrupt`/`session_status`（`voice-realtime-status-tool.test.ts` 绿）。
- [ ] AC5：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

在真浏览器（Playwright 或手工截图，零云调用、scripted fake 上游、假 resident 会话）里完成一次「语音 3 句排队 → 撤回中间一句 → 回合边界只送达另两句」，读数（截图路径、CLI 侧收到的文本条数）写入 `## Notes`。

## Touches

- src/modules/chat/transcript/PendingResidentMessage.tsx（仅当需扩展渲染条件）
- src/modules/chat/transcript/ChatMessagesPane.tsx（仅当需接入语音行）
- src/modules/chat/ChatInterface.tsx（仅当撤回处理需覆盖语音行）
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts（仅当需携带 queuedMessageUuid）
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx（仅当撤回入口落在语音条上）
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts（仅当需把 queuedMessageUuid 下发给浏览器）
- src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx (new)
- tasks/gap-live-voice-pending-utterance-withdraw.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale「按建议推进」（GOAL-041 / AC-351，SPEC D-11 阶段 2）。依赖先入队后中断（1a）与栅栏（1b）。
