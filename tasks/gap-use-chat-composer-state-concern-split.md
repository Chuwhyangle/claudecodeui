---
id: gap-use-chat-composer-state-concern-split
title: useChatComposerState 按关注点切分：10 个关注点（草稿/附件/命令/语音插入/投递/文本框交互…）拆成 6 个内聚
  hook（以 useInputHistory 为样板），只留组合
status: todo
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

- [ ] (a) **6 个子 hook 存在且被引用**：`test -f src/modules/chat/hooks/useDraftState.ts -a -f src/modules/chat/hooks/useAttachmentState.ts -a -f src/modules/chat/hooks/useCommandMenuState.ts -a -f src/modules/chat/hooks/useVoiceInsertionState.ts -a -f src/modules/chat/hooks/useSendDeliveryState.ts -a -f src/modules/chat/hooks/useTextareaInteractionState.ts` 退出 0；`grep -qE "useDraftState|useAttachmentState|useCommandMenuState|useVoiceInsertionState|useSendDeliveryState|useTextareaInteractionState" src/modules/chat/hooks/useChatComposerState.ts` 退出 0。
- [ ] (b) **中心文件瘦身**：`test "$(wc -l < src/modules/chat/hooks/useChatComposerState.ts)" -lt 1697` 退出 0（基线=立案实测 1697）。
- [ ] (c) **既有行为判据不改一字仍绿**：窄跑 `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/composerDraftScoping.test.tsx src/modules/chat/tests/promptInputSubmit.test.tsx src/modules/chat/hooks/useInputHistory.test.ts` 退出 0（若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「10 个关注点各归其位进了内聚 hook、useChatComposerState 只留组合、输入框行为不变」，不是「多了 6 个文件」。必须贴出：①(a) 6 个子 hook 各自的 state/操作清单与组合层的调用行；②(b) `wc -l` 前后读数；③(c) 既有判据单跑退出码；④(d) typecheck/lint/build:client；⑤**UI 验证（强制）**：(i) MCP 浏览器在真实运行页面上亲手走一遍输入框的改动涉及交互（历史导航 ArrowUp/Down、草稿恢复、附件增删、命令菜单、语音插入、发送失败重试），截图存 `tmp/` 并贴出；(ii) 存在覆盖此功能的场景时跑 `node scripts/ui-scenario.mjs <scenario.json> …` 并贴 JSON 报告与检查点截图，无覆盖场景则说明并靠 MCP 浏览器验证；⑥纯位移核对（对外 API 未变，行为语义未变；无法原样迁的状态逐条列出原因）；⑦`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

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
