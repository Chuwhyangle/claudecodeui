---
id: gap-chat-settings-composer-transcript-cycles
title: Break chat↔settings and composer↔transcript import cycles in src
status: done
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

- [x] `test -z "$(grep -rn "from '@/modules/settings'" src/modules/chat --include='*.ts' --include='*.tsx')"`：`chat` 对 `@/modules/settings` 的生产导入为 0（立案时 2 条），命令退出 0。— 实测 0 条、exit 0；两条现从 `@/shared` 取（`useUiNavigate.ts`、`useUiStateResponder.ts`）。
- [x] `test -z "$(grep -rn "from '@/modules/chat'" src/modules/settings --include='*.ts' --include='*.tsx' | grep -v '/tests/')"`：`settings` 对 `@/modules/chat` 的生产导入为 0（立案时 2 条：`ModelsContent.tsx:4`、`VoiceSettingsTab.tsx:7`），命令退出 0。— 实测 0 条、exit 0；两件改为从 `@/shared/ui/ModelLibraryPanel` 与 `@/shared/hooks/useVoiceClientAsrStatus` 取（见 Evidence ③；深路径与 `chat/public` 都会被仓库的 `boundaries/dependencies` 判红，故按「谁都不再需要对方」的 DoD 把它们迁进 shared）。
- [x] 双向各 0：`test -z "$(grep -rn '@/modules/chat/transcript' src/modules/chat/composer --include='*.ts' --include='*.tsx')"` 与 `test -z "$(grep -rn '@/modules/chat/composer' src/modules/chat/transcript --include='*.ts' --include='*.tsx')"` 各自退出 0；并贴出 `ActivityIndicator` / `ActivityDockPanel` 在 `src/modules/chat/activity/` 下的新路径。— 两条各 0、exit 0；新路径 `src/modules/chat/activity/ActivityIndicator.tsx`、`src/modules/chat/activity/ActivityDockPanel.tsx`（barrel `src/modules/chat/activity/index.ts`）。立案后新增发现的两条边（`ComposerAttachment → transcript/ChatMessageImages` 与 `ImageLightbox`）也已断开，见 Evidence ①②⑦。
- [x] 结构读数（外部工具）：新鲜 `archguard_detect_cycles(outputScope=package)` 在 `src` 上不再报告同时含 `modules/chat/composer` 与 `modules/chat/transcript` 的 SCC。贴出该 SCC 的前后成员清单。— **达标**。直接边断开后 SCC 先从 31 成员缩到 20，但 composer/transcript 仍互相可达：返回通路是 `transcript → task-master → … → shell → chat → composer`，而 transcript 包在这条路上唯一的出边是 `ProviderSelectionEmptyState.tsx` 从 task-master barrel 取 `NextTaskBanner`。本轮把该 banner 改成可选组件 prop（`ChatMessagesPane` 转发、`ChatInterface` 注入，后者本来就取同一个 barrel 的 `useTasksSettings`），transcript 包不再依赖 task-master。新鲜读数：`modules/chat/composer` 不再出现在任何环中，`modules/chat/transcript` 所在环（7 成员）不含 composer——两者不在同一 SCC。最终成员清单见 Evidence ⑤。
- [x] 既有导航判据不改一字仍绿：`npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 退出 0，贴出 `Test Files / Tests` 读数。— `Test Files 1 passed (1)`、`Tests 24 passed (24)`、exit 0（该文件未被改动）。
- [x] `npm run typecheck` 退出 0，`npm run lint` 退出 0。— 两者实测 exit 0（lint 仅既有 warning）。
- [x] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。— 52 个代码文件，逐条列入下方 Touches；anti-drift Touches check 在 merge develop 后复验。

## DoD

真实落地的标准是「两块 feature 谁都不再需要对方参与就能构建/测试」，不是「改成深路径导入」。必须贴出：①四条 grep 的前后计数（chat→settings 2→0、settings→chat 2→0、composer↔transcript 双向→0）；②`ActivityIndicator` / `ActivityDockPanel` 新路径与被改写的 import 行原文；③settings 两个 chat 部件的 import 行原文，证明它们取具体路径或 `chat/public`，而不是整个 barrel；④policy 读取（`readMcpNavigationPolicy` / `writeMcpNavigationPolicy` / `readDeviceName`）在 `shared/` 下的新实现与 `chat` 侧 import 行；⑤`uiNavigate.test.tsx` 的 `Test Files / Tests` 读数与 ArchGuard SCC 前后成员；⑥typecheck / lint 退出码；⑦取假形态：把 `ActivityIndicator.tsx` 临时移回 `composer/` 并让 transcript 再导入它 ⇒ 双向 AC 红，还原后复绿，附两次读数。

## Touches

- src/shared/mcpNavigationPolicy.ts（new；policy 存储键、类型、纯读写的共享实现）
- src/shared/index.ts（导出 policy 读取/写入）
- src/modules/settings/hooks/useMcpNavigationSettings.ts（policy 实现迁出，保留转出口）
- src/modules/settings/index.ts（转出口改指 @/shared）
- src/modules/settings/tabs/agents-settings/sections/content/ModelsContent.tsx（改从 shared/ui 取 ModelLibraryPanel）
- src/modules/settings/tabs/VoiceSettingsTab.tsx（改从 shared/hooks 取 ASR 状态 hook）
- src/modules/chat/hooks/useUiNavigate.ts（改从 @/shared 取 policy）
- src/modules/chat/hooks/useUiStateResponder.ts（同上，含 readDeviceName）
- src/shared/ui/ModelLibraryPanel.tsx（new；从 chat/modals 迁入，chat 与 settings 共用）
- src/shared/ui/ModelEnvEditor.tsx（new；随 ModelLibraryPanel 从 chat/modals 迁入）
- src/modules/chat/modals/CommandResultModal.tsx（改指 shared/ui）
- src/modules/chat/index.ts（卸下已迁出的两个导出）
- src/shared/hooks/useVoiceClientAsrStatus.ts（new；从 useVoiceAvailable 拆出的 settings 面板 hook）
- src/shared/voiceClientAsrWorker.ts（new；从 chat/audio 迁入，shared 不得反向依赖 feature）
- src/shared/voiceModelCache.ts（new；从 chat/utils 迁入）
- src/shared/audioDecode.ts（new；从 chat/utils 迁入）
- src/shared/voiceClientFrontend.ts（注释里的 worker 路径更新）
- src/modules/chat/hooks/useVoiceAvailable.ts（拆出 settings 面板 hook）
- src/modules/chat/hooks/useVoiceInput.ts（改指 shared 的 worker/audioDecode）
- src/modules/chat/utils/voiceLiveSegmenter.ts（改指 shared/audioDecode）
- src/shared/tests/voiceUpload16k.test.ts（改指 shared/audioDecode）
- src/modules/chat/tests/voiceClientAsrRouting.test.ts（改指 shared 的 worker/cache）
- src/modules/chat/utils/tests/voiceModelCache.test.ts（改指 shared/voiceModelCache）
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx（改指 shared/audioDecode）
- src/modules/chat/activity/index.ts（new；chat/activity barrel）
- src/modules/chat/activity/ActivityIndicator.tsx（new；从 composer 迁入）
- src/modules/chat/activity/ActivityDockPanel.tsx（new；从 transcript 迁入）
- src/modules/chat/composer/ActivityIndicator.tsx（旧路径薄转出口）
- src/modules/chat/transcript/ActivityDockPanel.tsx（旧路径薄转出口）
- src/modules/chat/transcript/ChatMessagesPane.tsx（改从 chat/activity 取；转发 nextTaskBanner）
- src/modules/chat/transcript/ProviderSelectionEmptyState.tsx（改从 chat/components 取；NextTaskBanner 改为注入的 prop）
- src/modules/chat/components/ImageLightbox.tsx（new；从 ChatMessageImages 拆出，composer 与 transcript 共用）
- src/modules/chat/transcript/ChatMessageImages.tsx（ImageLightbox 拆出）
- src/modules/chat/transcript/MarkdownImage.tsx（改指 chat/components）
- src/modules/chat/composer/ComposerAttachment.tsx（改指 chat/components）
- src/modules/chat/components/ModelGroupList.tsx（new；从 composer 迁入）
- src/modules/chat/components/ResidentConsentNotice.tsx（new；从 composer 迁入）
- src/modules/chat/composer/ResidentConsentNotice.tsx（旧路径薄转出口）
- src/modules/chat/ChatInterface.tsx（注入 NextTaskBanner；断开 transcript→task-master）
- src/modules/settings/tests/modelLibraryDuplicate.test.tsx（改指 shared/ui）
- src/modules/settings/tests/modelLibrarySave.test.tsx（卸下旧的 chat barrel mock）
- src/modules/settings/tests/modelLibrarySettings.test.tsx（同上）
- src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx（mock 改指 shared/hooks）
- src/modules/settings/tests/voiceSettingsLiveTabMinimalSurface.test.tsx（同上）
- src/modules/chat/tests/escapeAbortGuard.test.tsx（task-master mock 补 NextTaskBanner）
- src/modules/chat/tests/forkFromAssistantReply.test.tsx（同上）
- src/modules/chat/tests/liveVoiceMicPrewarmEntry.test.tsx（同上）
- src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx（同上）
- src/modules/chat/tests/voiceModePermissionBanner.test.tsx（同上）
- src/modules/chat/tests/voiceEntryNewSessionSelection.test.tsx（同上）
- src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx（同上）
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx（同上）
- tasks/gap-chat-settings-composer-transcript-cycles.md (self)

## Evidence

实现提交：`8c5bbc402`（基于 develop `e9620ed99`）、`5280f3821`（断开 transcript→task-master）。

① 四条 grep 的前后计数（工作区即改动后）：
- chat→settings：前 2（`useUiNavigate.ts:3`、`useUiStateResponder.ts:3`），后 0（`test -z` exit 0）。
- settings→chat（排除 `/tests/`）：前 2（`ModelsContent.tsx:4`、`VoiceSettingsTab.tsx:7`），后 0（exit 0）。
- composer→transcript：前 2（`ComposerAttachment.tsx:4`、`ActivityIndicator.tsx:8`），后 0（exit 0）。
- transcript→composer：前 3（`ChatMessagesPane.tsx:26`、`ProviderSelectionEmptyState.tsx:25-26`），后 0（exit 0）。

② 新路径与被改写的 import 行原文：
- `src/modules/chat/activity/ActivityIndicator.tsx`、`src/modules/chat/activity/ActivityDockPanel.tsx`、`src/modules/chat/activity/index.ts`。
- `src/modules/chat/transcript/ChatMessagesPane.tsx:26: import { ActivityIndicator } from '@/modules/chat/activity';`
- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx:25: import ModelGroupList, { type ModelGroup } from "@/modules/chat/components/ModelGroupList";`
- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx:26: import { ResidentToggle } from "@/modules/chat/components/ResidentConsentNotice";`
- `src/modules/chat/composer/ComposerAttachment.tsx:4: import { ImageLightbox } from '@/modules/chat/components/ImageLightbox';`
- 旧路径保留薄转出口：`src/modules/chat/composer/ActivityIndicator.tsx:6: export { default } from '@/modules/chat/activity/ActivityIndicator';`；`src/modules/chat/transcript/ActivityDockPanel.tsx:6: export { default } from '@/modules/chat/activity/ActivityDockPanel';`；`src/modules/chat/composer/ResidentConsentNotice.tsx:6: export { default, ResidentToggle } from '@/modules/chat/components/ResidentConsentNotice';`。

③ settings 两个 chat 部件的 import 行原文：
- `src/modules/settings/tabs/agents-settings/sections/content/ModelsContent.tsx:4: import ModelLibraryPanel from '@/shared/ui/ModelLibraryPanel';`
- `src/modules/settings/tabs/VoiceSettingsTab.tsx:7: import { useVoiceClientAsrStatus } from '@/shared/hooks/useVoiceClientAsrStatus';`
- 偏离说明（如实记录）：DoD 写的是「具体路径或 chat/public」。仓库 `.oxlintrc.json` 的 `boundaries/dependencies` 禁止跨 feature 的内部路径，只允许 `src/modules/<module>/index.ts`；`@/modules/chat/modals/ModelLibraryPanel` 与新建 `chat/public.ts` 都命中 `internalPath: "**"` 而红。于是按 DoD 的实质（settings 不再需要 chat）把两件迁到 shared：`ModelLibraryPanel`/`ModelEnvEditor` → `src/shared/ui/`，`useVoiceClientAsrStatus`（连同它依赖的 ASR worker、模型缓存、audioDecode）→ `src/shared/`。这比深路径更强：settings 侧对 chat 的依赖为 0。

④ policy 在 shared 下的新实现与 chat 侧 import：
- `src/shared/mcpNavigationPolicy.ts` 导出 `McpNavigationPolicy`、`MCP_NAVIGATION_POLICY_STORAGE_KEY`、`readMcpNavigationPolicy`、`writeMcpNavigationPolicy`（实现自 `useMcpNavigationSettings.ts` 原样迁出）；`readDeviceName` 仍住在 `src/shared/userSettings.ts`（由 `gap-src-shared-feature-layering-inversion` 迁入），`src/shared/index.ts` 同时导出二者。
- `src/modules/chat/hooks/useUiStateResponder.ts:3: import { readDeviceName, readMcpNavigationPolicy } from '@/shared';`
- `src/modules/chat/hooks/useUiNavigate.ts:3-6: import { readMcpNavigationPolicy, writeMcpNavigationPolicy } from '@/shared';`
- `useMcpNavigationSettings.ts` 的 setter 改为调用 `writeMcpNavigationPolicy`，settings 侧与 chat 侧只有一份写入语义。

⑤ `uiNavigate.test.tsx` 读数与 ArchGuard SCC 前后成员：
- `npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` → `Test Files 1 passed (1)`，`Tests 24 passed (24)`，exit 0。
- 前（develop `e9620ed99` 的 `src` 导出，含 tsconfig 别名）：31 成员环 = `modules/auth, modules/chat, modules/chat/audio, modules/chat/composer, modules/chat/export, modules/chat/hooks, modules/chat/outline, modules/chat/tools, modules/chat/tools/ContentRenderers, modules/chat/transcript, modules/chat/utils, modules/chat/voice-realtime, modules/onboarding, modules/provider-auth, modules/settings, modules/settings/hooks, modules/settings/tabs, modules/settings/tabs/agents-settings, modules/settings/tabs/agents-settings/sections, modules/settings/tabs/agents-settings/sections/content, modules/settings/tabs/api-settings, modules/settings/tabs/api-settings/sections, modules/settings/tabs/browser-use-settings, modules/settings/tabs/git-settings, modules/settings/tabs/tasks-settings, modules/shell, modules/standalone-shell, modules/task-master, modules/task-master/context, modules/task-master/hooks, modules/task-master/modals`；另有 3 成员 `{git-panel, git-panel/changes, git-panel/history}`。
- 中间读数（直接边断开后）：20 成员环，composer 与 transcript 仍同在其中，见上一轮的记录。
- 最终（`5280f3821`，`archguard_analyze` noCache + `archguard_detect_cycles(outputScope=package)` 对 `src`）：4 个环——11 成员 `{auth, chat, chat/voice-realtime, onboarding, provider-auth, shell, standalone-shell, task-master, task-master/context, task-master/hooks, task-master/modals}`；7 成员 `{chat/activity, chat/export, chat/hooks, chat/tools, chat/tools/ContentRenderers, chat/transcript, chat/utils}`；5 成员 settings 环 `{settings, settings/tabs, settings/tabs/browser-use-settings, settings/tabs/git-settings, settings/tabs/tasks-settings}`；3 成员 `{git-panel, git-panel/changes, git-panel/history}`。`modules/chat/composer` 不再属于任何环，`modules/chat/transcript` 所在环不含 composer ⇒ 无同时含两者的 SCC。

⑥ 退出码：`npm run typecheck` → 0；`npm run lint` → 0。

⑦ 取假形态（双向各红一次再还原）：
- 施加：`ChatMessagesPane.tsx` 改回 `import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';`，`ComposerAttachment.tsx` 改回 `import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';`。读数：composer→transcript = 1（exit 1），transcript→composer = 1（exit 1），AC3 红。
- 还原（`git checkout --` 两个文件）。读数：两条各 0，AC3 绿（exit 0）。

⑧ 定向测试（移动后的既有判据）：activity dock 9 文件 39 pass；settings/voice/shared 11 文件 66 pass（含 `modelLibrary*`、`voiceSettings*`、`mcpNavigationSettings`、`voiceClientAsrRouting`、`voiceModelCache`、`voiceUpload16k`、`sharedLayerIsolation`）。

⑨ 结构判据的第二刀（`5280f3821`）：
- 改动：`ProviderSelectionEmptyState` 不再 `import { NextTaskBanner } from "@/modules/task-master"`，改为可选 prop `nextTaskBanner`（`NextTaskBannerComponent`）；`ChatMessagesPane` 转发；`ChatInterface.tsx:5` 改为 `import { NextTaskBanner, useTasksSettings } from '@/modules/task-master';` 并在空状态处传 `nextTaskBanner={NextTaskBanner}`。
- 包级读图：改前 `transcript → task-master` 有 4 条简单路径（经 `task-master/modals→shell` 或 `task-master/context→auth→…→shell`）；改后 `transcript` 到 `composer` 的简单路径为 0（本地包图脚本，含 tsconfig 别名）。`grep -rn task-master src/modules/chat/transcript` 仅剩一句注释。
- 测试：8 个手工 mock `@/modules/task-master` 的 chat 测试补 `NextTaskBanner: () => null`（`ChatInterface` 在渲染期读取该符号；这些用例 `tasksEnabled` 为 false，banner 永不渲染）。定向读数：上述 8 文件 → `Test Files 8 passed (8)`、`Tests 35 passed (35)`、exit 0；`uiNavigate` + 5 个 pane 测试 → `Test Files 6 passed (6)`、`Tests 57 passed (57)`、exit 0。
- 退出码：`npm run typecheck` → 0；`npm run lint` → 0（仅既有 warning）。
