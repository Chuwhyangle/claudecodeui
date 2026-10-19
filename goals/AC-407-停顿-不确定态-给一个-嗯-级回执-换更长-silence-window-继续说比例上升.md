---
id: AC-407
title: 停顿「不确定态」给一个「嗯」级回执，换更长 silence window、继续说比例上升
status: draft
kind: criterion
goal: GOAL-047
criterion: bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json
  --import ./scripts/undici-blocked-ports-preload.mjs --test
  server/modules/voice-realtime/tests/voice-realtime-backchannel.test.ts
expect: 退出码 0（⚠️ 当前必红：测试文件不存在，且依赖
  semantic_vad「不确定态」能力验证——这是唯一未验证的能力假设）。前提：semantic_vad
  下能观测到「用户可能没说完」的中间态。停顿「不确定态」给一个「嗯」级回执（一字级），换取更长的 silence
  window；「继续说比例」上升。取假形态：把「不确定态」触发换成「每个停顿都回执」，必红（回执只在不确定态，不是每个 pause）。
origin: 本会话 2026-10-19 讨论产出；短信号换等待（一个「嗯」换数秒 silence
  window，非等长填充），回执只在「不确定态」这个临界点、不是每个停顿。
---
