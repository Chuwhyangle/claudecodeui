---
id: gap-routine-architecture-analysis-cycle-shared-types-type-only-3
title: "architecture-analysis: 3-file SCC closed entirely by `import type` edges
  (claude-events → cli-session → provider-launch → claude-events, plus
  provider-launch → cli-session); a type"
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
3-file SCC closed entirely by `import type` edges (claude-events → cli-session → provider-launch → claude-events, plus provider-launch → cli-session); a type-only cycle in the shared type tree forces every consumer of any one of them to see all three, and no gate reads it.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795175197228` · ts `2026-11-20T11:46:37.228Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ChatRunSource`、`ProviderRuntimeContext`、`CommandLifecycleState`、`HostMode`
- 涉及文件：
- `server/shared/types/claude-events.ts:1`
- `server/shared/types/cli-session.ts:1`
- `server/shared/types/provider-launch.ts:1`
- `server/shared/types/provider-launch.ts:2`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Extract the primitive types (ChatRunSource / CommandLifecycleState / HostMode) into a leaf `server/shared/types/primitives.ts` that all three import one-way, then pin the package's file graph.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-20T11:46:37.228Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `cycle-shared-types-type-only-3`（routine `architecture-analysis`，runId `architecture-analysis-1795175197228`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/shared/types/claude-events.ts`
- `server/shared/types/cli-session.ts`
- `server/shared/types/provider-launch.ts`
- `server/shared/types/primitives.ts`
- `server/shared/types/index.ts`
- `server/shared/types/delivery.ts`
- `server/shared/types/mcp-tools.ts`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-cycle-shared-types-type-only-3.md`

## Evidence

**处置结论：已修掉（不是「已有机制在管」）。** 复核读数来自仓库自己的 TS 语法树扫描器 `server/shared/import-graph.ts`（显式包含 `import type` 边），在工作树上实跑：

- 修复前 `server/shared/types/` 文件级：`files=17 edges=30 sccs=[["shared/types/claude-events.ts","shared/types/cli-session.ts","shared/types/provider-launch.ts"]]` —— 与 finding 逐字一致。闭合边正是四条 type-only 边：claude-events→cli-session（ChatRunSource）、cli-session→provider-launch（ProviderRuntimeContext）、provider-launch→claude-events（CommandLifecycleState）、provider-launch→cli-session（HostMode）。
- 修复后 `server/shared/types/`：`files=18 intraPackageEdges=31 sccs=[]`。
- 全仓 `server/`：`files=688 staticEdges=2780 dynamicEdges=4 sccs=[] unresolvedInternal=17 nonLiteralDynamic=2`（目录级本来就读不到包内环，这里只作旁证）。

**改动**（commit `55747db61`）：

- 新增叶子 `server/shared/types/primitives.ts`：import 为零，承载 `ChatRunSource` / `CommandLifecycleState` / `HostMode` 三个 union（原有文档注释逐字搬迁）。
- `claude-events.ts` / `cli-session.ts` / `provider-launch.ts` 单向 import 叶子；`delivery.ts` / `mcp-tools.ts` 的 `ChatRunSource` 也改指叶子；`index.ts` 增加 `export * from './primitives.js'`，包对外导出面不变（`@/shared/types.js` 的消费者无需改动）。
- 固定图：`server/shared/tests/server-import-cycle-budget.test.ts` 新增 case (k)（骑在既有 AC-394 判据文件上，不新建测试文件）——合成「只由 `import type` 闭合的两文件环」必须被报告（判别力/假形态），真实 `server/shared/types` 包必须 `nonTrivialSccs=[]`，并带 intra-package 边数非空下限（实测 31 ≥ 10）防止空走。

**实跑**：

- `npx tsc --noEmit -p server/tsconfig.json` → exit 0
- `npx tsc --noEmit -p tsconfig.json`、`npx tsc --noEmit -p scripts/tsconfig.json` → exit 0
- `tsx --test server/shared/tests/server-import-cycle-budget.test.ts` → 13/13 pass（含新 case (k)）
- `vitest run src/shared/tests/wireContractTypeSync.test.ts` → 5/5 pass（`HostMode` 行按 `server/shared/types` 目录读取，新叶子仍被读到）
- `tsx --test server/shared/tests/architecture-ratchet.test.ts server/shared/tests/cloudpit-goal-exit-gate.test.ts` → 9/9 pass（新文件 65 行 <800、无模块级可变状态、无新目录）

**本轮（2026-11-20 续跑）——上一轮 suite 红的真因与解除**：红的是 `src/modules/architecture/tests/architectureTab.test.tsx`「the analysis time is a relative reading」，与本任务 delta 无关，是 develop 全域的固定相对时间夹具炸弹：`GENERATED_AT` 曾钉死 `2026-10-20T15:52:34.427Z`，跨过格式器 30 天月界后读数从 "… ago" 变成 "last month"，`/ago|now/i` 判据在每棵树都红。develop 的 `2ae15aa53` 已把夹具改为滚动 `new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()`；本 worktree 合并 develop 后：

- `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → 129/129 pass（1 file passed）
- `npx tsx --test server/shared/tests/server-import-cycle-budget.test.ts` → 13/13 pass（case (k) 在 merge 后仍在，无冲突标记）
- `npx tsc --noEmit -p server/tsconfig.json` → exit 0
- anti-drift Touches 检查 → `ANTI-DRIFT OK`，8 个实改文件全部落在声明的 9 个 glob 内
- `task_check` → acTotal=2 acChecked=2，dodTotal=2 dodChecked=2，`execute->done` ok

ADR-007 暗轴记录：

- L_G import-graph: sccs=0（server/shared/types files=18 intraPackageEdges=31；whole server files=688 staticEdges=2780）

## Blocker

**2026-11-20T12:12:19.947Z — worker 未落地（exited-not-landed）** —— 已解除，见上「本轮续跑」小节。

- 未落地原因：step=suite: not ok - src/modules/architecture/tests/architectureTab.test.tsx: AssertionError [ERR_ASSERTION]: the analysis time is a relative reading [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=src/modules/architecture/tests/architectureTab.test.tsx]
- run_id：wk-prod-anchor
- session_id：9de8d21d-fcc2-4af2-ae8a-b919035407c7