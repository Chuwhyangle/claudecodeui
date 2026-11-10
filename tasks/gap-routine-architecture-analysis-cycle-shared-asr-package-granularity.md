---
id: gap-routine-architecture-analysis-cycle-shared-asr-package-granularity
title: "architecture-analysis: archguard package-granularity reading on the
  fresh 2026-11-10 tree: one non-trivial SCC of size 7 (asr + six asr/list/*
  adapter directories, 13 unique edges)"
status: done
labels:
  - gap
  - routine-filed
  - architecture-analysis
parent: null
children: []
extra: {}
---
## Finding
archguard package-granularity reading on the fresh 2026-11-10 tree: one non-trivial SCC of size 7 (asr + six asr/list/* adapter directories, 13 unique edges) because asrContract.ts/transcriptionWire.ts sit in the same node every adapter imports; the 2026-10-29 file-level split reports value-sccs=0 but no committed ratchet pins this directory reading, and the asr package is also at entityCount=50 (tooManyEntities, minEntities=50; fanIn 103/fanOut 68).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794314306935` · ts `2026-11-10T12:38:26.935Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`asrRegistry`、`asrContract`、`transcriptionWire`、`baseMimeType`、`classifyUpstreamFailure`
- 涉及文件：
- `shared/asr/asrRegistry.ts:20`
- `shared/asr/asrRegistry.ts:58`
- `shared/asr/asrContract.ts:1`
- `shared/asr/transcriptionWire.ts:1`
- `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts:89`
- `shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts:27`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Move asrContract.ts + transcriptionWire.ts together into a new leaf shared/asr/contract/ (they only share a type-only cycle) and re-export from asrRegistry.ts so consumers keep @shared/asr/asrRegistry; AC: archguard_detect_cycles(scope=shared, outputScope=package) reports 0 cycles (currently 1 SCC of size 7), asr entityCount<50, and node scripts/asr-import-cycle-check.mjs stays value-sccs=0.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-10T12:38:26.935Z

## 处置（处置结论可核：修掉）

**Before 复核（同一仪器、同一 scope 逐字复现 finding）。** 在隔离 worktree 上用 `archguard analyze -s shared --lang typescript -f json --no-cache` + `archguard query --scope shared --cycles --output-scope package` 读到：
`Cycle 1 (size 7): asr -> asr/list/dashscope-omni -> asr/list/dashscope-omni-relay -> asr/list/multimodal -> asr/list/openai-compatible -> asr/list/sensevoice-local -> asr/list/sensevoice-wasm`；`--package-stats 2` 读到 `asr: files=5, entities=50`。finding 的节点集逐字对齐。

**修复。** `asrContract.ts` 与 `transcriptionWire.ts` 整体搬进新叶子目录 `shared/asr/contract/`（保留二者之间的 type-only 互引；搬动前后文件级 value-SCC 均为 0）。`asrRegistry.ts` 从 `./contract/asrContract.js` 取值并 `export *` 再导出，消费者继续用 `@shared/asr/asrRegistry`；六个 `shared/asr/list/*` 适配器改从 `../../contract/…` 取值，其余消费者（src、server、experiments、测试、探针夹具）同步改到新路径。目录依赖从环变为单向：`asr → {contract, list/*}`、`list/* → contract`，contract 不 import 任何非 contract 模块。

**After 读数（同一仪器、同一 scope）。**
- `archguard query --scope shared --cycles --output-scope package` → `No directory-level dependency cycles detected.` ⇒ **cycles=0**（修前 1 个 size-7 SCC）。
- `archguard query --scope shared --package-stats 2` → `asr: files=3, entities=36`（**<50**，修前 50）、`asr/contract: files=2, entities=14`。
- `node scripts/asr-import-cycle-check.mjs` → `files=11 value-edges=21 type-edges=7 value-sccs=0 maxScc=0 verdict=PASS`。

**随文件迁移并实跑的路径敏感判据。** `node scripts/asr-dashscope-omni-check.mjs`、`node scripts/asr-contract-invariants-check.mjs`、两者的 `node --test`、`asr-single-implementation-check`（含 `--landing`，landing 增列 `shared/asr/contract`）、`asr-second-adapter-check`、`asr-mime-size-gaps-check`、`asr-health-provider-check`、`asr-cli-offline-check`、`asr-extraction-parity-check` 全部 exit 0；server `voice-error-classification.test.ts` 7/7、`.false-forms.test.ts` 7/7（含 AC7 子进程与 AC8 变异臂）；client 相关 5 个 spec 全绿；`npm run typecheck`（根 / server / scripts 三配置）与 `npx oxlint src/ server/ scripts/ shared/` exit 0；`architecture-ratchet.test.ts` 6/6 绿（新路径 786 行 < 800 硬线、无模块级可变状态）。

**如实登记的残余。** finding 提到「没有提交的棘轮钉住这个目录读数」；本条按 Requested action 只落地并记录 archguard 的 after 读数，未新增目录级棘轮（新增 server 测试文件会撞 quay 测试脚本 unknown pin / 时长基线）。文件级唯一性与环约束仍由既有 `scripts/asr-import-cycle-check.mjs` 及其测试持续判读。⛔ 不以「已注意到」结案。

## ADR-007 读数
- L_G archguard: cycles=0 maxScc=0
- L_G asr-package: entityCount=36 fileCount=3
- L_G file-level value-SCC: value_sccs=0 maxScc=0

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `cycle-shared-asr-package-granularity`（routine `architecture-analysis`，runId `architecture-analysis-1794314306935`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `shared/asr/asrRegistry.ts`
- `shared/asr/asrContract.ts`
- `shared/asr/transcriptionWire.ts`
- `shared/asr/contract/asrContract.ts`
- `shared/asr/contract/transcriptionWire.ts`
- `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`
- `shared/asr/list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.ts`
- `shared/asr/list/multimodal/multimodal.asr-provider.ts`
- `shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts`
- `shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.ts`
- `shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider.ts`
- `server/modules/voice/voice.service.ts`
- `server/modules/voice/tests/voice-error-classification.test.ts`
- `server/modules/voice/tests/voice-error-classification.false-forms.test.ts`
- `experiments/voice-asr-cli/dryRun.ts`
- `experiments/voice-asr-cli/offlineReplay.ts`
- `experiments/voice-asr-cli/transcribe.ts`
- `src/modules/chat-voice/hooks/useVoiceInput.ts`
- `src/modules/chat/tests/voiceClientAsrRouting.test.ts`
- `src/shared/api/index.ts`
- `src/shared/asr/tests/asrContractInvariants.test.ts`
- `src/shared/asr/tests/multimodalAdapter.test.ts`
- `src/shared/tests/voiceErrorClassification.test.ts`
- `src/shared/tests/voiceTrimShippedRecogniser.test.ts`
- `scripts/asr-cli-offline-check.mjs`
- `scripts/asr-contract-invariants-check.test.mjs`
- `scripts/asr-dashscope-omni-check.mjs`
- `scripts/asr-dashscope-omni-check.test.mjs`
- `scripts/asr-health-provider-check.mjs`
- `scripts/asr-mime-size-gaps-check.mjs`
- `scripts/asr-mime-size-gaps-check.test.mjs`
- `scripts/asr-second-adapter-check.test.mjs`
- `scripts/asr-single-implementation-check.mjs`
- `scripts/asr-single-implementation-check.test.mjs`
- `tasks/gap-routine-architecture-analysis-cycle-shared-asr-package-granularity.md`
