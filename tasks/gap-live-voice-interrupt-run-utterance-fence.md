---
id: gap-live-voice-interrupt-run-utterance-fence
title: 中断栅栏与防抖：runId+utteranceSeq，已覆盖则 covered，同句幂等，UI 停止键不受限（阶段 1b，F3）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-queue-depth-host-lifecycle-truth
  - gap-live-voice-interrupt-audit-intent-trigger
goal_ac: AC-343
---
## Proposal

### 问题

模型对同一句话可能重复调用中断（E-2 类自答、TOOL_LOOP_GUARD 前的重试），或在当前 run **已经包含**那句修正时再次中断，造成反复中断抖动（SPEC §0.3 D-7）。今天的 `sessionInterrupt`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:1705`）无任何栅栏，只有「没 run 就 no-run」的幂等。

### 要做的事（SPEC §18.4 G2）

- 维护 `commandUuid → utteranceSeq` 映射（投递结果的 `queuedMessageUuid` / 投递时刻的 `utteranceSeq`），并依 host `command_lifecycle` 的 `started` 事件（AC-338 引入的读数通道）得出当前 run 的 `covers`。
- 模型发起的中断：仅当 `max(currentRun.covers) < triggerSeq`（`triggerSeq` 由 AC-339 引入）时执行；否则返回 `{stopped:false, reason:'covered'}`，journal 记 `outcome:'covered'`，不发第二条噪声 `stopped` 帧。
- 同一 `triggerSeq` 的重复调用幂等。
- **UI 停止键 / Esc 不经栅栏**（走 `chat.abort`，本任务不改那条路径，只加断言）。
- 非常驻会话（无 lifecycle）：栅栏退化为「同一 `triggerSeq` 只执行一次」，并在注释里写明。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 映射与 `covers` 计算；2. 栅栏判定；3. 判据文件；4. quay-test-script 钉子与基线；typecheck / lint。

## AC

- [ ] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt-fence.test.ts` 退出 0；首组用例在撤掉栅栏的假形态下断言出现两次 abort（证明会红），真形态下同一句两次中断 ⇒ 1 次 abort + 1 次 `covered`。
- [ ] AC2：当前 run 的 `covers` 已含触发句 ⇒ 中断为空操作，journal `outcome:'covered'`。
- [ ] AC3：同一状态下 UI 停止键（`chat.abort`）仍 abort。
- [ ] AC4：一个 run 内模型发起的有效中断 ≤ 1（构造 5 次调用的读数）。
- [ ] AC5：`voice-realtime-interrupt.test.ts`、`voice-realtime-interrupt-audit.test.ts`、`voice-realtime-queue-depth-truth.test.ts` 退出 0。
- [ ] AC6：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

真 proxy + scripted fake 上游 + 假 resident host 下复现「模型对同一修正连调 3 次中断」，读到 1 次 abort 与 2 条 `covered` 的 journal 原文（写入 `## Notes`）；零云调用。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-log.ts（仅当 outcome 枚举需扩）
- server/modules/voice-realtime/tests/voice-realtime-interrupt-fence.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts（仅当幂等钉子受影响）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-interrupt-run-utterance-fence.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-343）。依赖 AC-338（lifecycle 读数）、AC-339（triggerSeq）。
