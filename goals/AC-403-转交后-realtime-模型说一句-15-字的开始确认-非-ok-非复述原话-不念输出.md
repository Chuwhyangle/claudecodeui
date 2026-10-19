---
id: AC-403
title: 转交后 realtime 模型说一句 ≤15 字的开始确认：非 OK、非复述原话、不念输出
status: active
kind: criterion
goal: GOAL-047
criterion: bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json
  --import ./scripts/undici-blocked-ports-preload.mjs --test
  server/modules/voice-realtime/tests/voice-realtime-closing-turn.test.ts
expect: 退出码 0。announce closing-turn 的四个断言存在且绿：(a)
  `resolveVoiceRealtimeClosingTurn({VOICE_REALTIME_CLOSING_TURN_ENV:'announce'})`
  deepEqual `{closingTurn:'announce', invalid:null}`；(b)
  `voiceRealtimeInstructionsFor('announce')` = silent prompt 加一句「One more
  exception to the no-reply rule」例外，含 "Then say nothing more."、不含 "single word
  OK"，且 `announce.replace(' '+added, '')` 逐字等于 silent prompt（nothing else
  moved）；(c) `acceptedResultTail('announce')` 的 tool result 含 "Say ONE short
  sentence"、含 "never read Claude Code"、含 "Do not call session_send again"
  循环守卫、不含 "say nothing and wait"。取假形态：删掉 announce 的 instructions 例外句，(b) 必红。
origin: 本会话 2026-10-19 讨论产出；announce 枚举已落地（voice-realtime-closing-turn.ts /
  voice-realtime-ws-proxy.service.ts / server/index.ts）并离线 20/20 绿 + typecheck
  过；真机 replay（P1 窗口，¥0.02）转交后模型说「好的，我来查找 quay 最活跃的会话」。
activatedAt: 2026-10-19T00:27:03.411Z
statusLog:
  - at: 2026-10-19T00:27:03.411Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-19T00:27:03.411Z
---
