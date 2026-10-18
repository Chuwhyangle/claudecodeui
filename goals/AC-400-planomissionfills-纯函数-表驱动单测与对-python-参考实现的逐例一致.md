---
id: AC-400
title: planOmissionFills 纯函数：表驱动单测与对 Python 参考实现的逐例一致
status: active
kind: criterion
goal: GOAL-046
criterion: bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json
  --test
  server/modules/voice-realtime/tests/voice-realtime-omission-fill.test.ts
expect: 退出码 0，测试文件存在且至少含两组用例。其一，表驱动：纯中文、纯英文、中英混说、含数字、消息被译成另一种文字、文字不符的识别幻觉、被取消的
  response 里的调用（不是已执行消息）、空窗口、边界值（权重 6/7、覆盖度 0.24/0.25、t+H）。其二，一致性：读
  experiments/voice-relay-qb/fixtures/omission-fill-cases.json（由 replay_rule.py
  生成：若干连接的转写序列、已执行消息序列、参数、期望补发下标），对每个用例 TS 实现的补发下标与 Python 参考实现逐例完全相同，用例数 ≥
  40。取假形态：把覆盖度比较改成 >，或让取消的 response 里的调用也算已执行，对应用例必须变红。⚠️ 当前必红：模块、测试与夹具均不存在。
origin: SPEC
  docs/proposals/voice-realtime-omission-fill-SPEC.md「测试」一节。规则有两份实现（回放用
  Python，服务端用 TS），一致性夹具是防止它们漂移的唯一手段；2026-10-18 的回放读数全部来自 Python 实现。
activatedAt: 2026-10-18T08:36:44.015Z
statusLog:
  - at: 2026-10-18T08:36:44.015Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-18T08:36:44.015Z
---
