---
id: voice-output-spec-announce-summary-gap
title: E0 充分性缺口：spec 补 announce/总结自动输出断言（核心接线已落地 f18c966ee）
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-403
---
## Proposal

E0 端到端 harness 已跑通（4 passed / exit 0），但它只验证了「链路骨架」——采集→relay→转交→**手动点 Read aloud** 的 TTS stand-in。它**没有**验证「relay/narrator 自动产出的语音输出」，而这才是 GOAL-047 的核心（语音输出 = 信心层）。

充分性缺口分两块：

**A. spec 补 announce/总结自动输出断言（核心接线已落地 commit f18c966ee）**

announce 文本的接线已完成：`bridge.onFollowUpText` → ws-proxy announce 门 → narrator 队列 → `narrator_speak`（单测 `voice-realtime-announce-narrator.test.ts` 2/2 绿）。但 spec 里还没有「relay 自动说开始确认」和「run 结束自动总结」的 e2e 断言。待补三件事：

1. `e2e/voiceRealtimeScriptedUpstream.ts` 加 follow-up text 模拟：session_send 后回 `response.created`（带 id）+ `response.text.done`（带 response_id + text），并在转交后授予 follow-up credit（对应 `notifySynthesizedToolResume`）。
2. `experiments/voice-e2e-harness/run.mjs` 把 `VOICE_REALTIME_CLOSING_TURN=announce` 传进 webServer 的 env（服务器进程读它解析 closing turn）。
3. spec 断言：转交后 `__voiceFrames` 收到 `narrator_speak`（开始确认文本）；构造 run 结束（busy: false）后 `__voiceFrames` 收到 `narrator_speak`（总结文本，stand-in summarizer 返回 ≤40 字）。

**B. 其余充分性缺口（本 task 明确不做，另立或挂起）**

- 真实 TTS 端到端：spec 的 TTS 是 `page.route` 假 WAV stand-in，真实 cosyvoice 合成（AC-405 单测覆盖）没串成真链。
- backchannel 真链：AC-407 的「继续说比例」KPI 未真机统计（T6 只做了能力验证 + 回退机制）。
- 多样本：只跑了 1/5 样本（402fad85），其余 4 个样本未在 e2e 里跑。

## AC

- [ ] 转交后（announce 模式）`__voiceFrames` 收到 `narrator_speak`，text 是 ≤15 字的开始确认、非「OK」。
- [ ] run 结束后 `__voiceFrames` 收到 `narrator_speak`，text 是 ≤40 字、无 Markdown 的总结。

## DoD

`node experiments/voice-e2e-harness/run.mjs --sample 402fad85` 在 announce 模式下跑通，新增两条断言绿；`npm run typecheck` 退出 0。B 部分（真实 TTS / backchannel / 多样本）不在本 task，明确记为边界。

## Touches

- e2e/voice-output-e2e-harness.spec.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- experiments/voice-e2e-harness/run.mjs
- playwright.config.ts
- tasks/voice-output-spec-announce-summary-gap.md