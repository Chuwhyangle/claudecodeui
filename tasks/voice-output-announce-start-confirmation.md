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

announce 模式已在本会话实现完毕（代码 + 测试 + 真机验证），本 task 记录该工作并收尾落地。机制：`closingTurn` 加 `announce` 枚举（默认仍 `silent`，`VOICE_REALTIME_CLOSING_TURN=announce` 打开，可回滚可 A/B）。转交 `session_send` 后，realtime 模型说一句 ≤15 字的开始确认（「好的，我来查 X」），非 OK、非复述原话、不念输出——这是语音「信心层」的第一块（快响应）。

改动已落在工作区：`voice-realtime-closing-turn.ts`（announce 枚举 + resolver + acceptedResultTail）、`voice-realtime-ws-proxy.service.ts`（voiceRealtimeInstructionsFor 加 announce 例外句）、`server/index.ts`（respondToToolOutputs 对 announce 为真）、`voice-realtime-closing-turn.test.ts`（4 个 announce 断言）。

证据：离线 20/20 绿 + typecheck 过；真机 replay（P1 窗口，¥0.02）转交后模型说「好的，我来查找 quay 最活跃的会话」（9 字、非 OK、非复述），打断后说「已为您终止当前操作」（打断话术待后续调优，见 GOAL-047 范围）。

剩余动作：commit + merge + `npm run build:server`（fan-in 前落地）。announce 的打断后话术调优不在本 task（归 GOAL-047 后续）。

## AC

- [ ] AC-403 的 criterion 测试 `voice-realtime-closing-turn.test.ts` 退出 0（已 20/20 绿，落地后复跑确认）。

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
## Needs-Human

**执行 2026-10-19T00:08:33.366Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：unsatisfiableUnannotatedAc=[AC-403 的 criterion 测试 `voice-realtime-closing-turn.test.ts` 退出 0（已 20/20 绿，落地后复跑确认）。]（连续 3 轮被结构上不可派的拦截挡住 ⇒ 作者/人改写；⛔ 不派 fix worker）
