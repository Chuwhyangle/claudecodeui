---
id: gap-routine-architecture-analysis-cycle-chat-tools-transcript
title: "architecture-analysis: Package-level SCC of size 3 (modules/chat/tools,
  modules/chat/tools/ContentRenderers, modules/chat/transcript) over 14 edges:
  tools imports 8 ContentRenderer"
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
Package-level SCC of size 3 (modules/chat/tools, modules/chat/tools/ContentRenderers, modules/chat/transcript) over 14 edges: tools imports 8 ContentRenderers; ContentRenderers/TodoList.tsx imports chat/tools/Queue and MarkdownContent imports chat/transcript/Markdown; transcript imports the chat/tools barrel from MessageComponent.tsx:8 and ToolGroupContainer.tsx:5.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795081962018` · ts `2026-11-19T09:52:42.018Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ToolRenderer`、`MarkdownContent`、`FileListContent`、`TodoListContent`、`TaskListContent`、`TodoList`、`Queue`、`ToolGroupContainer`、`MessageComponent`、`Markdown`、`ToolErrorDisplay`
- 涉及文件：
- `src/modules/chat/tools/ToolRenderer.tsx:9`
- `src/modules/chat/tools/ContentRenderers/TodoList.tsx:3`
- `src/modules/chat/tools/ContentRenderers/MarkdownContent.tsx:3`
- `src/modules/chat/transcript/ToolGroupContainer.tsx:5`
- `src/modules/chat/transcript/MessageComponent.tsx:8`
- `src/modules/chat/tools/ToolErrorDisplay.tsx:5`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Extract Markdown and Queue primitives into a leaf package modules/chat/ui/ that both tools and transcript import; stop transcript importing the @/modules/chat/tools barrel (import the specific leaf modules instead).

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-19T09:52:42.018Z

## Disposition

**复核（finding 复现）**：该 SCC 已被本仓的目录级棘轮逐字钉住 ——
`server/shared/tests/frontend-import-cycle-budget.test.ts` 的 `CYCLE_GROUPS` 里就是
`modules/chat/tools` / `modules/chat/tools/ContentRenderers` / `modules/chat/transcript`，
修前整棵 `src/` 的 Tarjan 读数与该三元组完全一致。环内边逐条复核：
`tools/ToolRenderer.tsx` → 8 个 ContentRenderers；`ContentRenderers/TodoList.tsx` → `tools/Queue`；
`ContentRenderers/MarkdownContent.tsx` → `transcript/Markdown`；`tools/ToolErrorDisplay.tsx` → `transcript/Markdown`；
`transcript/MessageComponent.tsx` 与 `transcript/ToolGroupContainer.tsx` → `@/modules/chat/tools` 桶。

**处置：修掉（不是「已注意到」）**
- 新建叶子包 `src/modules/chat/ui/`：`Markdown.tsx`、`MarkdownImage.tsx` 自 `chat/transcript` 迁入，`Queue.tsx` 自 `chat/tools` 迁入。该包不回指 tools/ 或 transcript/（只依赖 `@/shared/*`、`chat-transcript`、`chat-session`、`chat-support`、`code-editor`、`command-palette`）。
- `chat/tools` 与 `chat/tools/ContentRenderers` 改从 `chat/ui` 取 Markdown/Queue ⇒ `ContentRenderers→tools`、`ContentRenderers→transcript` 两条回边消失，`tools→ContentRenderers` 保持单向。
- `transcript` 不再 import `@/modules/chat/tools` 桶：`MessageComponent` 按名字取 `ToolRenderer`/`ToolErrorDisplay`/`SubagentPanel` 叶子；`getToolConfig`、`shouldHideToolResult` 改从定义处 `@/modules/chat-tool-configs` 取（桶原本仅再导出）。
- 棘轮按规则同提交下调：in-file `CYCLE_GROUPS` 与 committed JSON 的 `cycleGroups` 同时去掉该组，并重测 provenance 读数；模块级 SCC 不变。

**实跑证据（本任务 worktree，merge develop 之后）**
- `tsx --tsconfig server/tsconfig.json --test server/shared/tests/frontend-import-cycle-budget.test.ts` → `tests 12 / pass 12 / fail 0`；目录级读数只剩 cockpit / git-panel / settings 三组，chat 三元组 0 组。
- `tsc --noEmit -p tsconfig.json`（frontend）与 `tsc --noEmit -p server/tsconfig.json` → exit 0。
- 受影响的 12 个 vitest 文件（markdown ×4、messageStreamEnd、diffStatsBadgeRender、toolGrouping、QuestionAnswerContent、machineOriginRow、monitorEventCollapseRender、taskNotificationRow）→ `12 passed / 106 tests passed`。
- 全量 suite 未在本任务内跑：按 worker 约定由 driver 的机械 fan-in 执行。

- L_G frontend-import-cycle-budget: chat-tools-transcript dirScc=0
- L_G frontend-import-cycle-budget: cycleGroups=3 files=767 staticFileEdges=2764

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `cycle-chat-tools-transcript`（routine `architecture-analysis`，runId `architecture-analysis-1795081962018`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/chat/tools/ToolRenderer.tsx`
- `src/modules/chat/tools/ContentRenderers/TodoList.tsx`
- `src/modules/chat/tools/ContentRenderers/MarkdownContent.tsx`
- `src/modules/chat/transcript/ToolGroupContainer.tsx`
- `src/modules/chat/transcript/MessageComponent.tsx`
- `src/modules/chat/tools/ToolErrorDisplay.tsx`
- `src/modules/chat/ui/Markdown.tsx`
- `src/modules/chat/ui/MarkdownImage.tsx`
- `src/modules/chat/ui/Queue.tsx`
- `src/modules/chat/transcript/Markdown.tsx`
- `src/modules/chat/transcript/MarkdownImage.tsx`
- `src/modules/chat/tools/Queue.tsx`
- `src/modules/chat/transcript/StreamingMarkdown.tsx`
- `src/modules/chat/tools/index.ts`
- `src/modules/chat/tests/fileReferenceLinks.test.tsx`
- `src/modules/chat/tests/markdownImage.test.tsx`
- `src/modules/chat/tests/markdownSyntaxThemeInjection.test.tsx`
- `src/modules/chat/tests/streamingMarkdownComponent.test.tsx`
- `server/shared/tests/frontend-import-cycle-budget.test.ts`
- `server/shared/tests/frontend-import-cycle-budget.baseline.json`
- `tasks/gap-routine-architecture-analysis-cycle-chat-tools-transcript.md`