---
id: gap-live-voice-double-drop-fault-injection-red-first
title: 双断线本地确定性红先行：scripted upstream 故障注入 F1–F6 + node:test 已知缺陷签名，D1–D6
  精确复现（只改测试，第一阶段）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-365
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


### 本任务（第一阶段，只改测试）

在**不改任何产品代码**的前提下，把 e22ac831 的双断线变成可在本地确定性重放、且在当前代码上**按签名精确变红**的用例，为第二阶段修复提供基线。

1. **故障注入扩展**（`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts`，在 AC-359 状态机之上，默认关闭，关闭时线上行为逐字节不变）：
   - F1 按拨号编排的故障计划：第 n 次拨号 接受 / 拒绝 / 接受后断开；
   - F2 由客户端事件触发断线：第 n 个 commit 到达时（在发 `committed` 之前）、某 seq 重放写出后、某事件后 X ms；
   - F3 「已处理但事件丢失」：上游已创建条目或已发出 `function_call`，但在把这些事件送达前断线；
   - F4 单帧 `append` 超过阈值字节即断开（**只用于本地复现 RC-5 场景，不代表真实上游的行为**）；
   - F5 注入时钟，使「206 ms / 1.15 s」等间隔可控；
   - F6 `e2e/voiceRealtimeScriptedUpstream.ts` 可读取同一故障计划（只加读取，不改现有行为）。
   - 每个 F 在 `voice-realtime-scripted-upstream-state.test.ts` 有自测，并有一个取假形态（例如 F2 改为墙钟触发 ⇒ 自测红）。
2. **node:test 已知缺陷辅助** `server/modules/voice-realtime/tests/voice-realtime-known-defect.ts`（非测试文件，不计入测试文件数钉子）：与 `e2e/voiceRealtimeKnownDefect.ts` 同语义：
   - 签名匹配才通过；
   - 别的失败抛 `unexpected failure signature`；
   - 断言通过抛 `defect no longer reproduces`；
   - 必填 `fixTask`。
   三种分支各有自测（放在 connection-resilience 文件内，避免新增测试文件）。
3. **D1–D6**：写进 `voice-realtime-connection-resilience.test.ts`（主题即重连；**不新增 `*.test.ts`**，避免触碰与 STS 任务共享的 `quay-test-script.test.ts` 计数钉子与 `suite-duration-baseline.tsv`）。用真实 bridge + 真实 ws-proxy + 假执行器，按 e22ac831 的事件序列编排（seq0 3.4 s 转写并投递；seq1 1.6 s 空转写；seq2 14.6 s；seq3 5.5 s 转写并投递；seq4 1.5 s 空转写；seq5 4.6 s 转写并投递）：
   - **D1** seq2：dial#1 第 3 个 commit 到达即断线（无 `committed`）→ dial#2 重放后 1.15 s 断线 → dial#3 正常；断言 seq2 的最终处置**不是** `empty-transcript`，且有显式的未送达或丢失处置。
   - **D2** 同一序列：断言 seq3、seq4、seq5 的 `itemId→seq` 各自正确（seq4 的空转写落在 seq4），即无跨 epoch 错配。
   - **D3** 变体 V-delivered：dial#1 在断线前已对 seq2 发出 `function_call` 并完成投递（F3 让后续事件丢失）→ 重放产生的第二次调用不得再投递；断言整个序列 `session_send` 对 seq2 恰好 1 次。**当前代码应为绿，直接断言，不包 expectKnownDefect。**
   - **D4** 变体：一次断线并成功重连、正常说几句、再断线并成功重连、再说几句、第三次独立断线：断言会话仍能重连（重连计数在成功打开后复位）。
   - **D5** 变体 V-fatal：重连预算耗尽导致连接关闭后，再结束 3 段：断言这些段**不收到** `segment_ack committed`。
   - **D6** 断言 `segment_ack committed` 只在上游 `committed` 之后发出（在 commit 写出、上游未答时观察到 committed 即违反）。
   - D1/D2/D4/D5/D6 在当前代码上用 `expectKnownDefect(签名, 断言, { fixTask: 'gap-live-voice-reconnect-epoch-scoped-commit-pairing' })` 包裹；签名取当前代码**第一行失败信息原文**（去掉时间戳、端口等变化部分，必要时用正则），**不得**用 `/.*/`、空串或只写测试名这类宽泛签名。
4. 运行三次，确认读数稳定（同一种子三次一致）。

<!-- dedup-ref --> 机制去重（2026-10-13）：open 任务对 replayedSeqs / pendingCommitSeqs / openAttempts / 重连 / 断线 0 命中；AC-359（done）提供协议状态机但无故障计划；`voice-realtime-connection-resilience.test.ts` 已有的 5 个用例覆盖工具输出重放，不覆盖段重放与跨 epoch 配对。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


- ⛔ 不改 `server/modules/voice-realtime/` 下任何非测试文件、`src/`、`server/index.ts`；不新增 `*.test.ts`（钉子文件在 STS 任务 Touches 内）。若发现非改产品代码不可复现某条 D，记入 `## Notes` 并停在 needs-human，不得顺手改产品代码。

## Plan

1. F1–F6 与自测；2. 已知缺陷辅助与三分支自测；3. D1–D6 编排与签名记录；4. 三次稳定性读数；5. `npm run typecheck`、`npm run lint`。

## AC

- [ ] AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts` 退出 0，含 F1–F6 自测与各自的取假形态。
- [ ] AC2：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts` 退出 0；文件内有 `test('D1 ` … `test('D6 ` 六个用例；D1/D2/D4/D5/D6 以 `expectKnownDefect` 包裹且 `fixTask` 为 `gap-live-voice-reconnect-epoch-scoped-commit-pairing`；D3 为直接断言。
- [ ] AC3：已知缺陷辅助的三分支自测在同一文件内通过（签名匹配 ⇒ 过；他种失败 ⇒ `unexpected failure signature`；断言通过 ⇒ `defect no longer reproduces`）。
- [ ] AC4：在 `## Notes` 记录 D1/D2/D4/D5/D6 各自的签名原文、为何它对应 journal 中的那个症状，以及三次运行读数一致。
- [ ] AC5：产品代码 diff 为空：`git diff --stat develop -- server/modules/voice-realtime src server/index.ts` 只出现 `tests/` 下文件。
- [ ] AC6：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

本地确定性跑通：双断线序列在真实 bridge + proxy 上按签名精确复现五个缺陷、D3 绿；零外联；三次读数一致；产品代码未改。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts（F1–F6 故障计划）
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts（F1–F6 自测）
- server/modules/voice-realtime/tests/voice-realtime-known-defect.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts（D1–D6 与签名辅助自测）
- e2e/voiceRealtimeScriptedUpstream.ts（只加读取同一故障计划）
- tasks/gap-live-voice-double-drop-fault-injection-red-first.md

## Notes

立项：Opus 常驻会话，2026-10-13，人 yale 授权（GOAL-043 / AC-365）。修复任务：`gap-live-voice-reconnect-epoch-scoped-commit-pairing`（AC-366）。
