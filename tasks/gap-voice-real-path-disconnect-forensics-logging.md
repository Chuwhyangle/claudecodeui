---
id: gap-voice-real-path-disconnect-forensics-logging
title: 真实 segmented 路径加断线取证日志（停止用真钱猜假设，等自然复现抓完整上下文）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**症状（2026-10-13 早上）**：segmented 下连续 4 段 17–20 s 的语音**整段丢失**（journal `0d2e6d93`/`10f039d0`）——commit 后立刻 `CONNECTION_LOST`，重连、再断、重连，三次耗尽后标 `segment N lost: upstream-drop`，没有转写、没有转发。

**两个隔离探针都已否证最直接的假设**：

- AC-369：真实上游 fresh 连接，单帧 2–20 s vs 200 ms 分块，24/24 **无断线** ⇒「帧大小/时长导致断线」(RC-5) 不成立。
- `docs/operations/voice-realtime-idle-history-probe.md`：history 臂（先一轮 + 空闲 18 s 再发 18 s 单帧）vs fresh 臂，共 6/6 **无断线** ⇒「连接历史+空闲」也不成立。

**保留的相关性**：失败会话是 `mode: segmented`（每段一个大单帧），当天 continuous 默认下的实测 0 断线。但**形态相关的相关性成立、机制未定位**。

**人已裁定**：不再花真钱跑更多假设。改为在真实路径上加细粒度日志，等下一次自然复现时抓到完整上下文。

## Plan

1. 在真实 segmented 路径的断开点补日志：断线前的 commit/append 时序、socket epoch、重放次数、上游 close code 与 reason。
2. **不改变任何行为**——只加读数。
3. 等下一次真实复现，用日志给出归因，或再次否证。

## AC

- [x] AC1 新增日志不改变行为：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/*.test.ts` 全绿（用 `scripts/with-memory-cap.sh` + `--test-concurrency=16`）。
- [x] AC2 日志足以区分三类归因——上游主动 close / 本地重放耗尽 / 配对错位——每条线对应哪一类在注释里写明。
- [x] AC3 `npm run typecheck` 与 `npm run lint` 均退出 0。

## DoD

下一次真实断线发生时，服务端日志足以把该次丢失归因到上述三类之一（或明确排除三者），无需再花真钱跑探针。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-log.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- tasks/gap-voice-real-path-disconnect-forensics-logging.md

## Notes

不要在这条里顺手改重放次数或重连策略——那是**未验证假设**，两份分析都写明"任何修复不得以它为假设前提"。本任务只做取证。

Touches 比立项时多两个文件，是取证读数本身的落点决定的，且都只加读数、不改行为：

- `voice-realtime-dashscope-transport.ts`：close code/reason 只存在于传输层 socket 的 `CloseEvent` 里（该 `onclose` 原先整份忽略了 event），不读它就永远拿不到"上游主动 close"那一类的读数。新增的 `onClose(detail?)` 形参是可选的。
- `voice-realtime-ws-proxy.service.ts`：桥只有 hook、日志只消费 `seams.log`，二者之间需要一处把读数格式化成 `segment_forensics {json}` 行（与既有 `session_interrupt audit {json}` 同构），且**不**走 `onError`——走错误通道会让浏览器把一次测量渲染成会话故障。

三条线各自的归属（写在各 emit 点注释里）：`upstream-close` → `handleTransportClose`；`replay-exhausted` → `replayCommittedSegment` 的预算耗尽分支（`stage: replay-budget`）与 `drainUnansweredCommits('lost')`（`stage: redial-budget`）；`pairing-mismatch` → `input_audio_buffer.committed` 的 epoch 守卫（队列仍持有旧世代 commit 时才会触发，是"漏了一次 drain"的读数，不是连续模式下 endpoint 自报 item 的常态）。