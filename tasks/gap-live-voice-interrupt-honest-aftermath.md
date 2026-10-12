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

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts` 退出 0；首组用例在「中断路径调用 stopTask」的假形态下断言会红，真形态下 `stopTask` 调用次数 = 0、`session_background` 租约前后相同、替身子进程存活。
- [x] AC2：中断后 `stopped` 帧、S-A 行、`session_status` 的 `queuedItems` 相等且等于 host 真实值。
- [x] AC3：下一轮首条消息含 `inFlightTool` 名与「可能存在部分改动」的说明；全文不匹配 `/revert|rollback|undo|撤销|回滚/i`。
- [x] AC4：`inFlightTool` 读不到时说明句改为不点名工具的版本，且 journal 记 `null`。
- [x] AC5：`voice-realtime-interrupt-revision-order.test.ts`、`voice-realtime-interrupt-fence.test.ts`、`voice-realtime-interrupt-audit.test.ts` 退出 0。
- [x] AC6：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

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

实现：`voice-realtime-ws-proxy.service.ts` — `stopped` 帧增 `runId`（= 停掉的那个 run，来自 `audit.runId`，与审计/`session_status` 同一份读数）；新增 seam `hostRunActivity` 与类型 `HostRunActivityReading = { inFlightTool: string | null }`；`buildInterruptAftermathNote(inFlightTool)` 合成固定说明（点名工具版 / 不点名工具版，均不含 §11.4 禁用词）；`readInFlightTool()` 在 `sessionInterrupt` 顶部**只读一次**，写入审计、`stopped` 帧与下一轮说明，三者不可能分歧；`aftermathNote` 在 stop 的 backlog 释放**之后**装载、在第一条非空 `session_send` 消息上**消费一次**；`writeInterruptAudit` 增 `inFlightTool` 参数。`server/index.ts` — `hostRunActivity` 由进程级 activity store 的 turn 读数装配（`phase: 'tool'` 才给 `toolName`，其余与未知会话一律 `null`）。测试文件 `voice-realtime-interrupt-aftermath.test.ts` 新增（6 用例）；`quay-test-script.test.ts` 计数钉子 `unknown=308→309`、`unknown=310→311`；`scripts/suite-duration-baseline.tsv` 新增基线行（单文件计时 2026-10-12，2312ms）。

### DoD 读数（真 proxy + 假 resident host，第 1 轮停在长 Bash 工具）

- 下一轮 CLI 输入实际文本（`t.diagnostic` 实录）：
  `[The previous turn was interrupted while it was running the \`Bash\` tool. Any partial changes that tool had already made may still be present. Everything after this note is your current instruction and takes precedence over any conflicting thing said earlier.]\n\nnow do the small thing instead`
- journal `kind:'interrupt'` 原文（磁盘上的 `.jsonl` 行）：
  `{"at":"2026-10-12T12:29:37.647Z","kind":"interrupt","connectionId":"conn-aftermath","runId":"run-1","triggerSeq":1,"intent":"the user said stop","heard":"run the long bash thing","queuedStillPending":0,"inFlightTool":"Bash","by":"model","outcome":"aborted"}`
- 替身子进程（代表后台任务 / Quay worker，`nohup … & disown` 类监听）：`pid=2792197 alive=true`；`stopTask` 调用次数 = 0；`session_background` 租约列表中断前后 `deepEqual`。
- 零云调用：transport 唯一拨号地址 `upstream.dialedUrl` 以 `SCRIPTED_ENDPOINT_URL`（`ws://scripted.invalid`）开头。

### 判据实跑（本工作树，2026-10-12）

- AC1/AC2/AC3/AC4/DoD：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts` → tests 6 / pass 6 / fail 0（首组为假形态：`stopTask` 次数 = 1、租约 `notDeepEqual`、替身已死，三条子断言各自 `assert.throws` 均命中，真形态下三条全绿）。
- AC5：`voice-realtime-interrupt-revision-order` 7/7、`voice-realtime-interrupt-fence` 6/6、`voice-realtime-interrupt-audit` 4/4，均 exit 0。
- AC6：`npm run typecheck` exit 0；`npm run lint` exit 0（无新告警）；`server/shared/tests/quay-test-script.test.ts` 11/11 exit 0（新增文件后计数钉子 309/311 正确）。

## Blocker

**2026-10-12T12:35:29.829Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts:   AssertionError [ERR_ASSERTION]: the ready line must appear, got:
- run_id：wk-prod-anchor
- session_id：7cd82702-f72e-43a8-a799-a1c2f6d57b68
