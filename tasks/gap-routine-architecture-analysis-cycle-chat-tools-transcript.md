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

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `cycle-chat-tools-transcript`（routine `architecture-analysis`，runId `architecture-analysis-1795081962018`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/chat/tools/ToolRenderer.tsx`
- `src/modules/chat/tools/ContentRenderers/TodoList.tsx`
- `src/modules/chat/tools/ContentRenderers/MarkdownContent.tsx`
- `src/modules/chat/transcript/ToolGroupContainer.tsx`
- `src/modules/chat/transcript/MessageComponent.tsx`
- `src/modules/chat/tools/ToolErrorDisplay.tsx`
- `tasks/gap-routine-architecture-analysis-cycle-chat-tools-transcript.md`