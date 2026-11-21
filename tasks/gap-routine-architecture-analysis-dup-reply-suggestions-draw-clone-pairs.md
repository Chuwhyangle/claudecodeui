---
id: gap-routine-architecture-analysis-dup-reply-suggestions-draw-clone-pairs
title: "architecture-analysis: archguard_detect_duplicates (minStatements 6 /
  minTokens 50, tests excluded) reports totalGroups=2 for scope server and both
  sit in this file: logCompletion "
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
archguard_detect_duplicates (minStatements 6 / minTokens 50, tests excluded) reports totalGroups=2 for scope server and both sit in this file: logCompletion vs logRewrite (hash 3ed8be0b, 213 tokens, 18 savable lines, identical body after literal normalization) and describeAttempt vs describeRewriteAttempt (hash b2117fe1, 119 tokens, 11 savable lines, same failure-to-category mapping).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795261634268` · ts `2026-11-21T11:47:14.268Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`logCompletion`、`logRewrite`、`describeAttempt`、`describeRewriteAttempt`
- 涉及文件：
- `server/modules/reply-suggestions/reply-suggestions-draw.ts:127`
- `server/modules/reply-suggestions/reply-suggestions-draw.ts:94`
- `server/modules/reply-suggestions/reply-suggestions-draw.ts:372`
- `server/modules/reply-suggestions/reply-suggestions-draw.ts:344`
- kind：`duplication`
- verdict：`confirmed`

## Requested action
Extract one logCompletionOutcome(prefix, ...) and one describeUpstreamFailure(failure) helper and call both from the two runners; AC: archguard_detect_duplicates(scope=server) returns totalGroups 0 and the reply-suggestions draft-rewrite tests stay green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-21T11:47:14.268Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `dup-reply-suggestions-draw-clone-pairs`（routine `architecture-analysis`，runId `architecture-analysis-1795261634268`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/reply-suggestions/reply-suggestions-draw.ts`
- `tasks/gap-routine-architecture-analysis-dup-reply-suggestions-draw-clone-pairs.md`

## Evidence
复核与处置（worktree `gap-routine-architecture-analysis-dup-reply-suggestions-draw-clone-pairs`，提交 `dfc01ae5f`，基线 develop `669ea0244`）：

- 基线复现：直接 `import { detectDuplicates } from '@yalehwang/archguard/dist/analysis/duplicates/group.js'`，调用 `detectDuplicates(root, ['server'], {minStatements:6, minTokens:50, includeTests:false})` → `totalGroups=2`、`scannedFiles=693`；两组恰为 finding 所述：
  - `hash=3ed8be0ba49fd4b8`，tokenCount=213，members=`logCompletion`(127-144) / `logRewrite`(372-388)
  - `hash=b2117fe1a9e19492`，tokenCount=119，members=`describeAttempt`(94-104) / `describeRewriteAttempt`(344-354)
- 处置：抽出模块级 `describeUpstreamFailure(failure)`（两处相同失败→类别映射合一）与 `logCompletionOutcome(logger, prefix, settings, durationMs, outcome, completion, requestId, httpStatus)`（`prefix=''` 为 chip draw、`prefix='draftRewrite '` 为 draft rewrite），两个 runner 均改调用这两个 helper；删除 `describeAttempt`、`describeRewriteAttempt`、`logCompletion`、`logRewrite` 四个重复体。
- 修复后同一调用（worktree 根）→ `totalGroups=0`，`scannedFiles=693`。
- 日志行形态不变：chip draw 仍为 `[reply-suggestions] protocol=…`（空前缀），draft rewrite 仍为 `[reply-suggestions] draftRewrite protocol=…`。
- `npm run typecheck`（root + server + scripts 三份 tsconfig）exit 0；`npm run lint` 对被改文件无 error（其余为 develop 既有 warning）。
- 定向回归（`bash scripts/quay-rerun-failed.sh --worktree <wt> <files>`，逐条 exit 0）：
  - `server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite.test.ts`
  - `server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite-routes.test.ts`
  - `server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts`
  - `server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts`
- DoD 第 2 条：finding 由 `.quay/routine-findings.jsonl` 机械通道产出并经 `routine-file-gate.ts` 三闸立案；修复由本 worker（派发链）执行，例程未代跑产出者/修复。
- 预合并：`git -C <wt> merge --no-edit develop` → Already up to date；anti-drift Touches 检查 exit 0（1 个实际文件，均在声明 Touches 内）。

## ADR-007 暗轴记录
该轴仍暗,理由:本任务处置 archguard detect_duplicates 克隆对，不产出 L_D/L_G 依赖图读数