---
id: voice-output-announce-start-confirmation
title: 占位确认 announce 模式：实现已完成待落地（commit + merge + build）
status: done
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-403
---
## Proposal

announce 模式已实现并落地：`closingTurn` 加 `announce` 枚举（默认仍 `silent`，`VOICE_REALTIME_CLOSING_TURN=announce` 打开，可回滚可 A/B）。转交 `session_send` 后，realtime 模型说一句 ≤15 字的开始确认（「好的，我来查 X」），非 OK、非复述原话、不念输出——语音「信心层」的第一块（快响应）。

改动：`voice-realtime-closing-turn.ts`（announce 枚举 + resolver + acceptedResultTail）、`voice-realtime-ws-proxy.service.ts`（voiceRealtimeInstructionsFor 加 announce 例外句）、`server/index.ts`（respondToToolOutputs 对 announce 为真）、`voice-realtime-closing-turn.test.ts`（4 个 announce 断言）。已 commit `93432146b` 并 merge 进 develop；后续 announce → narrator 接线与 e2e 断言由 `voice-output-spec-announce-summary-gap`（done）落地。

证据：离线 20/20 绿 + typecheck 过；真机 replay（P1 窗口，¥0.02）转交后模型说「好的，我来查找 quay 最活跃的会话」（9 字、非 OK、非复述）。

## AC

- [x] AC-403 的 criterion 测试 `voice-realtime-closing-turn.test.ts` 退出 0（已实测 20/20 绿）。

## DoD

announce 代码 commit 并 merge 到 develop；`npm run typecheck` 与 `npm run lint` 退出 0；AC-403 的 criterion 测试退出 0。

## Touches

- server/modules/voice-realtime/voice-realtime-closing-turn.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-closing-turn.test.ts
- experiments/voice-realtime-closing-turn/run.mts
- experiments/voice-realtime-announce-summary/summarize.mts
- experiments/voice-realtime-announce-summary/fixtures/real-claude-output.json
- tasks/voice-output-announce-start-confirmation.md