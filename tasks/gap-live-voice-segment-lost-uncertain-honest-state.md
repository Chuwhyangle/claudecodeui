---
id: gap-live-voice-segment-lost-uncertain-honest-state
title: 逐段 uncertain/lost 诚实状态：浏览器按分级 ACK 渲染重试中/未送达/连接已断开（第二阶段后半）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-reconnect-epoch-scoped-commit-pairing
  - gap-live-voice-segment-honest-heard-unrecognized-state
goal_ac: AC-367
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


### 本任务（第二阶段后半，浏览器诚实状态）

在 AC-366 下发 `written / committed / lost` 分级 ACK 之后，把它接进 AC-355（`gap-live-voice-segment-honest-heard-unrecognized-state`）已建立的逐段处置模型：
- written 之后、committed 之前断线 ⇒「连接中断，正在重试这段话」；
- `lost(upstream-drop)` ⇒「这段话没有送达模型，请重说」；
- `lost(connection-closed)` ⇒「语音连接已断开，这段话没有发送」，且状态栏显示断开；
- lost 段**不得**显示为未识别、已发送或投递中；退出时**不**当作「模型未转发」回填（⚖️ 若人裁定 lost 段也回填，改为回填并标注「未送达」）。

文案进入全部 11 个 locale。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 读 AC-355 落地后的处置模型；2. 接入新 ACK 状态；3. vitest 判据（含取假形态）；4. typecheck / lint。

## AC

- [ ] AC1：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentLostState.test.tsx` 退出 0；「把 lost 帧当 dropped 处理」的取假形态下用例红。
- [ ] AC2：三种状态文案各有断言，lost 段不出现在 composer 回填中（或按裁定回填并标注）。
- [ ] AC3：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx`（AC-355 判据）仍退出 0。
- [ ] AC4：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

本地 vitest（本任务判据与 AC-355 判据）同时为绿；用 AC-366 下发的真实分级 ACK 帧驱动（不手写帧形状），三种状态文案在 11 个 locale 中都有；不改服务端代码，不开启任何生产开关。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx（断开状态）
- src/modules/chat/transcript/MessageComponent.tsx（仅当 lost 行在此渲染）
- src/modules/i18n/locales/*/chat.json（新增文案，全部 11 个 locale）
- src/modules/chat/voice-realtime/tests/voiceSegmentLostState.test.tsx (new)
- tasks/gap-live-voice-segment-lost-uncertain-honest-state.md

## Notes

立项：Opus 常驻会话，2026-10-13（GOAL-043 / AC-367）。depends_on AC-355 与 AC-366 的任务。
