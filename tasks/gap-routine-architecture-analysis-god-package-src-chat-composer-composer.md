---
id: gap-routine-architecture-analysis-god-package-src-chat-composer-composer
title: "architecture-analysis: archguard_detect_god_packages(scope=src) flags
  modules/chat-composer/composer with tooManyFiles: 24 direct files (threshold
  20), 37 entities, fanOut 147, 4,9"
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
archguard_detect_god_packages(scope=src) flags modules/chat-composer/composer with tooManyFiles: 24 direct files (threshold 20), 37 entities, fanOut 147, 4,980 LOC; it is the only src package over minFiles without an existing god-package task (modules/sidebar, the other file-count breach, is a completed task with its residual recorded, and shared/api shrank to 9 files / 50 entities).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795261634268` · ts `2026-11-21T11:47:14.268Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ChatComposer`、`ComposerMenuPrimitives`、`CommandMenu`、`Confirmation`、`PromptInput`、`useScheduledMessages`
- 涉及文件：
- `src/modules/chat-composer/composer/ChatComposer.tsx:1`
- `src/modules/chat-composer/composer/ComposerMenuPrimitives.tsx:13`
- `src/modules/chat-composer/composer/Confirmation.tsx:60`
- `src/modules/chat-composer/composer/PromptInput.tsx:33`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Move the menu/confirm primitives (ComposerMenuPrimitives, CommandMenu, ComposerModelMenu, ComposerPermissionMenu, ComposerMobileMoreMenu, Confirmation) into a composer/menus leaf; AC: fileCount <= 19, chat-composer and chat tests green, frontend-import-cycle-budget groups match or shrink.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-21T11:47:14.268Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `god-package-src-chat-composer-composer`（routine `architecture-analysis`，runId `architecture-analysis-1795261634268`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/chat-composer/composer/ChatComposer.tsx`
- `src/modules/chat-composer/composer/ComposerMenuPrimitives.tsx`
- `src/modules/chat-composer/composer/Confirmation.tsx`
- `src/modules/chat-composer/composer/PromptInput.tsx`
- `tasks/gap-routine-architecture-analysis-god-package-src-chat-composer-composer.md`