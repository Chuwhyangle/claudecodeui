---
id: AC-311
title: Realtime WS 重连与 response 并发韧性：真实撞过的竞态有具名状态机与回归证据
status: achieved
kind: criterion
goal: GOAL-031
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
expect: bridge/transport 新增一个显式的"当前是否有未完成
  response"状态跟踪；断连后能重连并继续同一逻辑会话（不重复、不丢已经发出但未回填的 `function_call_output`）。对
  GOAL-030 Task A 真实读到的 `"Conversation already has an active response"`
  错误帧，新代码路径必须吸收它（不让整条连接因此失败/崩溃）——**用已有的真实轨迹重放验证**（`experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json`
  里那条错误帧），不要求为本 AC 重新花钱连真实端点。取假变体：去掉这层状态机 ⇒ 重放同一条真实轨迹必须红在那个错误帧上。
origin: GOAL-030 Task
  A（`gap-voice-realtime-dashscope-transport-harness`）完成记录里真实读到的并发错误帧；本 AC
  要求复用已有真实证据而不是新花钱验证。
activatedAt: 2026-10-09T02:13:49.522Z
statusLog:
  - at: 2026-10-09T02:13:49.522Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-09T04:20:07.608Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-09T02:13:49.522Z
---
