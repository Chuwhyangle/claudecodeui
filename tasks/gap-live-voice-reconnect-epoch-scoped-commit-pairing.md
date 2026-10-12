---
id: gap-live-voice-reconnect-epoch-scoped-commit-pairing
title: 重连语义修复：epoch 作用域 commit 配对、按段重放预算、成功打开后复位重连计数、ACK 分级
  written/committed/lost（第二阶段）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-double-drop-fault-injection-red-first
  - gap-live-voice-silence-tail-suppression
  - gap-live-voice-double-drop-signatures-carry-actuals
goal_ac: AC-366
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


### 本任务（第二阶段，bridge/proxy 修复）

依据 AC-365 已复现的 D1/D2/D4/D5/D6 签名做最小修复，**修复后把这些腿从 `expectKnownDefect` 翻为直接断言**（不翻转则判据红）。

1. **epoch 作用域的 commit 配对**：bridge 维护 socket epoch；断线时该 epoch 的 `pendingCommitSeqs` 全部移出并发出 `uncertain(seq)`；新 epoch 的 `committed` 只与本 epoch 配对。重放写出时以新 epoch 入队。
2. **按段重放预算**：以「每段最多 K 次重放」替代「每段最多一次」，K 默认值在注释中写明取值理由并可配置。预算耗尽、连接终止 ⇒ `lost(reason)`。**不得**把「大帧导致断线」写成前提，不得据此加分块逻辑（分块与否由 AC-369 的读数决定，另立任务）。
3. **成功打开后复位重连计数**：`openAttempts` 在一次成功打开并稳定（判定条件写明）后复位；连续失败仍受上限保护。
4. **ACK 分级**：浏览器帧 `segment_ack.state` 增加 `written`、`lost`（含 `reason`），`committed` 只在上游 `committed` 后发出；连接不在 open 时结束的段只得 `lost(connection-closed)`。客户端当前只记日志（`useVoiceRealtimeSession.ts:1057-1061`），新增状态向后兼容；UI 渲染由 AC-367 接入。
5. **不变**：按段至多一次投递（D3 保持绿）、不自动补发、模型可不转发。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 读 AC-365 记录的签名与 D 用例；2. 修复 1–4；3. 翻转 connection-resilience 中 `fixTask` 为本任务的腿；4. 跑既有 segmented / resilience / replay 相关判据；typecheck / lint。

## AC

- [x] AC1：`grep -n "fixTask: 'gap-live-voice-reconnect-epoch-scoped-commit-pairing'" server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts` 无输出（全部翻转），且该文件 `npx tsx --tsconfig server/tsconfig.json --test …` 退出 0。
- [x] AC2：D3 仍为直接断言且绿（按段至多一次投递未被破坏）。
- [x] AC3：既有判据退出 0：`voice-realtime-segmented-protocol.test.ts`、`voice-realtime-scripted-upstream-state.test.ts`、`voice-realtime-teardown-races.test.ts`、`voice-realtime-replay.test.ts`、`voice-realtime-empty-transcript-guard.test.ts`。
- [x] AC4：重放预算 K 与重连复位条件的默认值、理由写在代码注释中；无任何「毒载荷 / 大帧」前提的分支。
- [x] AC5：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

本地 D1–D6 全部直接断言为绿；按段至多一次投递与不自动补发保持；不改 UI、不开启任何生产开关、不重启 :3001。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts（ACK 分级与 lost 帧）
- server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts（翻转已知缺陷腿）
- server/modules/voice-realtime/tests/voice-realtime-segmented-protocol.test.ts（仅当既有断言钉住旧 ACK 时机）
- server/modules/voice-realtime/tests/voice-realtime-teardown-races.test.ts（仅当既有断言钉住旧 ACK 时机）
- server/modules/voice-realtime/tests/voice-realtime-empty-transcript-guard.test.ts（仅当既有断言钉住旧 ACK 时机）
- server/modules/voice-realtime/tests/voice-realtime-caption-item-attribution.test.ts（仅当既有断言钉住旧 ACK 时机）
- tasks/gap-live-voice-reconnect-epoch-scoped-commit-pairing.md

## Notes

立项：Opus 常驻会话，2026-10-13（GOAL-043 / AC-366）。depends_on 含 STS 实现任务，因两者共改 bridge/proxy，避免抢占。

实施记录（2026-10-13）：

- 翻转后的 `connection-resilience` 15/15 绿，D1–D6 均为直接断言（含各自的假形态）。
- AC1 的 grep 字面量**本来就是空集**：翻转前所有调用点写的是 `fixTask: FIX_TASK` 常量，因此「无输出」在该文件里不是翻转的读数面；实质的一半是「该文件退出 0」，已单跑确认。
- AC3 五个文件单跑绿：segmented-protocol 21/21、scripted-upstream-state 26/26、teardown-races 3/3、replay 1/1、empty-transcript-guard 17/17；整个 `server/modules/voice-realtime/tests/` 目录在受限运行器下 47 文件 408 测试全绿。
- 两个 collateral 文件（empty-transcript-guard、caption-item-attribution）因既有断言钉住旧 ACK 时机而改，已补进 Touches；共享 harness（`realtime-bridge-harness.ts`、`voice-realtime-dashscope-harness.ts`）未动——segmented-protocol 的 AC7 用文件内 `committingUpstream` 包装器补上上游的 `input_audio_buffer.committed`，避开 5 个兄弟文件共用的 `emitted` 断言面。
- 未翻转、未纳入本任务的相邻读数：`e2e/voice-realtime-segmented-replay-20261012.spec.ts:1044` 在无故障变体里钉「每段一个 `segment_ack`」（新语义下每段仍是一个，形态由 committed 变为随上游而定）；该 spec 不在 fan-in suite 内，留待 AC-367/AC-369 一并核对。
- 客户端 `voiceRealtimeProtocol.ts` 的 `state: 'committed' | 'dropped'` 保持窄，未动——拓宽归 AC-367。
