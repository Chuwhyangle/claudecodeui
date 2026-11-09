---
id: gap-routine-architecture-analysis-src-shared-ui-god-package
title: "architecture-analysis: Fresh archguard 2026-11-09 (scope src 93e0a992):
  shared/ui = 24 files / 43 entities, fanIn 6 / fanOut 87 — over minFiles 20;
  the package is nominally UI prim"
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
Fresh archguard 2026-11-09 (scope src 93e0a992): shared/ui = 24 files / 43 entities, fanIn 6 / fanOut 87 — over minFiles 20; the package is nominally UI primitives but carries two feature components (ModelLibraryPanel 672 lines, which imports its own sibling barrel at line 15, and ModelEnvEditor 302 lines) consumed from three feature modules via deep paths.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794227898835` · ts `2026-11-09T12:38:18.835Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ModelLibraryPanel`、`ModelEnvEditor`
- 涉及文件：
- `src/shared/ui/ModelLibraryPanel.tsx:121`
- `src/shared/ui/ModelEnvEditor.tsx:96`
- `src/shared/ui/index.ts:1`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Extract the model-library feature pair into a feature leaf and leave shared/ui as generic primitives exporting only Button/Card/Dialog-class components; AC: archguard package-stats shared/ui fileCount<=20 and no tooManyFiles reason, frontend-import-cycle-budget cycleGroups stay the same four groups, ModelLibraryPanel/ModelEnvEditor consumer tests green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-09T12:38:18.835Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `src-shared-ui-god-package`（routine `architecture-analysis`，runId `architecture-analysis-1794227898835`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Evidence

复核（开工前，临时 work-dir 上重跑同一 instrument）：

- `archguard analyze --lang typescript -s src` + `query --package-stats` → `shared/ui` fileCount=24, entityCount=43（与 finding 一致）；按 TS god-package 默认阈值（minFanIn=5 / minFanOut=20 / minFiles=20 / minEntities=50）判定为 `tooManyFiles`（24≥20）。
- 结论：finding `confirmed`，确实需要把 feature 组件移出 shared/ui，而不是「已注意到」。

处置（修掉，不是 park）：

- `ModelLibraryPanel.tsx` / `ModelEnvEditor.tsx` → `src/modules/model-library/`，由新 barrel `src/modules/model-library/index.ts` 暴露；chat、chat-support、settings 三个消费方改为从该 barrel 导入（`boundaries/dependencies` 要求跨 feature 只走 `index.ts`）。
- 品牌/provider 标记 → `src/shared/ui/logos/` 子包，root barrel 继续 re-export，消费方导入点不变；shared/ui 只留通用控件原语。

修复后读数（同一 instrument，同一 worktree）：

- `shared/ui`: **fileCount=14**（≤20）、entityCount=30（<50），**reasons 不再含 `tooManyFiles` / `tooManyEntities`**；残余 `highFanIn`(5) / `highFanOut`(47) 如实记录 —— 关系型指标不会被目录拆分降低，拆分只把包内关系变成跨包关系。
- `shared/ui/logos`: fileCount=8, entities=8；`modules/model-library`: fileCount=3, entities=5。
- `frontend-import-cycle-budget.test.ts`: 9/9 pass；`cycleGroups` 仍是原四组，`moduleSccGroups` 仍是 cockpit↔project-workspace 一组（新模块只有入边，未闭合新环）。
- `architecture-ratchet.test.ts`: 6/6 pass；已无 provider-name branch 的 `src/shared/ui/ModelLibraryPanel.tsx:2` 旧条目按「读数下降」移除（搬动后实测 0）。
- 消费方测试：`modelLibraryDuplicate.test.tsx`(5) + `codexModelProviderHint.test.tsx`(3) + `modelLibrarySave.test.tsx`(5) + `newSessionModelProviderOption.test.tsx`(7) + `costModalAiTitle.test.tsx`(11) + `brandMark.test.tsx`(1) + `debug-agent-display-identity.test.ts`(2) 全绿；`identityTests` 合计 34 tests / 7 files pass。
- `tsc --noEmit`（root / server / scripts 三个 tsconfig）exit 0；`oxlint` 对改动面仅既有 warning，无 error。

- L_G archguard: cycles=4, moduleSccGroups=1, sharedUiFileCount=14, tooManyFiles=0

## Touches
- `src/shared/ui/ModelLibraryPanel.tsx`
- `src/shared/ui/ModelEnvEditor.tsx`
- `src/modules/model-library/ModelLibraryPanel.tsx`
- `src/modules/model-library/ModelEnvEditor.tsx`
- `src/modules/model-library/index.ts`
- `src/modules/model-library/tests/modelLibraryDuplicate.test.tsx`
- `src/modules/settings/tests/modelLibraryDuplicate.test.tsx`
- `src/modules/settings/tests/codexModelProviderHint.test.tsx`
- `src/modules/settings/tabs/agents-settings/sections/content/ModelsContent.tsx`
- `src/modules/settings/tabs/agents-settings/sections/content/CodexProvidersContent.tsx`
- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`
- `src/modules/chat-support/modals/CommandResultModal.tsx`
- `src/shared/ui/index.ts`
- `src/shared/ui/logos/BrandMark.tsx`
- `src/shared/ui/logos/ClaudeLogo.tsx`
- `src/shared/ui/logos/CodexLogo.tsx`
- `src/shared/ui/logos/CursorLogo.tsx`
- `src/shared/ui/logos/DiscordIcon.tsx`
- `src/shared/ui/logos/LLMProviderLogo.tsx`
- `src/shared/ui/logos/OpenCodeLogo.tsx`
- `src/shared/ui/logos/providerLogos.ts`
- `src/shared/constants.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `tasks/gap-routine-architecture-analysis-src-shared-ui-god-package.md`
