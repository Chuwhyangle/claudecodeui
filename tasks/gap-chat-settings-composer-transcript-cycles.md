---
id: gap-chat-settings-composer-transcript-cycles
title: Break chat↔settings and composer↔transcript import cycles in src
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F2（架构校准报告 2026-10-20，ArchGuard 0.1.40 加独立源码扫描，HEAD `abc2b5ed9`）：`src` 的 feature 缠结里有两组子环——`chat ↔ settings` 与 `chat/composer ↔ chat/transcript`。

度量（在 F1 那个 42 包 SCC 之内）：`modules/chat` 参与 9 条出边与 3 条入边的内部包边；`modules/settings` 为 10 出 / 6 入。子环：`chat/composer → chat/transcript → chat/composer`。

已验证的边：
- `src/modules/chat/hooks/useUiNavigate.ts:3` 与 `src/modules/chat/hooks/useUiStateResponder.ts:3` 导入 `@/modules/settings`（`readMcpNavigationPolicy`、`writeMcpNavigationPolicy`、`readDeviceName`）。
- `src/modules/settings/tabs/agents-settings/sections/content/ModelsContent.tsx:4` 导入 `@/modules/chat`（`ModelLibraryPanel`）。
- `src/modules/settings/tabs/VoiceSettingsTab.tsx:7` 导入 `@/modules/chat`（`useVoiceClientAsrStatus`）。
- `src/modules/chat/composer/ActivityIndicator.tsx:8` → `@/modules/chat/transcript/ActivityDockPanel`。
- `src/modules/chat/transcript/ChatMessagesPane.tsx:26` → `@/modules/chat/composer/ActivityIndicator`；`ProviderSelectionEmptyState.tsx:25-26` → `@/modules/chat/composer/{ModelGroupList,ResidentConsentNotice}`。
- `src/modules/chat/transcript/ActivityDockPanel.tsx:44,49` → `@/modules/chat/hooks/{useSessionActivity,useActivityControls}`。
- `src/modules/chat/export/TranscriptExportDocument.tsx:9-10` → `@/modules/chat/transcript/{MessageComponent,WorkSegmentRecord}`。
- `src/modules/chat/utils/chatExport.ts:11-12` → `@/modules/chat/export/buildTranscript{Html,Markdown}`。

为什么重要：settings 与 chat 都是大 feature，互相导入意味着二者谁也无法被单独懒加载或单独测试，settings 的「模型库」面板会把整个 chat barrel 拖进来；composer/transcript 互相导入则让目录拆分失去意义，两半实际是一个单元。

改法（报告给出的 remediation）：把共享的 policy 读取（`readMcpNavigationPolicy`、`writeMcpNavigationPolicy`、`readDeviceName`）移到 `shared/`；settings 的 chat 部件改为导入具体组件路径（如 `@/modules/chat/modals/ModelLibraryPanel`）或经一个小的 `chat/public` 面导出；composer↔transcript 由把 `ActivityIndicator` / `ActivityDockPanel` 移进中性的 `chat/activity` 包来打破。`chat/export ↔ chat/transcript` 那两条边属同一 feature 内的另一个子环，不在本条验收范围内。

<!-- dedup-ref --> 相关但不同机制：`gap-mcp-ui-focus-turn-show-diff-open-task`（done）给 `useUiNavigate.ts` 增加了 turn/diff/task 三类导航目标，属于该 hook 的功能扩展，不是打破 `chat↔settings` 导入环。与本批 `gap-src-shared-feature-layering-inversion` 相关但独立验收：那条治 `shared→feature` 反向依赖（含 `readDeviceName` 迁往 `shared`），本条治两个 feature 之间的双向导入；两者都涉及 `src/modules/settings/hooks/useMcpNavigationSettings.ts`，调度器按 Touches 串行。去重检索实测：`composer 环` → 0，`useUiNavigate` 的命中均为导航功能任务（done），无任何任务以打破这两组环为机制。

## AC

- [ ] `test -z "$(grep -rn "from '@/modules/settings'" src/modules/chat --include='*.ts' --include='*.tsx')"`：`chat` 对 `@/modules/settings` 的生产导入为 0（立案时 2 条），命令退出 0。
- [ ] `grep -rn "from '@/modules/chat'" src/modules/settings --include='*.ts' --include='*.tsx' | grep -v '/tests/'` 返回 0 命中（立案时 2 条生产命中：`ModelsContent.tsx:4`、`VoiceSettingsTab.tsx:7`），命令退出 0。
- [ ] 双向各 0：`grep -rn "@/modules/chat/transcript" src/modules/chat/composer --include='*.ts' --include='*.tsx'` 与 `grep -rn "@/modules/chat/composer" src/modules/chat/transcript --include='*.ts' --include='*.tsx'` 各返回 0 命中；`ActivityIndicator` / `ActivityDockPanel` 的新位置在 `src/modules/chat/activity/` 下（贴出两个文件路径）。
- [ ] 结构读数（外部工具）：新鲜 `archguard_detect_cycles(outputScope=package)` 在 `src` 上不再报告同时含 `modules/chat/composer` 与 `modules/chat/transcript` 的 SCC。贴出该 SCC 的前后成员清单。该读数为 ArchGuard MCP 查询（待外部）。
- [ ] 既有导航判据不改一字仍绿：`npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 退出 0，贴出 `Test Files / Tests` 读数。
- [ ] `npm run typecheck` 退出 0，`npm run lint` 退出 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「两块 feature 谁都不再需要对方参与就能构建/测试」，不是「改成深路径导入」。必须贴出：①四条 grep 的前后计数（chat→settings 2→0、settings→chat 2→0、composer↔transcript 双向→0）；②`ActivityIndicator` / `ActivityDockPanel` 新路径与被改写的 import 行原文；③settings 两个 chat 部件的 import 行原文，证明它们取具体路径或 `chat/public`，而不是整个 barrel；④policy 读取（`readMcpNavigationPolicy` / `writeMcpNavigationPolicy` / `readDeviceName`）在 `shared/` 下的新实现与 `chat` 侧 import 行；⑤`uiNavigate.test.tsx` 的 `Test Files / Tests` 读数与 ArchGuard SCC 前后成员；⑥typecheck / lint 退出码；⑦取假形态：把 `ActivityIndicator.tsx` 临时移回 `composer/` 并让 transcript 再导入它 ⇒ 双向 AC 红，还原后复绿，附两次读数。

## Touches

- src/shared/mcpNavigationPolicy.ts (new)（`readMcpNavigationPolicy` / `writeMcpNavigationPolicy` / `readDeviceName` 的共享实现）
- src/shared/index.ts（导出共享 policy 读取）
- src/modules/settings/hooks/useMcpNavigationSettings.ts（policy 实现迁出）
- src/modules/settings/index.ts（转出口改指 `@/shared`）
- src/modules/chat/hooks/useUiNavigate.ts（改为从 `@/shared` 取 policy）
- src/modules/chat/hooks/useUiStateResponder.ts（同上）
- src/modules/settings/tabs/agents-settings/sections/content/ModelsContent.tsx（改为具体路径或 `chat/public`）
- src/modules/settings/tabs/VoiceSettingsTab.tsx（同上）
- src/modules/chat/composer/ActivityIndicator.tsx（移入 `chat/activity`，此处保留薄转出口或删除）
- src/modules/chat/transcript/ActivityDockPanel.tsx（移入 `chat/activity`）
- src/modules/chat/activity/index.ts (new)（`chat/activity` 的 barrel）
- src/modules/chat/transcript/ChatMessagesPane.tsx（改为从 `chat/activity` 取）
- src/modules/chat/transcript/ProviderSelectionEmptyState.tsx（改为从 `chat/activity` 或具体路径取）
- src/modules/chat/tests/uiNavigate.test.tsx（既有导航判据，不改一字，作覆盖）
- tasks/gap-chat-settings-composer-transcript-cycles.md (self)
