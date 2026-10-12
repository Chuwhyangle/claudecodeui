---
id: gap-live-voice-double-drop-browser-e2e
title: 双断线浏览器验收：fake mic + 同一故障计划的本地 e2e 上游，零外联（第三阶段）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-segment-lost-uncertain-honest-state
goal_ac: AC-368
---
## Proposal

### 证据与架构不变量（本组任务共用）

证据：journal `~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl`（2026-10-12 16:01–16:03 UTC，segmented，13 段，全部 `frames=1`）：
- seq2（14.6 s 单帧）写出 commit 后 206 ms 断线 1/3，未收到 `committed`；重连后重放，1.15 s 后断线 2/3；第二次重连因 `replayedSeqs`（`voice-realtime-bridge.service.ts:633, 754-760`）不再重放 ⇒ seq2 丢失。
- `pendingCommitSeqs`（`:649`，入队 `:733`，出队 `:837, :885-886`）断线不清空 ⇒ 残留 `[2,2]`，seq3/4/5 的 `committed` 错配两位；ws-proxy 的 `segmentSeqByItemId`（`:2644-2648`）据此把 seq4 的空转写记成「segment 2 dropped: no words」（`markSegmentEmpty` `:2105-2111`）。
- `openAttempts` 终身不复位（`:538/878`）；seq6（12 s 单帧）写出后 1.07 s 断线 3/3 ⇒ 连接永久关闭。
- `endSegment` / `flushOpenSegment` 无条件发 `phase: 'committed'`（`:1145-1159`），`writeSegmentClose` 在非 open 时直接返回（`:729`）⇒ 关闭后 seq7–12 仍收到 `segment_ack committed`（ws-proxy `:2615`）。
- RC-5（**未验证假设**）：3 次断线全部紧随 ≥12 s 单帧 append，10 个 ≤5.5 s 段从未断线。只由 AC-369 的真实探针判定，任何任务不得以此为前提。

不变量（验收以此为准）：
- **ACK 分级**：written（已写到上游 socket）≠ committed（上游 `input_audio_buffer.committed`）≠ recognized（转写完成）≠ delivered（`session_send` 进入 CLI 队列，`sent` 帧）。只有 delivered 叫「投递」。
- **按段至多一次投递**：同一 `seq` 跨 socket epoch 至多一次 delivered；已投递段的重放调用被丢弃（现有 `deliveredSegmentSeqs` 重放闸，`ws-proxy:2131`）；不自动补发。
- **epoch 作用域**：`committed` 只与同一 socket epoch 内未决的 commit 配对；断线即清空，未决段转 uncertain。
- **处置完备且诚实**：每段终态为 delivered / not-forwarded / empty / failed / lost(reason) 之一；lost 不得记为 empty。
- 签名纪律（AC-357 同款）：当前缺陷腿只在**记录的首行失败签名**下通过；意外通过或别的失败必须红。


### 本任务（第三阶段，浏览器验收）

单 spec `e2e/voice-realtime-double-drop.spec.ts`：fake mic 播放 seq0..5 时间线，本地 e2e 上游读取 AC-365 的同一故障计划（F6），AC-360 外联守卫。断言页面：
- seq2 显示未送达；
- seq3–5 字幕各自归属、按说话顺序；
- V-fatal 变体下，连接终止后说的话标为未发送，且状态栏显示断开；
- 投递条数满足按段至多一次。

单次运行 < 100 s。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 编写 spec：fake mic 播放 seq0..5 时间线（时长与 journal e22ac831 一致，音频为合成），e2e 上游读取 AC-365 的故障计划，加 V-fatal 变体；2. 本地连续三次运行并记录耗时与断言读数；3. 在 playwright.config.ts 登记预算；4. `npm run lint`。

## AC

- [ ] AC1：`npx playwright test e2e/voice-realtime-double-drop.spec.ts` 退出 0，无 `test.fail` / `skip`。
- [ ] AC2：零外联读数（AC-360 守卫）；三次运行耗时均 < 100 s。
- [ ] AC3：`npm run lint` 退出 0。

## DoD

真实浏览器在本地跑通「双断线」与「永久断开」两个变体，页面上的处置文案与 AC-367 一致；三次运行读数、外联守卫读数写入 `## Notes`；不重启 :3001，不改产品代码。

## Touches

- e2e/voice-realtime-double-drop.spec.ts (new)
- playwright.config.ts（新 spec 预算登记）
- tasks/gap-live-voice-double-drop-browser-e2e.md

## Notes

立项：Opus 常驻会话，2026-10-13（GOAL-043 / AC-368）。
