---
id: gap-live-voice-realtime-asr-caption-transcript
title: 实时 ASR interim/final caption 作为用户消息展示（AC-317，依赖 AC-316，暂未实现）
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-live-voice-exclusive-mode-fixed-bar
goal_ac: AC-317
---
## Proposal

草案任务，依赖 `gap-live-voice-exclusive-mode-fixed-bar`（AC-316）先落地。范围与设计讨论见 AC-317 自身记录（`goals/AC-317-*.md`）与 2026-10-09 之前的设计讨论回合。

核心工作量：
1. `voice-realtime-dashscope-transport.ts` 新增 `conversation.item.input_audio_transcription.delta`/`.completed` 的 wire→bridge 事件映射（真实字段形状已用 `experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json` 核实：delta 的累计文本在 `stash` 字段，`text` 恒为空；completed 的最终文本在 `transcript` 字段）。
2. `voice-realtime-bridge.service.ts` 新增 dispatch 分支与 hook，不再把这两种事件误判为 `UNKNOWN_EVENT`。
3. `voice-realtime-ws-proxy.service.ts` 新增 outbound `caption` 帧。
4. 前端 transcript 渲染新增 provisional→final 的用户消息气泡，按 `item_id` 去重排序。
5. 新增不变量测试：caption 文本不得流入 `session_send` 的 `message` 参数。

## 边界/不做

不在本任务重新设计 AC-316 已经定下的互斥模式/固定栏/Mute 语义；只在其基础上加一条新的展示通道。

## AC

依 AC-317 自身 criterion 激活时最终确定；本任务创建时 AC-317 仍为 `draft`，不构成阻塞。

## DoD

待 AC-317 从 draft 激活为 active 并细化判据后再推进实现；本任务当前仅做范围占位，防止遗忘，不计入 GOAL-033 本轮交付。

## Touches

- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- transcript 渲染相关文件（实现时勘察确定）
- tasks/gap-live-voice-realtime-asr-caption-transcript.md（self）
