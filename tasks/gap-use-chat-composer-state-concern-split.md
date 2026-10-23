---
id: gap-use-chat-composer-state-concern-split
title: useChatComposerState 按关注点切分：10 个关注点（草稿/附件/命令/语音插入/投递/文本框交互…）拆成 6 个内聚
  hook（以 useInputHistory 为样板），只留组合
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-23）**：机制词 grep → 命中 `gap-chat-utils-partition`（done，把 `chat/utils` 切成 voice/transcript/session 子包，是「按关注点切分 chat 目录」的样板，但对象是 utils 不是 hooks）；其余命中均为行为任务。**「把 useChatComposerState 按关注点切成内聚 hook」无人认领**。granularity 报 peer `gap-composer-empty-box-history-frequency-chips`（ready，共享 useChatComposerState.ts）——机制不同（它加空态建议 chips 行为，本条拆状态组织），调度器串行，判定 **separate**。

### 现状（立案时实测）

- `src/modules/chat/hooks/useChatComposerState.ts` = **1697 行**，混装 **10 个关注点**（state/ref 清单实测）：编辑锚点（`editingAnchorId`）、输入文本+scope（`inputState`）、附件（`attachedFiles`/`fileErrors`）、文本框自动扩高+高亮（`isTextareaExpanded`/`textareaLineHeight`/`lastAutosizedInput`/`inputHighlight`）、命令菜单（`commandModalPayload`）、投递失败（`sendFailed`/`pendingDeliveryRef`/`undeliveredTurnRef`）、语音插入（`voiceRange`/`voiceInsertionRef`）、草稿队列（`queuedDraft`/`draftScopeRef`/`queuedDraftSessionRef`）、IME 组合（`isComposingRef`/`lastCompositionEndAtRef`）、焦点（`isInputFocused`）。
- 同目录反例（证明能做到内聚）：`useInputHistory.ts` = **195 行**，历史栈/游标/草稿恢复 + 操作 + 不变量全在一个 hook 里。
- 同目录还有两个 god hook：`useChatSessionState.ts` 2127 行（15 state/38 ref）、`useSessionStore.ts` 2279 行——本条先只切 useChatComposerState，那两刀另立。

### 改法

把 useChatComposerState 按关注点切成 **6 个内聚 hook**（以 useInputHistory 为样板：状态 + 操作 + 不变量共置），useChatComposerState 只留组合：
1. `useDraftState`（草稿队列）
2. `useAttachmentState`（附件 + 校验）
3. `useCommandMenuState`（命令菜单开/关/选择）
4. `useVoiceInsertionState`（语音插入/回填）
5. `useSendDeliveryState`（投递失败重试/清空）
6. `useTextareaInteractionState`（输入文本 + IME + 自动扩高 + 焦点 + 高亮）

⛔ 前端护栏：新文件落 `src/modules/chat/hooks/`（同目录）；类型用 `type` 不用 `interface`；`@/` 别名；每个子 hook 的对外 API 只暴露组合层需要的最小面。

<!-- dedup-ref --> 相关但不同机制：`gap-chat-utils-partition`（done）是同目录切分的样板（utils 层）；`gap-composer-empty-box-history-frequency-chips`（ready）与本条共享 useChatComposerState.ts、机制不同（行为 vs 状态组织），调度器串行，理想顺序本条先落地（切分后 chips 任务的改动落点更清楚），非硬约束。两者均不构成本条前置。

## Plan

1. **盘点**：把 1697 行的 state/ref/callback 逐条归类到 6 个关注点，标每个的读写点与不变量。
2. **先拆独立的**（draft / attachment / command / voice / send-delivery 五个互不依赖）。
3. **再拆文本框交互**（inputState / IME / autosize / focus / highlight 耦合最紧，最后拆）。
4. **组合层**：useChatComposerState 只调用 6 个子 hook 并组装对外 API（对 ChatComposer 的公开签名不变）。
5. **判据 + UI 验证 + 收口**。

## AC

- [x] (a) **6 个子 hook 存在且被引用**：`test -f src/modules/chat/hooks/useDraftState.ts -a -f src/modules/chat/hooks/useAttachmentState.ts -a -f src/modules/chat/hooks/useCommandMenuState.ts -a -f src/modules/chat/hooks/useVoiceInsertionState.ts -a -f src/modules/chat/hooks/useSendDeliveryState.ts -a -f src/modules/chat/hooks/useTextareaInteractionState.ts` 退出 0；`grep -qE "useDraftState|useAttachmentState|useCommandMenuState|useVoiceInsertionState|useSendDeliveryState|useTextareaInteractionState" src/modules/chat/hooks/useChatComposerState.ts` 退出 0。
- [x] (b) **中心文件瘦身**：`test "$(wc -l < src/modules/chat/hooks/useChatComposerState.ts)" -lt 1697` 退出 0（基线=立案实测 1697）。
- [x] (c) **既有行为判据不改一字仍绿**：窄跑 `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/composerDraftScoping.test.tsx src/modules/chat/tests/promptInputSubmit.test.tsx src/modules/chat/tests/useInputHistory.test.ts` 退出 0（原列的 `src/modules/chat/hooks/useInputHistory.test.ts` 已漂移——实测该文件在 `src/modules/chat/tests/`；按本条授权用等价判据替换并在此记录。四个文件均未改一字）。
- [x] (d) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「10 个关注点各归其位进了内聚 hook、useChatComposerState 只留组合、输入框行为不变」，不是「多了 6 个文件」。必须贴出：①(a) 6 个子 hook 各自的 state/操作清单与组合层的调用行；②(b) `wc -l` 前后读数；③(c) 既有判据单跑退出码；④(d) typecheck/lint/build:client；⑤**UI 验证（强制）**：(i) MCP 浏览器在真实运行页面上亲手走一遍输入框的改动涉及交互（历史导航 ArrowUp/Down、草稿恢复、附件增删、命令菜单、语音插入、发送失败重试），截图存 `tmp/` 并贴出；(ii) 存在覆盖此功能的场景时跑 `node scripts/ui-scenario.mjs <scenario.json> …` 并贴 JSON 报告与检查点截图，无覆盖场景则说明并靠 MCP 浏览器验证；⑥纯位移核对（对外 API 未变，行为语义未变；无法原样迁的状态逐条列出原因）；⑦`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Evidence

**① 六个子 hook 的 state/操作清单与组合层调用行**

| hook | 拥有的状态 | 操作 / 不变量 |
| --- | --- | --- |
| `useTextareaInteractionState.ts` (233 行) | `inputState{scope,value}`、`input`、`inputValueRef`、`textareaRef`、`inputHighlightRef`、`textareaLineHeightRef`、`lastAutosizedInputRef`、`isTextareaExpanded`、`isInputFocused`、`isComposingRef`/`lastCompositionEndAtRef`、`draftScope`/`draftScopeRef`、`sessionKey`/`sessionKeyRef` | `setInput`（文本与 scope 锁步写入）、draft mirror 的读/写/跨设备订阅（4 支 effect 顺序原样）、`resizeTextarea`、`syncInputOverlayScroll`、`isImeComposing`（Safari `compositionend` 30ms 窗）、`handleInputFocusChange` |
| `useAttachmentState.ts` (134 行) | `attachedFiles`、`fileErrors` | `handleAttachmentFiles`（10MB / 10 个上限校验）、`handlePaste`、`useDropzone` wiring；导出 `uploadAttachmentFiles` / `isImageAttachment` 供发送路径复用 |
| `useCommandMenuState.ts` (305 行) | `commandModalPayload` + `useSlashCommands` 整组读数 | `executeCommand`（builtin/custom）、`handleBuiltInCommand`（help/models/cost/status/memory/config）、`handleCustomCommand`（bash 确认 + 下一 tick 提交）、`closeCommandModal`、`showCostModal`；提交经注入的 `submit` 回调，不反向依赖发送路径 |
| `useVoiceInsertionState.ts` (121 行) | `voiceInsertionRef`、`voiceRange` | `handleVoiceListeningStart`、`handleVoiceTranscript`（范围内替换 / 无范围时追加，`send` 时提交）、`remapVoiceRangeOnEdit`（编辑穿行重映射，不匹配即丢弃范围） |
| `useDraftState.ts` (145 行) | `queuedDraft`、`queuedDraftSessionRef` | `editQueuedDraft`、`deleteQueuedDraft`、`setQueuedDraft`；三支 effect 原序（reconcile 5s → 持久化 → 切会话换入；持久化必须在换入之前） |
| `useSendDeliveryState.ts` (105 行) | `sendFailed`、`pendingDeliveryRef`、`undeliveredTurnRef` | `beginDelivery`（建机器、占槽、清失败标记、`begin`；settle 前先清槽）、`subscribe` 帧答机器、卸载 dispose |

组合层调用行（`useChatComposerState.ts`）：`useTextareaInteractionState` 第 213 行、`useVoiceInsertionState` 第 245 行、`useAttachmentState` 第 248 行、`useSendDeliveryState` 第 263 行、`useCommandMenuState` 第 266 行、`useDraftState` 第 292 行。

**② 行数前后**：`useChatComposerState.ts` 立案基线 1697 → 本 worktree 开工实测 1763（develop 已增长）→ 切分后 **1126**；6 个新 hook 合计 1043 行。

**③ 既有判据单跑（不改一字）**：`npx vitest run chatComposerResponsive.test.tsx composerDraftScoping.test.tsx promptInputSubmit.test.tsx useInputHistory.test.ts` → `Test Files 4 passed (4) / Tests 35 passed (35)`，退出 0。另跑 composer 相关 22 个既有文件（occupiedSessionReadOnly / composerCompactTier / composerNewSessionSelection / composerToolsSettingsResolution / inputSuggestionsComposer / residentComposerEnableAffordance / sendOnEnter / escapeAbortGuard / chatInterfaceEscapeAbort / liveVoiceMicPrewarmEntry / liveVoiceNewSessionEntry / voiceClipPlayback / voiceEditLabelsHook / voiceEntryNewSessionSelection / voiceModePermissionBanner / voiceErrorNoticePersistence / voiceTranscriptRepair / sendDelivery / sessionPermissionMode / chatMessageLocate / forkFromAssistantReply / activityIndicatorResponsive）→ `Test Files 22 passed (22) / Tests 147 passed (147)`，退出 0。

**④ 静态门**：`npx tsc --noEmit -p tsconfig.json` 退出 0；`npm run lint` 退出 0（新文件只剩与原件同源的 react-hooks/react 告警，无 error）；`npm run build:client` 退出 0（`built in 23.98s`）。

**⑤ UI 验证**：本实例没有 MCP 浏览器工具，按仓库既有做法用一次性 Playwright spec（跑完已删除，未进提交）在真实 Chromium + 真实后端 + 本 worktree 的 Vite 上驱动，截图存 `tmp/`：

- `tmp/composer-01-empty.png` 空输入框
- `tmp/composer-02-draft-typed.png` 键入草稿（`DRAFT_SCOPES ["project:1f9dda12-…"]`：草稿按 composer 自己的 scope 落盘）
- `tmp/composer-03-draft-restored.png` 刷新后 `DRAFT_RESTORED "draft that must survive a reload"`（`useTextareaInteractionState` 的 draft mirror）
- `tmp/composer-04-history-recall.png` 种入历史后 ArrowUp/ArrowDown：`HISTORY_UP "first sent message"`、`HISTORY_DOWN_DRAFT_RESTORED ""`（切分后 `useInputHistory` 仍工作）
- `tmp/composer-05-command-menu.png` 输入 `/` 弹出菜单 `COMMAND_MENU_OPTIONS 6`，Escape 关闭（`useCommandMenuState`）
- `tmp/composer-06-attachment-added.png` `ATTACHMENT_ADDED true` / `ATTACHMENT_REMOVED true`（`useAttachmentState` 的加/删）
- `tmp/composer-07-send-failed.png`、`tmp/composer-08-send-retried.png` 发送路径尝试；如实记录：离线态下第一次点击卡在会话分配（`createChatSession`）而没走到 delivery 机器，所以「失败 dock」这一格没有在该探针里被点亮（`SEND_FAILURE_DOCK false`），草稿 `DRAFT_KEPT_AFTER_FAILURE true`；该状态机的失败分支由 `src/modules/chat/tests/sendDelivery.test.ts` 覆盖，dock 渲染由 `activityDockUnreachable.test.tsx`（`sendFailed: true`）覆盖。
- **语音插入**：探针实例没有 ASR provider，单条口述进不了输入框；改用仓库既有的 composer-embedded 语音判据做真实浏览器验证：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts --workers=1` → `7 passed (1.8m)`，退出 0（7 个用例覆盖 composer 内语音条的 listening/mute/断开/两档视口/模型选择器/leave-vs-stop/待答问题）。日志留在 `tmp/voice-embedded-run.log`。
- **场景运行器**：`e2e/scenarios/` 只有 `quay-wall-focus-pin-utter.json`（Quay 面板焦点钉），`scripts/ui-scenario.mjs` 的 opener 也只有 `quay-panel`，没有覆盖 composer 的场景；按本条 DoD 的后半句以浏览器验证为准。

**⑥ 纯位移核对**：对外 API 逐键比对 develop 与本次 HEAD，双方均 58 个键，missing/extra 均为空。行为语义未变：四支 draft effect 的相对顺序、queued 持久化先于换入、IME 30ms 窗、delivery 先占槽后 `begin` 均原样保留。**未能原样迁走的只有一处**：`editingAnchorId`（编辑锚点）留在组合层——它不在这 6 个关注点清单内，且只被发送路径读写（`chat.edit-send` 帧与 `replacesAnchorId` 回显），迁走反而要把发送路径拆成两半。另 `buildSendOptions` / `handleSubmit` / 权限与 abort 处理同样留在组合层，符合 Plan 第 4 步「只留组合」。

**⑦ `git diff` 只含 Touches**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 恰为 7 个文件（6 个新 hook + 组合层），`anti-drift-touches-check` 报 `ANTI-DRIFT OK … 7 actual file(s), all within declared Touches (12 glob(s))`。运行结束未重启 :3001、未发布。

## Touches

- `src/modules/chat/hooks/useChatComposerState.ts`（按关注点迁出，对外公开签名不变，只留组合）
- `src/modules/chat/hooks/useDraftState.ts` (new)
- `src/modules/chat/hooks/useAttachmentState.ts` (new)
- `src/modules/chat/hooks/useCommandMenuState.ts` (new)
- `src/modules/chat/hooks/useVoiceInsertionState.ts` (new)
- `src/modules/chat/hooks/useSendDeliveryState.ts` (new)
- `src/modules/chat/hooks/useTextareaInteractionState.ts` (new)
- `src/modules/chat/tests/chatComposerResponsive.test.tsx`（既有判据，不改一字，作行为覆盖）
- `src/modules/chat/tests/composerDraftScoping.test.tsx`（既有判据，不改一字，作行为覆盖）
- `src/modules/chat/tests/promptInputSubmit.test.tsx`（既有判据，不改一字，作行为覆盖）
- `src/modules/chat/hooks/useInputHistory.test.ts`（既有判据，不改一字，作行为覆盖）
- `tasks/gap-use-chat-composer-state-concern-split.md`（自触）
