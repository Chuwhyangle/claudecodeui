---
id: gap-routine-architecture-analysis-cycle-cockpit-cluster-project-workspace
title: "architecture-analysis: Package-level SCC of size 5 (modules/cockpit,
  modules/cockpit/cards, modules/cockpit/hooks, modules/cockpit/workspace,
  modules/project-workspace) with 90 cro"
status: todo
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

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `cycle-cockpit-cluster-project-workspace`（routine `architecture-analysis`，runId `architecture-analysis-1795081962018`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

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
- `tasks/gap-routine-architecture-analysis-cycle-cockpit-cluster-project-workspace.md`