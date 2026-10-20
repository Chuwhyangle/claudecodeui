---
id: gap-voice-run-end-summary-side-model
title: run-end 总结接真旁路文本模型：VOICE_REALTIME_SUMMARY_MODEL 装配 qwen3.8-omni-flash 生成
  ≤40 字小结，替换 stand-in 固定文案
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

补上 run-end 总结「旁路文本模型」这半边：把文本源从固定 stand-in 换成真旁路文本模型，relay 仍只当「笔」不兼职总结员。

现状：`buildVoiceRealtimeNarratorWiring` 里 `runEndSummary.summarize` 就是 `async () => summaryStandin`（固定文案），真模型未接。B-1 探针（experiments/voice-realtime-announce-summary/summarize.mts）已验证 `qwen3.8-omni-flash`（realtime 的 HTTP 孪生）能把真实输出缩成 ≤40 字口语小结，`voice` prompt 现成可用。

三处改动：
1. 新叶子 `server/modules/voice-realtime/voice-realtime-summary.ts`：`createVoiceRealtimeRunEndSummarizer(options)` 返回 `summarize({context,runId})`，POST DashScope compatible-mode `chat/completions`，body `{model:'qwen3.8-omni-flash', modalities:['text'], stream:false, messages:[…]}`，prompt 原样搬 B-1 `voice` 变体；返回 `choices[0].message.content.trim()`，空/非 2xx/异常 → null。options `{apiKey(必填,空则不发请求直接 null), model?, baseUrl?, timeoutMs?(默认 60s), fetch?(测试缝)}`。不读 env、纯 seam、只从 barrel 导出，照 `voice-realtime-tts-local.ts` 模式。
2. `buildVoiceRealtimeNarratorWiring` 签名：`summaryStandin: string | null` → `summarizeRunEnd: ((input:{context,runId}) => Promise<string|null>) | null`；`inject` 半边不动。stand-in 与真模型是同一 seam 的两个实现，proxy 无感。
3. `server/index.ts` 装配点新增 `VOICE_REALTIME_SUMMARY_MODEL`（默认不设=关）：设了 → 真叶子（key 用现成 `liveVoiceDashscopeApiKey`，与 realtime/TTS 同一把）；没设但设了 `VOICE_REALTIME_SUMMARY_STANDIN` → 固定文案（向后兼容）；都没设 → 无 runEndSummary。装配时 log 一行命名来源。

<!-- dedup-ref --> 与 `voice-output-run-end-summary`（已 done，含触发/注入/stand-in）的关系：本任务补它 Proposal 声称但未接的真模型生成半边，独立交付。

## AC

- [x] `npx vitest run server/modules/voice-realtime/tests/voice-realtime-summary.test.ts` 退出 0，钉住叶子契约：200 → trim 文本；空 content → null；非 2xx → null；空 apiKey → null 且 fetch 未被调；请求体 model=qwen3.8-omni-flash 且 prompt 含「不超过 40 字」。
- [x] `npx vitest run server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts` 退出 0（`buildVoiceRealtimeNarratorWiring` 改签名后 stand-in 臂仍绿）。
- [x] `grep -q "VOICE_REALTIME_SUMMARY_MODEL" server/index.ts` 且 `grep -q "createVoiceRealtimeRunEndSummarizer" server/index.ts` 均退出 0（装配点引用新 env 与真叶子）。
- [x] 新测试文件登记：`server/shared/tests/quay-test-script.test.ts` unknown pin +1、`scripts/suite-duration-baseline.tsv` 增 `voice-realtime-summary.test.ts` 行；`npx vitest run server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] `npm run typecheck` 退出 0；`npm run build:server` 退出 0。

## DoD

`server/modules/voice-realtime/voice-realtime-summary.ts` 落地并经 barrel 导出；`server/index.ts` 在 `VOICE_REALTIME_SUMMARY_MODEL` 设值时用真叶子装配 run-end 总结（key 取 `liveVoiceDashscopeApiKey`），不设值时行为与今天一致（stand-in 或无总结）。叶子单测绿、现有 run-end-summary 测试仍绿、typecheck + build:server 退出 0、quay-test-script pin 与 suite-duration-baseline 已登记新测试文件。真实 DashScope 出声属 H1 人工验收门，不在本任务 DoD 内。

## Notes

运行器更正（与 `tasks/gap-voice-sensevoice-server-adapter.md` 等记录的是同一处不符）：`vitest.config.ts` 的 `include` 只有 `src/**/*.test.ts(x)`，把 `server/...` 路径交给 `npx vitest run` 会以 `No test files found` 退出 1——这不是用例失败。本仓库服务端测试的规范 runner 是 `npx tsx --tsconfig server/tsconfig.json --test <file>`。AC1/AC2/AC4 三条均按规范 runner 实测：叶子 5 pass / 0 fail、run-end-summary 4 pass / 0 fail、quay-test-script 14 pass / 0 fail。

## Touches

- server/modules/voice-realtime/voice-realtime-summary.ts
- server/modules/voice-realtime/voice-realtime-narrator.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-summary.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-run-end-summary-side-model.md

## Blocker

**2026-10-20T00:10:19.477Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts:   AssertionError [ERR_ASSERTION]: a title offered after adoption reaches the ladder — a launch hands the CLI a title and the CLI writes it down (customTitles=["AC171 Title 28748f52"]) [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts,server/shared/tests/server-import-cycle-budget.test.ts,server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts]
- run_id：wk-prod-anchor
- session_id：530d2a52-2ea4-4802-b563-c1cf52f9cebc
