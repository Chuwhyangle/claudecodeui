---
id: AC-317
title: 实时 ASR interim/final transcript 作为用户消息展示，不混入模型推理输入（依赖 AC-316，本轮暂未实现）
status: draft
kind: criterion
goal: GOAL-033
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
  -t caption
expect: |-
  （草案，激活时需细化为可执行判据）DashScope Realtime 端点已真实验证会发出 `conversation.item.input_audio_transcription.delta`（累计文本在 `stash` 字段，`text` 字段为空）与 `.completed`（最终文本在 `transcript` 字段），按 `item_id` 分组——见
  `experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json`。本条要求：

  1. `voice-realtime-dashscope-transport.ts`/`voice-realtime-bridge.service.ts` 新增对这两种事件的映射，不再落入 `UNKNOWN_EVENT`。
  2. 代理新增一种 outbound 帧（如 `caption`），携带 `itemId`/`text`/`final`，与 `sent`/`error`/`state` 并列，和 `session_send` 的参数来源（模型 function_call 的 `message` 字段）结构上互不相通——需要一条专门的不变量测试：caption 的文本不得出现在任何 `session_send` 调用的参数里。
  3. 前端把 caption 渲染成一条"临时态→最终态"的用户消息（复用既有乐观本地回显模式，具体组件留给实现时勘察），按 `item_id` 去重、按到达顺序排列，不得因网络重排/重复 `delta` 产生重复气泡或乱序。
  4. PC/移动都要能看到这条消息的渲染。

  取假形态（草案）：把 caption 事件路由到 `session_send` 的消息参数 ⇒ 不变量测试必须红；去掉 `item_id` 去重 ⇒ 重复气泡可被构造出来。

  本条目前是草案，依赖 AC-316 落地后再激活与细化；不在 GOAL-033 的本轮交付范围内。
origin: 2026-10-09 人 yale 正式批准 GOAL-033 时要求的完整范围之一；因后端协议事件映射 + transcript
  渲染改动复杂度与回归面独立于 AC-316，拆成单独任务，依赖 AC-316 先落地。
---
