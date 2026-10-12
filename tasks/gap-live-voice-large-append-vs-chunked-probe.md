---
id: gap-live-voice-large-append-vs-chunked-probe
title: 真实上游大帧 vs 分块 append 探针：验证或否证 RC-5，不预设结论（第三阶段）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-double-drop-fault-injection-red-first
goal_ac: AC-369
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


### 本任务（第三阶段，真实上游探针，验证或否证 RC-5）

e22ac831 中 3 次断线均紧随 ≥12 s 单帧 append（seq2 两次、seq6 一次），10 个 ≤5.5 s 段从未断线。这是**相关性**，不是证明。本探针在真实 `qwen3.8-omni-flash-realtime` 上回答：断线是否与单帧时长或字节数相关，分块 append 能否避免。

- manual commit（`turn_detection: null`），实验脚本内实现（不改产品代码）。
- 单帧时长梯度 2 / 5 / 8 / 12 / 15 / 20 s（PCM16 16 kHz，逐级记录原始字节与 base64 字符数），每档至少 2 次；同等时长按 200 ms 分块对照。
- 每次记录：是否断线、断线距写出的毫秒数、关闭码与原因（若有）、是否收到 `committed`、转写是否完整。
- 结论只允许「证实 / 否证 / 不足以判断」三选一，并引用读数。

安全：每连接 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION=0.05`，总花费上限 ¥1；备用端口实例或脚本直连；dry-run 执行面；不重启 :3001（记录前后 pid）；只跑一次。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 合成语料（TTS 或 `experiments/voice-trim/fixtures/` 拼接至所需时长）；2. 探针脚本；3. 单次运行；4. 报告。

## AC

- [x] AC1：`docs/operations/voice-realtime-large-append-probe.md` 含行首 `单帧梯度：`、`分块对照：`、`断线读数：`、`结论：`、`运行次数：`、`花费：`（AC-369 判据逐行检查）。
- [x] AC2：每次尝试附连接 id 与事件时间线摘录；结论引用具体读数。
- [x] AC3：报告写明运行次数 = 1、上限与实际花费、:3001 前后 pid 相同、dry-run 执行面。
- [x] AC4：`npm run lint` 退出 0（若新增脚本受 lint 覆盖）。

## DoD

真实上游跑过一次，RC-5 得到证实、否证或「不足以判断」的有据结论；产品代码 diff 为空。若证实，再另立「分块 append」任务，本任务不实现。

## Touches

- docs/operations/voice-realtime-large-append-probe.md (new)
- experiments/voice-realtime-large-append-probe/probe.mts (new)
- tasks/gap-live-voice-large-append-vs-chunked-probe.md

## Notes

立项：Opus 常驻会话，2026-10-13（GOAL-043 / AC-369）。depends_on 第一阶段任务，保证先有本地基线。
