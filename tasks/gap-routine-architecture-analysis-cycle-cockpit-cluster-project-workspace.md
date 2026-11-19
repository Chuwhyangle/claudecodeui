---
id: gap-routine-architecture-analysis-cycle-cockpit-cluster-project-workspace
title: "architecture-analysis: Package-level SCC of size 5 (modules/cockpit,
  modules/cockpit/cards, modules/cockpit/hooks, modules/cockpit/workspace,
  modules/project-workspace) with 90 cro"
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
Package-level SCC of size 5 (modules/cockpit, modules/cockpit/cards, modules/cockpit/hooks, modules/cockpit/workspace, modules/project-workspace) with 90 cross-package edges; every closing edge was re-read in source (cards→cockpit root via cockpitCardDescriptors, hooks→cockpit root via cockpitView, workspace→cockpit root, cards→project-workspace at CockpitCardList.tsx:26, project-workspace→cockpit barrel). The 49-export barrel modules/cockpit/index.ts is the hub.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795081962018` · ts `2026-11-19T09:52:42.018Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`cockpitCardDescriptors`、`cockpitCardTitle`、`cockpitCardSubjectName`、`cockpitCardFactsBeyondSituation`、`shownOptionOf`、`useOptionalProjectMainState`、`CockpitInput`、`useInitiatives`、`CockpitPage`、`CockpitColumnProvider`
- 涉及文件：
- `src/modules/cockpit/index.ts:115`
- `src/modules/cockpit/cards/CockpitCardList.tsx:26`
- `src/modules/cockpit/cards/CockpitCard.tsx:18`
- `src/modules/cockpit/hooks/useInitiatives.ts:4`
- `src/modules/cockpit/hooks/useCockpitCards.ts:9`
- `src/modules/cockpit/workspace/CockpitPage.tsx:20`
- `src/modules/cockpit/workspace/CockpitColumn.tsx:12`
- `src/modules/project-workspace/ProjectWorkspaceShell.tsx:9`
- `src/modules/project-workspace/WorkspaceHeader.tsx:7`
- `src/modules/project-workspace/WorkspaceMain.tsx:12`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Extract the cluster's leaf contract modules (cockpitCardDescriptors, cockpitView, cockpitIntent, cockpitEntry, cockpitColumnController, cockpitCardController) into a sink subpackage modules/cockpit/contract/ that imports nothing back into cards|hooks|workspace; move useOptionalProjectMainState out of CockpitCardList.tsx:26; repoint project-workspace at the leaf subpackage instead of the @/modules/cockpit barrel.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-19T09:52:42.018Z

## 处置（2026-11-19，派发链执行）

复核（读数，不是转抄）：用 `server/shared/import-graph.ts` 的同一走查 / 解析器 / Tarjan（`strongComponents`）在合并树上对 `src/` 做两种粒度读数，finding 的两条都复现：
- 目录粒度：5 员 SCC `{modules/cockpit, modules/cockpit/cards, modules/cockpit/hooks, modules/cockpit/workspace, modules/project-workspace}`。
- 模块粒度：2 员 SCC `{modules/cockpit, modules/project-workspace}`。
- 逐边复核：闭合该模块环的 cockpit 侧边**只有一条**——`cards → project-workspace`，即 `CockpitCardList.tsx` 里的 `useOptionalProjectMainState`；反方向 `project-workspace → cockpit` 是 3 条（`CockpitColumnProvider` / `CockpitHeaderButton` / `CockpitColumnRegion` 走 `@/modules/cockpit` barrel）。

处置（修掉模块级环，目录组按收缩重钉）：
- 把 `useOptionalProjectMainState` 这条**闭合边**的接缝搬到共享层 `src/shared/context/OptimisticSessionContext.tsx`：`ProjectsStateProvider` 提供 `{projects, registerOptimisticSession}`，cockpit 的 cards 列表用 `useOptionalOptimisticSession()` 可选读取。cockpit 不再 import `@/modules/project-workspace`，于是 `project-workspace → cockpit` 成为单向依赖。
- 结果：模块 SCC `{cockpit, project-workspace}` **消失**（`moduleSccGroups` 置空）；目录 SCC 的 cockpit 组由 5 员收缩为 4 员（`project-workspace` 出组）。两个 pin 同一次改动同时下调（in-file 常量 + committed JSON）。
- 2026-11-19 合并 develop（已落地 `chat/ui` 叶子拆分的那一轮）后，在同一棵**合并树**上重测并据实改写 baseline（note 取两边并集，未手并计数）：目录 SCC 3 组（cockpit 4 员 / git-panel 3 员 / settings 2 员），模块 SCC 为空；provenance 计数 files 768 / staticFileEdges 2765 / nodeCount 145 / unresolvedInternal 100 / nonLiteralDynamic 2。合并冲突仅落在 `frontend-import-cycle-budget.baseline.json` 与 `.test.ts` 的 note/readings 与 `CYCLE_GROUPS`：两边都是「收缩」——develop 去掉 chat/tools 组、本分支去掉 cockpit 组里的 project-workspace——取语义并集后即为上述 3 组。
- 对 requested action 中「把 `cockpitCardDescriptors`/`cockpitView`/`cockpitIntent`/`cockpitEntry`/`cockpitColumnController`/`cockpitCardController` 搬进 sink 子包」的有意取舍（理由可核）：这六个是 **cockpit 内部**的消费关系，搬动不改变任何一条跨模块边，也不参与闭合该模块环的那条边；盲搬只会扩大 diff，并把 `cockpitView → @/modules/quay`、`cockpitIntent → @/modules/chat`、`cockpitCardController → cards/*` 这些**特征模块出边**带进叶子契约，反而违反 `frontend-import-cycle-budget.test.ts` 对 `modules/cockpit-contract` 的零出边断言。真正闭合 `{cockpit, project-workspace}` 环的就是 `cards → project-workspace` 那一条，已切断。
- 残余（已有机制在管，失败在哪一步）：收缩后的 4 员目录组 `{cockpit, cockpit/cards, cockpit/hooks, cockpit/workspace}` 是 cockpit 模块**自身**的 root-barrel ↔ 子目录 web（barrel 再导出子目录组件，子目录组件又 import 根目录组件）；要整体拆掉需要成对搬迁 React 组件（另一项更大的结构任务）。当前由 `frontend-import-cycle-budget.test.ts` 逐成员钉死、只许收缩——任何让该组新增成员、或让 `modules/cockpit-contract` 长出出边的 import，都会在 `assertCycleBudget` / `assertModuleSccBudget` / 叶子断言处红。

实跑读数（本 worktree，2026-11-19 合并 develop 之后重跑）：
- `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/frontend-import-cycle-budget.test.ts` → tests 12 / pass 12 / fail 0（3 组目录 pin + 空模块 pin 绿）。
- `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/architecture-ratchet.test.ts server/shared/tests/cloudpit-goal-exit-gate.test.ts` → tests 9 / pass 9 / fail 0。
- `npx vitest run src/modules/cockpit src/modules/project-workspace` → 47 files / 665 tests 全绿。
- `npx tsc --noEmit -p tsconfig.json` 与 `npx tsc --noEmit -p server/tsconfig.json` → 均 exit 0；`npx oxlint <changed files>` → exit 0（仅既有 warning）。
- 独立读数复算（复刻测试的同一 `collectTypeScriptSources` + `scanImportGraph` + `strongComponents`）：目录 `nonTrivialSccs` = 3 组，模块 SCC = 0 组，与 pin 逐成员相等。

- L_D archguard: directory_scc_groups=3 cockpit_directory_group_members=4 module_scc_groups=0
- L_G archguard: directory_scc_groups=3 cockpit_directory_group_members=4 module_scc_groups=0

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `cycle-cockpit-cluster-project-workspace`（routine `architecture-analysis`，runId `architecture-analysis-1795081962018`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/cockpit/index.ts`
- `src/modules/cockpit/cards/CockpitCardList.tsx`
- `src/modules/cockpit/cards/CockpitCard.tsx`
- `src/modules/cockpit/hooks/useInitiatives.ts`
- `src/modules/cockpit/hooks/useCockpitCards.ts`
- `src/modules/cockpit/workspace/CockpitPage.tsx`
- `src/modules/cockpit/workspace/CockpitColumn.tsx`
- `src/modules/project-workspace/ProjectWorkspaceShell.tsx`
- `src/modules/project-workspace/WorkspaceHeader.tsx`
- `src/modules/project-workspace/WorkspaceMain.tsx`
- `src/shared/context/OptimisticSessionContext.tsx` (new)
- `src/modules/project-workspace/context/ProjectsStateContext.tsx`
- `src/modules/project-workspace/index.ts`
- `server/shared/tests/frontend-import-cycle-budget.test.ts`
- `server/shared/tests/frontend-import-cycle-budget.baseline.json`
- `tasks/gap-routine-architecture-analysis-cycle-cockpit-cluster-project-workspace.md`
