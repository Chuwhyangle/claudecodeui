---
id: AC-401
title: ws-proxy 以遗漏补发取代 settle producer 的丢话兜底，并关闭 interrupt_response
status: achieved
kind: criterion
goal: GOAL-046
criterion: bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json
  --test
  server/modules/voice-realtime/tests/voice-realtime-omission-fill-wiring.test.ts
expect: 退出码 0，测试文件存在。用脚本化 bridge 与假时钟驱动 ws-proxy，断言：(a) 一句 ≥7
  字的转写被后续模型消息覆盖时，2500ms（原 settle 时刻）过后不再有识别原文投递；(b) 一句 ≥7 字的转写始终未被覆盖时，在 T_i
  恰好投递一次识别原文，连接日志写入一条含 {i, T_i, coverage, reason} 的 omission_fill
  记录，被放过的候选也写入放过原因；(c) 同一时刻到期的多条按时间顺序合成一条投递；(d) 发给上游的 session.update 的
  turn_detection 带 interrupt_response:false；(e) MODEL_TEXT_REPLY
  逐字分支、忙等待与合并投递的既有行为不变（既有测试文件 voice-realtime-ws-proxy*.test.ts 中与之相关的用例仍全绿，本 AC
  只新增，不改写其断言）。取假形态：恢复 settle 触发，(a) 必须变红；删去 omission_fill 日志写入，(b) 必须变红。⚠️
  当前必红：测试文件不存在。
origin: 人 yale 2026-10-18 裁定：取代 settle producer
  的兜底触发，不叠加；interrupt_response:false 在探针里把取消从 8/24 降到 0/30（BN
  臂接线缺陷，仅取消计数可用），一行改动。
activatedAt: 2026-10-18T08:36:44.456Z
statusLog:
  - at: 2026-10-18T08:36:44.456Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-18T09:57:37.190Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-18T08:36:44.456Z
---
