---
id: AC-404
title: run 结束触发 narrator 产出 ≤40 字、无 Markdown、不复述原文的结束小结
status: draft
kind: criterion
goal: GOAL-047
criterion: bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json
  --import ./scripts/undici-blocked-ports-preload.mjs --test
  server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts
expect: 退出码 0（⚠️ 当前必红：测试文件不存在）。用 scripted bridge + 假时钟驱动 ws-proxy：execStatus 从
  running→idle 的 transition 触发恰好一次总结注入（response.create 或 session.update
  携带总结指令）；给定一段 Claude Code 输出，产出的总结 ≤40 字、无 Markdown（# * ` |
  不出现）、verbatimTail≈0（不复述原文尾句）。取假形态：(a) 删掉 transition 触发，必红；(b) 本来就没 run 的
  idle（无 runId 的初始 idle）不触发——断言不发出总结注入，若发出必红。
origin: 本会话 2026-10-19 讨论产出；生成质量已由 B-1
  探针验证（experiments/voice-realtime-announce-summary/summarize.mts，qwen3.8-omni-flash
  产出 32–41 字小结、无 Markdown、verbatimTail≈0）。
---
