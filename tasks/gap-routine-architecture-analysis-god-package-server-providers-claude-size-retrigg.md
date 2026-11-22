---
id: gap-routine-architecture-analysis-god-package-server-providers-claude-size-retrigg
title: "architecture-analysis: modules/providers/list/claude is 20 files / 53
  entities (fanIn 6, fanOut 361): the 2026-11-03 lifecycle split measured 19/49,
  then the G1 fix moved session-a"
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
modules/providers/list/claude is 20 files / 53 entities (fanIn 6, fanOut 361): the 2026-11-03 lifecycle split measured 19/49, then the G1 fix moved session-ai-title.service.ts (+1 file, +4 exported fns) in, so archguard's reasons include tooManyFiles + tooManyEntities again (minFiles 20, minEntities 50).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795348048786` · ts `2026-11-22T11:47:28.786Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`readSessionAiTitle`、`readTranscriptAiTitle`、`readTranscriptWindow`、`readAiTitleEntry`
- 涉及文件：
- `server/modules/providers/list/claude/session-ai-title.service.ts:241`
- `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts:19`
- `server/shared/tests/server-import-cycle-budget.test.ts:164`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Extract session-ai-title.service.ts into a new leaf subpackage server/modules/providers/list/claude/transcript/ (its only imports are node:fs and @/modules/database, so root -> transcript stays one-way and the G1 empty pin holds) restoring 19 files/49 entities, and register the new directory in GATE_DIRECTORY_PIN plus AC-394 MANIFEST_PIN/baseline in the same commit.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-22T11:47:28.786Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `god-package-server-providers-claude-size-retriggered`（routine `architecture-analysis`，runId `architecture-analysis-1795348048786`）所描述的问题被复核并处置
  - 处置：`git mv server/modules/providers/list/claude/session-ai-title.service.ts` 到新叶子子包 `server/modules/providers/list/claude/transcript/session-ai-title.service.ts`，三个导入点（providers 桶、`claude-session-synchronizer.provider.ts`、`claude-resident-lifecycle-outcome-handlers.ts`）同步改指。
  - 同一提交登记两份目录棘轮：`GATE_DIRECTORY_PIN` + `cloudpit-goal-exit-gate.baseline.json.moduleDirectories`（106→107）、AC-394 `MANIFEST_PIN` + `server-import-cycle-budget.baseline.json`（nodeCount 106→107）；`architecture-ratchet.baseline.json` 里旧路径的 `providerNameBranches` 条目按「只许下降」删除（该读数本就跳过 `modules/providers/list/`，旧值 1 实测为 0）。
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案
  - 实跑（worktree，2026-11-22）：`server/shared/tests/server-import-cycle-budget.test.ts` 14 pass（`sccs=[]`，manifest/leaf 臂绿）、`cloudpit-goal-exit-gate.test.ts` 3 pass、`architecture-ratchet.test.ts` 6 pass、`server/modules/providers/tests/session-ai-title.test.ts` 13 pass；`npm run typecheck`（root + server + scripts）全绿。
- L_G archguard: cycles=0 files=19 entities=49

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/providers/list/claude/session-ai-title.service.ts` (moved into the transcript leaf)
- `server/modules/providers/list/claude/transcript/session-ai-title.service.ts` (new)
- `server/modules/providers/index.ts`
- `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`
- `server/modules/providers/list/claude/claude-resident-lifecycle-outcome-handlers.ts`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `server/shared/tests/server-import-cycle-budget.baseline.json`
- `server/shared/tests/cloudpit-goal-exit-gate.test.ts`
- `server/shared/tests/cloudpit-goal-exit-gate.baseline.json`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `tasks/gap-routine-architecture-analysis-god-package-server-providers-claude-size-retrigg.md`
