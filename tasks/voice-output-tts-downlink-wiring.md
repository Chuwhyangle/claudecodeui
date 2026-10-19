---
id: voice-output-tts-downlink-wiring
title: TTS 音频下行接线：narrator 文本 → cosyvoice 合成 → tts_audio 帧 → 浏览器播放（含 Voice 分 tab）
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-408
---
## Proposal

让 Live Voice 的语音输出「真的出声」：narrator 队列的每句文本（announce 开始确认、run-end 总结）经 cosyvoice TTS 合成，逐帧 `tts_audio` 下发，浏览器拼接解码播放，播完回 `narrator_done` 推进队列。这是 GOAL-047 北极星「跑通完整典型场景」的最后一块——此前 narrator 只发文本帧、前端收到即 return，TTS leaf（`voice-realtime-tts.ts`）是孤儿。

分四块：

**A. 服务端接线（TTS leaf → narrator 队列）**
1. barrel `voice-realtime/index.ts` 导出 TTS leaf（`speakVoiceRealtimeText` / `VoiceRealtimeTtsOptions` / `VoiceRealtimeTtsFrame`）。
2. narrator 队列 `pump()`：每句文本送进 `speakVoiceRealtimeText({ utteranceId, text }, options, downlink)`，downlink 经同一条 WS 下发 `tts_audio`（按 seq）/ `tts_done` / `tts_error`。`narrator_speak` 文本帧保留为「前端显示的播报文案 + fallback」。
3. `server/index.ts` 组合根：构造 TTS leaf，`apiKey = readVoiceSettings(userId).liveVoiceDashscopeApiKey`（与 realtime 共用，DashScope 账户级 key），`voice = 默认音色`；避开 `MASKED_API_KEY` 占位符（掩码/空时合成直接 `tts_error`，不带错 key 拨号）。

**B. 前端播放**
4. `useVoiceRealtimeSession` 声明并处理三类帧：`tts_audio`（按 `seq` 拼 base64）、`tts_done`（解码 WAV + 播放 + 播完回 `narrator_done`）、`tts_error`（显示）；`narrator_stop` 立即停播并清拼接缓冲。复用 `voicePlayer` 的 `<audio>` 播放能力或新增一个 Live Voice 播报播放器。

**C. Voice 设置分 tab**
5. `VoiceSettingsTab` 分「Voice Input / Live Voice」两个子 tab（复用 Agents 的 `role=tablist` 样式）。Voice Input = 现有内容；Live Voice = `liveVoiceDashscopeApiKey`（首轮只放 key，endpoint/model/voice 用后端默认）。

**D. MCP 浏览器真实验证**
6. agent 用 `mcp__playwright__*` 工具连生产 :3001（真实 DashScope），进 Live Voice，注入假 `getUserMedia`（复用 E0 wavMic 思路）喂冻结 wav，观察真转写 + 真 TTS 出声，耳闻 announce + 总结。

## AC

- [x] AC-408：`node experiments/voice-e2e-harness/run.mjs --sample 402fad85` 退出 0（scripted relay + scripted TTS stand-in）：announce/总结文本经 TTS 合成，`tts_audio` 帧按 seq 到达浏览器、`tts_done` bytes 正确、播放后 `narrator_done` 推进下一句。

## DoD

- AC-408 转绿（suite scripted 端到端）。
- `npm run typecheck` 退出 0。
- D 块人工确认：MCP 浏览器真实连 DashScope，跑一次完整交互，耳闻 announce + 总结出声（真实 ¥，仅一次）。

## Touches

- server/modules/voice-realtime/voice-realtime-tts.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/index.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- e2e/voice-output-e2e-harness.spec.ts
- experiments/voice-e2e-harness/run.mjs
- tasks/voice-output-tts-downlink-wiring.md