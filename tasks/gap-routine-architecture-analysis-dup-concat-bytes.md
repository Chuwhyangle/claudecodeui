---
id: gap-routine-architecture-analysis-dup-concat-bytes
title: "architecture-analysis: archguard duplicate group 816ec1a3b49021eb: 8
  statements / 85 tokens / 8 savable lines — one Uint8Array merge helper
  implemented on both server and client, s"
status: ready
labels:
  - gap
  - routine-filed
  - architecture-analysis
parent: null
children: []
extra: {}
---
## Finding
archguard duplicate group 816ec1a3b49021eb: 8 statements / 85 tokens / 8 savable lines — one Uint8Array merge helper implemented on both server and client, still byte-identical at HEAD develop 56d1bfe9b (recurrence of finding dup-concat-bytes, reported 2026-11-07 and never filed by the rate gate).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794746479180` · ts `2026-11-15T12:41:19.180Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`concatBytes`、`concatNarratorBytes`
- 涉及文件：
- `server/modules/voice-realtime/voice-realtime-tts.ts:614`
- `src/modules/chat-voice/voice-realtime/narratorWav.ts:87`
- kind：`duplication`
- verdict：`confirmed`

## Requested action
Move the single implementation into the repo-root shared byte module (shared/asr/transcriptionWire.ts already owns byte arithmetic) and import from voice-realtime-tts.ts and narratorWav.ts; AC: one declaration of the helper, archguard_detect_duplicates no longer reports group 816ec1a3b49021eb, and the voice-realtime TTS and narrator-WAV tests stay green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-15T12:41:19.180Z

## 处置结论
处置：**修掉**。finding 记录的两处字节合并实现已收敛为唯一的声明：

- 唯一实现：`shared/asr/contract/transcriptionWire.ts` 导出 `concatBytes`（repo-root 共享字节模块；该 finding 正文里写作 `shared/asr/transcriptionWire.ts`，实际落地路径是它 2026-11-10 拆分后的 `shared/asr/contract/transcriptionWire.ts`）。
- 两个原站点改为消费：`server/modules/voice-realtime/voice-realtime-tts.ts` 经 `@shared/asr/contract/transcriptionWire.js` 导入（走 `@shared/…` 别名而非相对说明符，因此 AC-394 的 unresolved-internal 预算不增）；`src/modules/chat-voice/voice-realtime/narratorWav.ts` 一行 `export { concatBytes as concatNarratorBytes }` 再导出别名，保住 `useVoiceRealtimeSession` 的既有导入名，本身不定义任何实现。
- 行为等价：函数体逐字搬移（含两个空输入短路），调用点一行未改。
- 不属该组：`src/modules/chat-voice/hooks/useVoiceInput.ts` 的同名 `concatBytes(chunks: Uint8Array[])` 是数组归并、不同函数体，archguard 不报，保持原样。

实跑读数（worktree `gap-routine-architecture-analysis-dup-concat-bytes`，提交 `5f486c46b`）：

- 唯一声明：`grep -rn "function concat[A-Za-z]*Bytes(head: Uint8Array, tail: Uint8Array)" server src shared --include=*.ts` → 1 处（`shared/asr/contract/transcriptionWire.ts:342`）；实现体标记 `grep -rn "merged.set(tail, head.length)" server src shared --include=*.ts` → 1 处。
- archguard `detect_duplicates` A/B（runtime 0.1.45，sources=src,server,shared，minStatements=6 / minTokens=50，直接调 `detectDuplicates`，未写 `.archguard`）：
  - develop（`fceecde08`）：groupCount=2，`hash816Present=true`，命中组成员逐字为 `server/modules/voice-realtime/voice-realtime-tts.ts:614-621 concatBytes` 与 `src/modules/chat-voice/voice-realtime/narratorWav.ts:87-94 concatNarratorBytes` — 与 finding 载体记录一致（缺陷先复现）。
  - 修复后的 worktree：groupCount=1，`hash816Present=false`，无任何组的成员命中这两个文件。
- 测试实跑：
  - `TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/voice-realtime/tests/voice-realtime-tts.test.ts server/modules/voice-realtime/tests/voice-realtime-tts-stream.test.ts` → tests 14 / pass 14 / fail 0。
  - `npx vitest run src/modules/chat/voice-realtime/tests/voiceRealtimeNarratorStream.test.tsx` → Test Files 1 passed，Tests 2 passed。
  - `node --test scripts/asr-single-implementation-check.test.mjs scripts/asr-second-adapter-check.test.mjs scripts/asr-dashscope-omni-check.test.mjs scripts/asr-cli-offline-check.test.mjs scripts/asr-contract-invariants-check.test.mjs` → tests 52 / pass 52 / fail 0；`node scripts/asr-single-implementation-check.mjs --landing` 仍报 `SECOND_IMPL none`，server 消费组新增站点 `voice-realtime-tts.ts:42`。
  - `npm run typecheck`（三个 tsc 工程）→ 退出 0；`npx oxlint` 三个改动文件 → 无输出。
  - `server/shared/tests/architecture-ratchet.test.ts` → 6/6 pass（该文件 376 行，未触 800 行线）；`server/shared/tests/server-import-cycle-budget.test.ts`（AC-394）→ 12/12 pass，含未解析内部导入预算与目录清单叶子规则。
- DoD 第 2 条：产出者与修复均由派发链的本 worker 执行，例程只写 finding 与任务，未代跑修复。

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `dup-concat-bytes`（routine `architecture-analysis`，runId `architecture-analysis-1794746479180`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过：唯一声明 1 处、archguard 组 816ec1a3b49021eb 前后 A/B 复扫消失、TTS 14/14 与 narrator-WAV 2/2 全绿（读数见「处置结论」）
- [x] ⛔ 探针只立案不执行：本任务需要跑的产出者/修复由派发链执行，例程未代跑

## ADR-007 暗轴记录
- L_G archguard: duplicateGroups=1 (develop 对照 duplicateGroups=2；组 816ec1a3b49021eb 已消失); targetGroups=0; sources=src,server,shared; minStatements=6; minTokens=50; runtime=0.1.45
- 该轴仍暗,理由:L_D 只把两处重复的字节合并收敛为单一定义，不改变文档/代码线比例，没有可分离的读数。

## Touches
- `server/modules/voice-realtime/voice-realtime-tts.ts`
- `src/modules/chat-voice/voice-realtime/narratorWav.ts`
- `shared/asr/contract/transcriptionWire.ts`
- `tasks/gap-routine-architecture-analysis-dup-concat-bytes.md`
