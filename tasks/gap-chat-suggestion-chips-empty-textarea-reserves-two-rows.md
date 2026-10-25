---
id: gap-chat-suggestion-chips-empty-textarea-reserves-two-rows
title: Chat 建议 chip：空输入框预留的两行空白要收掉，chip 紧贴输入框顶部
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> `gap-chat-suggestion-chips-wrap-no-default-preview`（done，提交 `ab8d7f8a5`）的后续修正，不同机制：那次把 chip 从绝对定位改成 textarea 之后的 flow 行，副作用是空 textarea 仍占位，chip 上方出现一大块空白（用户截图反馈，2026-10-25）。kept separate：前任务已 done，本任务只改空态高度。

2026-10-25 在隔离实例 PC 1440×900 实测（截图 `tmp/ux-pc-chip-gap-before.png`）：有 chip、输入为空时，`textarea` 实际高度 64px、`rows` 属性为 2、`style.height` 为 `auto`、`scrollHeight` 64、padding 8/8、line-height 24（即 2×24+16）；placeholder 在有 chip 时被置空（`placeholder={showSuggestionChips ? '' : placeholder}`），所以这 64px 是纯空白；chip 行在其下方（top 756），整个输入体 106px（textarea 64 + chip 42）。`useTextareaInteractionState.ts` 的 `MIN_TEXTAREA_HEIGHT_PX = 22` 无法收窄它：`height:auto` 时浏览器按 `rows=2` 给出 `scrollHeight=64`，`Math.max(22, 64)` 仍是 64。

做法：
- 空输入且 chip 条显示时，textarea 用 `rows={1}`（单行，约 40px 含 padding），chip 行仍作为 flow 行紧随其后——或把 chip 行放到 textarea 之前；两种摆法二选一，要求是 chip 与输入框顶边之间没有 ≥ 1 行的空白。优先选「textarea 单行 + chip 在下」，因为光标/点击落点不变。
- 有字时（`input !== ''`）恢复原有自适应高度，行为不变；清空输入后回到单行。
- 不回退到绝对定位（会重新盖住文字、高度不增长）。点击 chip 行空白处仍聚焦 textarea（`onBackgroundPress`）。
- 无 chip 的空输入保持现状（placeholder 照常显示、高度不变）。

## AC

- [ ] `npx vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 含一例：chip 条显示且输入为空时，textarea 的 `rows` 属性为 1；无 chip 的空输入时 `rows` 不被改成 1（保持原默认）；exit 0。
- [ ] 同一文件含一例：输入框有字时 textarea 的 `rows` 恢复为原值且自适应高度逻辑不变；清空后（chip 再次显示）回到 `rows=1`；exit 0。
- [ ] `npx vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/chatComposerResponsive.test.tsx` exit 0（既有 chip 与响应式用例不被改坏）。
- [ ] `npx tsc --noEmit -p tsconfig.json` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：隔离实例（`scripts/isolated-instance.sh`）里 MCP 浏览器打开末尾带 model 回复 chip 的真实会话，PC 1440×900 与手机 390×844 各截图存 `tmp/` 并贴出，并用 `browser_evaluate` 贴出读数：有 chip、输入为空时 textarea 高度 ≤ 44px（修复前为 64px），chip 行 top 与输入体 top 之差 ≤ 44px；然后在输入框键入多行文字，确认高度正常增长、chip 消失，再清空确认回到单行与 chip。fixture 单测只是必要条件，不算落地。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/PromptInput.tsx
- src/modules/chat/hooks/useTextareaInteractionState.ts
- src/modules/chat/tests/inputSuggestionsComposer.test.tsx
- src/modules/chat/tests/chatComposerReplyChips.test.tsx
- tasks/gap-chat-suggestion-chips-empty-textarea-reserves-two-rows.md
