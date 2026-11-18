---
id: gap-routine-architecture-analysis-file-scc-server-claude-resident-lifecycle-8
title: "architecture-analysis: 8 of the 18 files in
  modules/providers/list/claude/lifecycle sit in one SCC (registry:49 imports
  handlers, handlers:56 imports registry; resident-host.types."
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
8 of the 18 files in modules/providers/list/claude/lifecycle sit in one SCC (registry:49 imports handlers, handlers:56 imports registry; resident-host.types.ts / resident-ledger-runtime.ts / resident-settings.ts / resident-turn.types.ts close the rest); invisible to the directory ratchet and to the only file-level pin, which covers modules/mcp-gateway alone.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794995539540` · ts `2026-11-18T09:52:19.540Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ClaudeResidentOutcomeRegistry`、`CLAUDE_RESIDENT_OUTCOME_HANDLERS`、`createDefaultClaudeResidentOutcomeRegistry`
- 涉及文件：
- `server/modules/providers/list/claude/lifecycle/claude-resident-outcome-handlers.ts:56`
- `server/modules/providers/list/claude/lifecycle/claude-resident-outcome-registry.ts:49`
- `server/modules/providers/list/claude/lifecycle/resident-host.types.ts:1`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Split the handler TABLE (data) from the registry (behaviour) into a leaf module so registry → handlers is the only direction, then pin the package's file graph.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-18T09:52:19.540Z

## 复核与处置

### 复核（finding 逐条对读）

复核在隔离 worktree 上用仓库自己的文件级扫描器（`server/shared/imports/import-graph.ts` 的 `scanFileImportGraph`，即 AC-394 用例 (j) 使用的同一个扫描器，未另写一份）重读 `server/modules/providers/list/claude/lifecycle/`：

- 实测 18 个文件、54 条包内解析边、一个 8 成员非平凡 SCC，成员与 finding 一致：`claude-resident-outcome-handlers.ts`、`claude-resident-outcome-registry.ts`、`resident-host.types.ts`、`resident-launch.ts`、`resident-ledger-runtime.ts`、`resident-process.types.ts`、`resident-settings.ts`、`resident-turn.types.ts`。
- finding 点名的两条闭合边复现：registry → handlers（factory 需要 registry 类）与 handlers → registry（表文件构造默认 registry）。
- 第三条闭合边为 `resident-host.types.ts → claude-resident-outcome-registry.ts`，且该 import 在文件里没有任何使用点（死 import）；它把 registry 接回了 ledger/settings/process 那一团。

### 处置（修掉，不是「已注意到」）

1. **data / behaviour 分家**：`ClaudeResidentOutcomeName` / `ClaudeResidentOutcomeContext` / `ClaudeResidentOutcomeHandler` / `ClaudeResidentOutcomeDispatch` 与 handler 表 `CLAUDE_RESIDENT_OUTCOME_HANDLERS` 留在 `claude-resident-outcome-handlers.ts`（data 叶，已不 import registry）；`ClaudeResidentOutcomeRegistry` 与 `createDefaultClaudeResidentOutcomeRegistry()` 放进 `claude-resident-outcome-registry.ts`（behaviour）。依赖方向只剩 registry → handlers；registry 仍 re-export 这些类型，消费者 import 路径不变。
2. **删死边**：`resident-host.types.ts` 删除未使用的 registry import。
3. **pin 包图**：在 AC-394 的 `server/shared/tests/server-import-cycle-budget.test.ts` 新增用例 (k)，扫描整个 lifecycle 包，断言 (a) 不存在 handlers 文件 → registry 文件的解析边（方向断言），(b) 两个 outcome 文件都不在任何非平凡 SCC 中，(c) 残留 6 成员 SCC 的成员集合按「只许缩小」棘轮钉住，新文件加入即红。

### 读数（修复前 → 修复后）

- L_G file-graph (`scanFileImportGraph`, lifecycle package): files before=18 after=18; intraPackageEdges before=54 after=50; nonTrivialSccs before=1 after=1; maxSccMembers before=8 after=6; outcomeFilesInScc before=2 after=0
- 残留 SCC（用例 (k) 已钉，只许缩小）：`resident-host.types.ts` / `resident-launch.ts` / `resident-ledger-runtime.ts` / `resident-process.types.ts` / `resident-settings.ts` / `resident-turn.types.ts`。这是本包 ledger/settings/process 的类型缠绕，本任务未展开；它现在被用例 (k) 显式读数，不再对目录棘轮与 mcp-gateway 单包 pin 不可见。
- L_G 仪器口径：`archguard-runner` 的六个 scope 只覆盖 quay 自身，本仓库的 `src`/`server` 均实测 `analyze exited 1` ⇒ NOT EVALUATED；因此不假报 `cycles=0`，上面的读数是本仓库文件级扫描器的真实读数。

### 实跑证据

- `tsc --noEmit -p server/tsconfig.json` → exit 0
- `oxlint`（6 个改动文件）→ exit 0
- `server/modules/providers/tests/claude-resident-outcome-registry.test.ts` → 4/4 pass
- `server/modules/providers/tests/claude-resident-lifecycle-outcome-registry.test.ts` + `claude-resident-control-queue.test.ts` → 6/6 pass
- `server/shared/tests/server-import-cycle-budget.test.ts` → 13/13 pass；用例 (k) 打印 `files=18 intraPackageEdges=50 sccs=[[6 members]]`
- `server/shared/tests/architecture-ratchet.test.ts` → 6/6 pass
- `server/shared/tests/cloudpit-goal-exit-gate.test.ts` → 3/3 pass

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `file-scc-server-claude-resident-lifecycle-8`（routine `architecture-analysis`，runId `architecture-analysis-1794995539540`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/providers/list/claude/lifecycle/claude-resident-outcome-handlers.ts`
- `server/modules/providers/list/claude/lifecycle/claude-resident-outcome-registry.ts`
- `server/modules/providers/list/claude/lifecycle/resident-host.types.ts`
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`
- `server/modules/providers/tests/claude-resident-outcome-registry.test.ts`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-file-scc-server-claude-resident-lifecycle-8.md`
