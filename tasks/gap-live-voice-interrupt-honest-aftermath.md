---
id: gap-live-voice-interrupt-honest-aftermath
title: 中断诚实善后：同源状态、在途工具说明（无回滚措辞）、不调 stopTask、不触 Quay worker/后台租约（阶段 1c，F6）
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
goal_ac: AC-344
---
## Proposal

### 问题

中断后用户与模型需要知道：停的是哪个 run、还剩多少会继续跑、上一轮停在哪个工具、可能留下了哪些部分改动。2026-10-12 的 transcript `c6493eb6` 里，第 1 轮写了 `/tmp/voice-watch.sh` 并用 `nohup … & disown` 起了后台监听——这类副作用**不会**被中断撤销，必须诚实告知（SPEC §0.3 D-8、§18.5）。同时中断绝不能波及 Quay worker / 后台任务（D-9）。

### 要做的事

1. **同源状态**：中断后 `stopped` 帧、S-A 行、`session_status` 的 `queuedItems/queuedBytes` 取自 AC-338 的 host 对账读数（同一份），并带 `runId`。
2. **在途工具**：从 host 流（或 run 活动存储）读出中断时刻最后一个已开始未结束的工具名作为 `inFlightTool`；读不到则 `null`，不猜。
3. **下一轮说明**：中断后第一条进入 CLI 的消息前附固定说明（英文或与会话语言一致的一句）：上一轮在执行 `<inFlightTool>` 时被中断，可能存在部分改动；之后的话覆盖之前冲突的内容。⛔ 不含 revert / rollback / undo / 撤销 / 回滚（§11.4）。
4. **边界**：中断路径不调用 `stopTask`、不改 `session_background` 租约、不发信号给任何非绑定会话进程；以判据钉住。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 同源读数；2. `inFlightTool` 读取；3. 说明前缀；4. 边界判据（以替身子进程代表 Quay worker，断言中断后仍存活）；5. quay-test-script 钉子与基线；typecheck / lint。

## AC

- [ ] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts` 退出 0；首组用例在「中断路径调用 stopTask」的假形态下断言会红，真形态下 `stopTask` 调用次数 = 0、`session_background` 租约前后相同、替身子进程存活。
- [ ] AC2：中断后 `stopped` 帧、S-A 行、`session_status` 的 `queuedItems` 相等且等于 host 真实值。
- [ ] AC3：下一轮首条消息含 `inFlightTool` 名与「可能存在部分改动」的说明；全文不匹配 `/revert|rollback|undo|撤销|回滚/i`。
- [ ] AC4：`inFlightTool` 读不到时说明句改为不点名工具的版本，且 journal 记 `null`。
- [ ] AC5：`voice-realtime-interrupt-revision-order.test.ts`、`voice-realtime-interrupt-fence.test.ts`、`voice-realtime-interrupt-audit.test.ts` 退出 0。
- [ ] AC6：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

真 proxy + 假 resident host（第 1 轮停在一个长 Bash 工具上）中断后，读到下一轮 CLI 输入的实际文本、journal `kind:'interrupt'` 原文与替身进程存活读数，写入 `## Notes`；零云调用。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-live-executor.ts（仅当 inFlightTool 读数经 executor）
- server/index.ts（仅当需装配 inFlightTool 读数 seam）
- server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts (new)
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-interrupt-honest-aftermath.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-344）。依赖 AC-342、AC-343。
