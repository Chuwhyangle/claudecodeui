---
id: gap-live-voice-upstream-stall-no-answer
title: Live Voice 上游静默（听到但不回答）后该轮话语无归宿：实测 31 s 静默、8 s 已抛
  UPSTREAM_STALLED，用户体感「说完没反应」——先归因再定形态
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
---
## Proposal

**来源**：真人使用 Live Voice 的现场记录（`server.log`，时刻均为 UTC）。用户体感原话（通过 Live Voice 说出，被模型原文转写并投递，`d88c6722` 会话 2026-10-10T18:38:06Z）：

> 「我说完之后就没反应了。」

**现场证据（逐字）**：`UPSTREAM_STALLED (recoverable): The voice service heard you but has not answered for 8 s; it may be slow or stuck.` 在真实会话上出现过 **2 次**：

- `2026-10-09T16:13:35.400Z`（会话 `439bce2b`）
- `2026-10-11T01:56:35.223Z`（会话 `d88c6722`）

第二次有完整时序，可作回归基线：

```
01:56:22.190  << input_audio_buffer.speech_started      ← 上游听到人开始说话
01:56:22.333  << conversation.item.created
（01:56:22 → 01:56:53 之间：上游零事件，浏览器每 ~5 s 仍在推音频帧）
01:56:35.223  to-browser error UPSTREAM_STALLED (recoverable)   ← 8 s 静默时抛出
01:56:47.537  teardown: the browser socket closed               ← 浏览器先关了
01:56:53.118  << input_audio_buffer.speech_stopped      ← 上游 31 s 后才收尾
01:56:53.319  << transcription.completed "现在我看见只有…"
01:56:53.679  << function_call session_send {"message": "…"}
```

⇒ 上游真的静默了约 **31 s**，之后自己恢复（恢复后 0.56 s 内就走完了转写 + 投递）。关键：**8 s 抛出 `UPSTREAM_STALLED` 之后，这一轮用户话语的归宿没有被定义**——今天只有一条 recoverable error 帧，"屏幕上没反应"就是它的可见后果。

**去重（按机制，逐条核实过）**：本症状**无既有任务拥有**。

- `gap-voice-realtime-connection-resilience`（**done**）覆盖的是 **response 并发冲突**（AC1–AC4：在飞 response 状态跟踪 + 重放 `"Conversation already has an active response"`），不覆盖上游静默。
- `gap-voice-realtime-upstream-pool-rotation`（**done**）把 `UPSTREAM_STALLED` 当作**既有重连能力**引用（「断线重连逻辑已有（`UPSTREAM_STALLED` 处理）」），不是它修的缺陷。
- `gap-live-voice-caption-removal-on-shown`（ready）把 01:56 那次当作它 P3「关闭时刻的余波」的**时间线背景**，机制不同（它修 caption 移除时机）。
- `gap-live-voice-bounded-queue-refusal-visible`（ready）讲忙时有界排队与拒单可见；`gap-voice-realtime-empty-transcript-delivery-guard`（ready）讲空转写不得转发。两者都不碰上游静默。

**要做的事（先归因，再定形态，⛔ 本任务不预设结论）**：

1. **归因**：给出静默窗口内我方寄出/收到的帧逐条读数，判定静默发生在哪一侧（上游不回 vs 我方没在等/没在推）。
2. **定形态**：`UPSTREAM_STALLED` 之后该轮话语怎么收尾——有界等待后重发该轮 / 明确告知「没听到回答，可再说一次」/ 超时后换上游会话；把选择与理由写进 `## Resolution`。
3. **边界**：⛔ 不改上游（DashScope）行为、⛔ 不动 turn-detection 语义。若归因结论是「上游本就会偶发长静默，而产品形态已足够」，则本任务以**如实记录 + 标 won't-fix** 收口（同样算完成）。

## AC

- [ ] AC1 **归因读数**：给出 `01:56:22–01:56:53` 这 31 s 窗口内寄往上游（`>>`）与收到（`<<`）的帧逐条（或"零事件"的计数），据此判定静默在哪一侧；结论与证据写进本任务（⛔ 不许只写「疑似上游」）。
- [ ] AC2 **形态定死并落地**：在**可编排的假上游**（能"听到后静默 N 秒再回答"）下，`UPSTREAM_STALLED` 之后该轮话语的处置有**明确且可观测的归宿**（屏幕上出现明确状态 / 该轮被重发 / 明确告知用户），且该断言在**真实浏览器** e2e 上取真。
- [ ] AC3 **取假必红**：① 把注入静默设为 0（上游即时回答）⇒ AC2 的断言仍绿（证明它不是在测"上游慢"本身）；② 去掉处置逻辑 ⇒ AC2 红。逐条记录 diff、失败行与恢复命令。
- [ ] AC4 **真机基线对照**：把上面那条 31 s 的真实窗口作为对照基线记录——修复后同一形态（真上游静默）下用户可见结局不再是"没反应"；若上游不再复现该形态，如实记「未在真机复现，只有注入式证据」。
- [ ] AC5 **静态门**：`npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

真实读数：至少一条**注入式**（可编排静默）的端到端读数 + 对该轮话语归宿的明确断言；并记录 31 s 真实窗口作为对照基线。⛔ 只改错误文案、或只在单测里断言「抛了 UPSTREAM_STALLED」⇒ 不算达成（那正是今天的行为）。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
- server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- tasks/gap-live-voice-upstream-stall-no-answer.md

## Notes

- 判据来源：`gap-voice-realtime-microphone-human-smoke-test`（needs-human）在执行"检查最近若干次 live voice 使用记录"时发现的现场症状；该任务是人工走查项，本任务接管其中**可自动化**的那一半。
- 相邻但不同：`gap-live-voice-caption-removal-on-shown` 的 P3 处理的是「关闭时刻未上屏话语的留痕」，与本任务的「静默期话语归宿」是两条不同的可见性缺口，⛔ 不要合并。
