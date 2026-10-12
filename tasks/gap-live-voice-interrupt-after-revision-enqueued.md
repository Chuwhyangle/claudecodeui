---
id: gap-live-voice-interrupt-after-revision-enqueued
title: 先入队后中断：修正确认入 CLI 队列后再 abort，stale-first=0，跨文本/语音顺序，中断语义扩到修正方向（阶段 1a，F2）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-queue-depth-host-lifecycle-truth
  - gap-live-voice-interrupt-audit-intent-trigger
  - gap-live-voice-prompt-drop-stop-word-trigger
  - gap-claude-resident-e10-enqueue-interrupt-drain
goal_ac: AC-342
---
## Proposal

### 现状（2026-10-12 复核）

`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:1705` `sessionInterrupt` 的顺序是**先** `base.session_interrupt`（abort），**后**释放合并窗口里的待投递片段（注释 "Release the backlog's first message NOW"）。若 CLI 在 abort 后立即出队（E10/U2 待证），旧排队消息会**单独**成轮，修正落到再下一轮——stale-first（SPEC §18.1 F-7）。同时 prompt 只把「停」当中断理由，用户「修正当前方向」时模型不会中断（F-5）。

### 要做的事（SPEC §18.4 G1 + §0.3 D-6）

1. **先入队后中断**：一次中断若伴随修正文本（合并窗口中的片段，或中断调用携带的 `message`——二选一，按 `gap-claude-resident-e10-enqueue-interrupt-drain` 的 U1/U2 结论选择并在实现注释里引用 E10 读数），必须先把修正送入 CLI 队列并取得 `queued:true`（或 `queuedMessageUuid`）确认，再 abort。修正入队失败 ⇒ **不** abort，诚实回执。
2. **语义扩展**：指令改为「当你判断用户想停止当前执行，**或想修正当前执行的方向**时，调用 `session_interrupt` 并在 `intent` 说明理由」；仍无关键词（AC-340 判据必须保持绿）。
3. **跨通道顺序**：文本 composer 与语音共用 CLI 队列，A+ 不改投递通道；判据要证明交错发送时 CLI 收到的顺序 = 发生顺序。
4. 不重复投递：被中断那一轮的输入已在 transcript 中，⛔ 不重发旧内容（F-8）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 读 E10 结论 → 选实现形态；2. 重排 `sessionInterrupt`；3. 指令语义扩展；4. 判据文件（假 resident host：abort 瞬间出队）；5. 新测试文件同步 quay-test-script 钉子与基线；typecheck / lint。

## AC

- [ ] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt-revision-order.test.ts` 退出 0；首组用例在「先 abort 后入队」的假形态下断言修正落到再下一轮（证明会红），真形态下下一轮 user 输入同时含旧排队消息与修正、修正在后，stale-first 回合数 = 0。
- [ ] AC2：composer 文本与语音交错（语音 A、文本 B、语音修正 C）⇒ CLI 收到顺序 A、B、C。
- [ ] AC3：修正入队被拒 ⇒ 未调用 abort，回执 `stopped:false` 且说明原因。
- [ ] AC4：被中断那一轮的输入不被重发（断言 CLI 收到的消息中旧内容只出现一次）。
- [ ] AC5：`voice-realtime-instructions-no-stop-words.test.ts`、`voice-realtime-interrupt.test.ts`、`voice-realtime-interrupt-audit.test.ts`、`voice-realtime-queue-depth-truth.test.ts` 退出 0。
- [ ] AC6：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

真 proxy + scripted fake 上游 + 假 resident host（按 E10 读数建模的出队时序）下跑完「连说 3 句 → 修正 → 中断」场景，给出 CLI 侧逐轮输入对照写入 `## Notes`；零云调用。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-tools.ts（仅当中断调用携带修正）
- server/modules/voice-realtime/voice-realtime-live-executor.ts（仅当中断调用携带修正）
- server/modules/voice-realtime/tests/voice-realtime-interrupt-revision-order.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts（顺序与描述钉子）
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts（指令文本断言）
- server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts（指令文本断言）
- server/modules/voice-realtime/tests/voice-realtime-log.test.ts（仅当 instructionsChars 钉子受影响）
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts（仅当需新增场景构件）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-interrupt-after-revision-enqueued.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-342）。依赖：深度真实（AC-338）、审计（AC-339）、删停止词（AC-340）、E10 读数（AC-341）。
