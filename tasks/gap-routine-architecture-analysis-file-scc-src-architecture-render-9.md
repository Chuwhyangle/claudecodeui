---
id: gap-routine-architecture-analysis-file-scc-src-architecture-render-9
title: "architecture-analysis: 9 files of src/modules/architecture/render form a
  file-level SCC (ArchitecturePanel.tsx:48 → architecturePanelShell.tsx:24 →
  ArchitecturePanel.tsx); the fron"
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
9 files of src/modules/architecture/render form a file-level SCC (ArchitecturePanel.tsx:48 → architecturePanelShell.tsx:24 → ArchitecturePanel.tsx); the frontend's file-level pin (frontend-import-cycle-budget.test.ts:380-396) scans src/shared only, so no gate reads it — 753 src files / 2329 resolved file edges, 4 non-trivial file SCCs, 0 of them pinned.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794995539540` · ts `2026-11-18T09:52:19.540Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ArchitecturePanel`、`ArchitecturePanelShell`、`createArchitecturePanelModel`
- 涉及文件：
- `src/modules/architecture/render/ArchitecturePanel.tsx:48`
- `src/modules/architecture/render/architecturePanelShell.tsx:24`
- `src/modules/architecture/render/architecturePanelCanvas.tsx:1`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Move the panel model type into a leaf `architecturePanelModel.ts` (as src/shared/api did for the voiceConfig barrel) and widen the frontend file-level pin from src/shared to all of src/.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-18T09:52:19.540Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `file-scc-src-architecture-render-9`（routine `architecture-analysis`，runId `architecture-analysis-1794995539540`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Evidence

**复核（立案读数在真实树上逐字复现）。** 用 AC-394 同一套扫描器的文件级版本 `scanFileImportGraph`（`server/shared/import-graph.ts`）扫 `src/`：修复前 `files=753 fileEdges=2329 nonTrivialSccs=4`，与 finding 完全一致——
- 9 文件分量：`modules/architecture/render/{ArchitecturePanel.tsx, architecturePanelShell.tsx, architecturePanelCanvas.tsx, architecturePanelFilters.tsx, architecturePanelGroups.tsx, architecturePanelMobileChrome.tsx, architecturePanelReadout.tsx, architecturePanelReadyView.tsx, architecturePanelToolbar.tsx}`；
- 14 文件分量：cockpit 页树（cockpit/index + cards/CockpitCardList + workspace 六个 + project-workspace 六个）；
- 3 文件分量：chat-voice/voice-realtime 的 captionOrdering / placeCaptions / useVoiceRealtimeSession；
- 2 文件分量：architecture/layout/engine 的 readableZoom / svgViewport。

**根因（一条类型回边，不是 9 条业务耦合）。** 该 9 文件量里指向 `ArchitecturePanel.tsx` 的回边**全部是类型导入**：6 个 fragment + readyView 的 `import type { ArchitecturePanelScope }`、shell 的 `import type { ArchitecturePanelModel }`；而 `ArchitecturePanel.tsx → architecturePanelShell.tsx` 是值导入。即 owner 文件把自己的模型类型导出给视图、视图再回头 import owner —— 与 finding 给出的最短环 `ArchitecturePanel.tsx:48 → architecturePanelShell.tsx:24 → ArchitecturePanel.tsx` 一致。

**处置（本组修掉，⛔ 不是 pin 住）。**
- 新增叶子 `src/modules/architecture/render/architecturePanelModel.ts`：`ArchitecturePanelProps`、`ArchitecturePanelRenderer`、四个分支 arm（no-session / loading / error / ready）、`ArchitecturePanelScope` 与 `ArchitecturePanelModel` union。**全为类型、无运行值**；只 import 叶子模块（dom/*、layout/*、hooks/useProjectSearch、curation 与 viewport 控制器、`@/shared/types`、react、i18next），不 import 任何 render/ 面板文件。
- shell + 7 个 fragment 改从叶子取类型（8 处 import 换源）；`ArchitecturePanel.tsx` 只留 owner hook 与 7 行组件，删掉本地两份类型定义及只服务它们的 4 个 import。
- 契约是**显式声明**而非 `ReturnType<typeof useArchitecturePanelModel>` 推导：`tsc --noEmit -p tsconfig.json` 在 `model=` 交接口做结构校验，hook 改字段而叶子不改即红。

**加宽 pin（finding 的后半句「0 of them pinned」）。** `server/shared/tests/frontend-import-cycle-budget.test.ts` 的 FILE 读法由 `src/shared` 扩到整个 `src/`：
- `FILE_SCC_GROUPS` 逐成员钉住剩余 3 个分量；断言是**相等**而非「无新增」—— 少一个成员也是 red，关闭一组必须同一提交里同时下调 in-file 常量与 JSON 的 `fileSccGroups`（两处钉，与 `moduleSccGroups` 同款）；
- 非空转下限由 60 文件 / 100 边提到 600 / 1800（实测 754 文件 / 2349 边）；
- 新增控制「pinned 组新增一个成员必须红」；原正向控制（planted 两文件环）与负向控制（单向 re-export 不是环）保留；
- baseline JSON 增加 `fileSccGroups`、RE-READ 注记，readings 重测（files 754 / staticFileEdges 2736 / nodeCount 142 / unresolvedInternal 100 / nonLiteralDynamic 2）。

**处置后读数（同一扫描器、同一口径）。** `(file) src files=754 edges=2349 sccs=3` —— architecture/render 分量为 0；剩下 3 个即被 pin 住的三组。目录读数不变（4 组，directory case 绿）。

**其余 3 个分量的处置（AC 第二句要求的「可核」）。**
- cockpit/project-workspace 14 文件：其**模块级**环已有既有 pin（`MODULE_SCC_GROUPS`），本任务把它在**文件级**逐成员钉住——新文件加入即 red；真正拆它要动 cockpit 的路由/列/页与 project-workspace 的交叉，属另一 scope、不在本任务 Touches 内。
- chat-voice/voice-realtime 3 文件、architecture/layout/engine 2 文件：本任务前**没有任何已提交判据**读过它们（正是 finding 的「0 of them pinned」），现在文件级 pin 是唯一读法；同样只 pin 不拆，理由同上。

**实跑记录（全部在本 worktree，merge develop 后复跑）。**
- `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/frontend-import-cycle-budget.test.ts` → tests 13 / pass 13 / fail 0，含 `(file) src files=754 edges=2349 sccs=[14 文件组, 3 文件组, 2 文件组]`。
- `bash scripts/with-memory-cap.sh npx vitest run src/modules/architecture/tests` → Test Files 44 passed / Tests 691 passed（含 architectureTab 129、canvasLayoutContract、dockInspector、standalonePage、textPanel、exportMenu 等面板行为）。
- `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/architecture-ratchet.test.ts` → 6/6 绿（ArchitecturePanel.tsx 行数下降只出「可下调基线」提示；新叶子约 420 行，未触 800 行上限、无模块级可变状态、无 hook 状态）。
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` → exit 0；`node_modules/.bin/tsc --noEmit -p server/tsconfig.json` → exit 0。
- `node_modules/.bin/oxlint src/modules/architecture/render/` → 新叶子 0 warning；ArchitecturePanel.tsx 仅剩既有 warning（importx/refs），因搬走类型而新增的 4 个 no-unused-vars 已随 import 删除、复扫为 0。
- 预合并：`git merge --no-edit develop` 无冲突（develop 侧只多了兄弟任务的 tasks/*.md）；合并后复跑上面两条测试全绿。

## ADR-007

- L_D: src-file-sccs=3 file-scc-members=19 max-file-scc-files=14 file-edges=2349 src-files=754（同一扫描器实测；修复前同口径 sccs=4 file-scc-members=28，分组 14/9/3/2，architecture/render 分量 9→0）
- 该轴仍暗,理由:本任务只收敛 src/ 的文件级依赖图并把文件级棘轮加宽到全 src，不产生 goal 判据的达成/未达成读数

## Touches
- `src/modules/architecture/render/ArchitecturePanel.tsx`
- `src/modules/architecture/render/architecturePanelModel.ts`
- `src/modules/architecture/render/architecturePanelShell.tsx`
- `src/modules/architecture/render/architecturePanelReadyView.tsx`
- `src/modules/architecture/render/architecturePanelCanvas.tsx`
- `src/modules/architecture/render/architecturePanelFilters.tsx`
- `src/modules/architecture/render/architecturePanelGroups.tsx`
- `src/modules/architecture/render/architecturePanelMobileChrome.tsx`
- `src/modules/architecture/render/architecturePanelReadout.tsx`
- `src/modules/architecture/render/architecturePanelToolbar.tsx`
- `server/shared/tests/frontend-import-cycle-budget.test.ts`
- `server/shared/tests/frontend-import-cycle-budget.baseline.json`
- `tasks/gap-routine-architecture-analysis-file-scc-src-architecture-render-9.md`

## Blocker

**2026-11-18T10:34:41.255Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts: AssertionError [ERR_ASSERTION]: the long-corpus sample is missing at /data/home/yale/work/tc-verify/corpus/long/L4-nonstop.wav — the criterion cannot run without it [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts]
- run_id：wk-prod-anchor
- session_id：ba188ebe-f427-448c-a6a7-91639cfefb04
