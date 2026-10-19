---
id: voice-output-run-end-summary
title: 结束总结触发闭环：run 结束 → narrator 产出 ≤40 字小结（文本层）
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-404
---
## Proposal

实现 run 结束触发 narrator 产出结束小结（文本层先闭环，不接 TTS）。机制：ws-proxy 里 `execStatus` 从 running→idle 的 transition 触发恰好一次总结注入。总结由旁路文本模型生成（qwen3.8-omni-flash HTTP 兼容模式，B-1 探针已验证质量），relay 保持「笔」不兼职总结员。产出 ≤40 字、无 Markdown、不复述原文。

关键边界：run-end 那一刻 context pack 未必已含最新输出，narrator 生成前需一个短暂的 settle 等待（输出落定再生成），这是异步机制最易翻车的 timing 点，必须验。

生成质量读数复用 `experiments/voice-realtime-announce-summary/summarize.mts` 的 readings（chars ≤40、markdown 空、verbatimTail≈0）。

## AC

- [x] AC-404：scripted bridge + 假时钟驱动 ws-proxy，running→idle 触发恰好一次总结注入；≤40 字、无 Markdown、verbatimTail≈0；删 transition 必红、初始 idle 不触发。

## DoD

`server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts` 落地并绿；AC-404 转绿；`npm run typecheck` 退出 0。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/voice-output-run-end-summary.md

## Blocker

**2026-10-19T00:26:32.798Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=75774 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792369258305
- run_id：wk-prod-anchor
- session_id：236fc4b2-26c1-4332-9a8b-0da4e8fe68ef
