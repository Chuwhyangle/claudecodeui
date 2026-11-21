---
id: gap-routine-architecture-analysis-god-package-src-chat-composer-composer
title: "architecture-analysis: archguard_detect_god_packages(scope=src) flags
  modules/chat-composer/composer with tooManyFiles: 24 direct files (threshold
  20), 37 entities, fanOut 147, 4,9"
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

## Disposition
复核结论：**修掉**。`src/modules/chat-composer/composer` 的 5 个 menu/confirm 原语搬进单向叶子
`src/modules/chat-composer/composer/menus/`：`ComposerMenuPrimitives.tsx`、`CommandMenu.tsx`、
`ComposerModelMenu.tsx`、`ComposerPermissionMenu.tsx`、`Confirmation.tsx`。根包只 `root -> menus` 单向依赖
（`ChatComposer`、`PermissionRequestsBanner`、`ScheduleMessagePopover`、`ComposerMobileMoreMenu` 从新路径 import；
menus 内文件不 import 任何 composer 根文件），因此没有新增目录 SCC。

`ComposerMobileMoreMenu` 有意留在根：它组合的是根里的 `PromptInputButton`（PromptInput.tsx）、
`ScheduleMessagePopover`、`TokenUsageSummary`；把它搬进 menus 会让 menus -> 根成形，闭合 `root <-> menus`
目录环，而 `frontend-import-cycle-budget` 是 shrink-only 棘轮。搬走其余 5 个已使 fileCount 达标（24 -> 19，
阈值 20 在 >=20 触发），故不动它。`PromptInput.tsx` 声明在 Touches 内但未改动。

Before/after 读数（同一个 instrument：本 worktree 上
`node ~/.claude/plugins/npm-cache/node_modules/@yalehwang/archguard/dist/cli/index.js analyze -s src --lang typescript --work-dir /tmp/ag-chatcomposer-{before,after} --no-cache -c 32`，
再 `query --scope src --package-stats`；fan 读数用同 dist 的 `computePackageFanMetricsFromRelations` 读 arch.json 的 relations，
口径与 finding 的 fanOut 147 逐字吻合）：

- fileCount: 24 -> 19（目标 <= 19；`evaluateGodPackages` 在 fileCount >= 20 触发）
- entityCount: 37 -> 25；新叶子 `composer/menus` files=5 entities=12
- fanOut: 147 -> 116；新叶子 fanIn=12 fanOut=43（**残余**：拆目录只是把包内关系变成跨包，耦合被叶子继承，不声称 relation 维度转绿）
- LOC 4,980 为拆分前根包读数；本次只做文件搬迁，无内容改写

验证：
- `npx tsc --noEmit -p tsconfig.json` exit 0
- `npx oxlint src/modules/chat-composer src/modules/chat/tests/composerModelProviderOption.test.tsx` exit 0（仅存量 warning）
- `npx vitest run src/modules/chat-composer src/modules/chat`：169 test files / 1509 passed / 1 skipped（exit 0）
- `tsx --test server/shared/tests/frontend-import-cycle-budget.test.ts server/shared/tests/architecture-ratchet.test.ts`：21 pass（目录 SCC 组仍为既有 3 组，module SCC 仍为空，无新组/新成员；architecture-ratchet 无新读数）

## ADR-007 dark axis
- L_G archguard: cycles=0 (scope=src, post-split worktree; `query --scope src --cycles` -> "No dependency cycles detected")

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `god-package-src-chat-composer-composer`（routine `architecture-analysis`，runId `architecture-analysis-1795261634268`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/chat-composer/composer/ChatComposer.tsx`
- `src/modules/chat-composer/composer/ComposerMobileMoreMenu.tsx`
- `src/modules/chat-composer/composer/ScheduleMessagePopover.tsx`
- `src/modules/chat-composer/composer/PermissionRequestsBanner.tsx`
- `src/modules/chat-composer/composer/PromptInput.tsx`
- `src/modules/chat-composer/composer/menus/ComposerMenuPrimitives.tsx`
- `src/modules/chat-composer/composer/menus/CommandMenu.tsx`
- `src/modules/chat-composer/composer/menus/ComposerModelMenu.tsx`
- `src/modules/chat-composer/composer/menus/ComposerPermissionMenu.tsx`
- `src/modules/chat-composer/composer/menus/Confirmation.tsx`
- `src/modules/chat-composer/index.ts`
- `src/modules/chat/tests/composerModelProviderOption.test.tsx`
- `tasks/gap-routine-architecture-analysis-god-package-src-chat-composer-composer.md`