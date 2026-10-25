---
id: gap-chat-suggestion-chips-wrap-no-default-preview
title: Chat 建议 chip：多行换行显示，去掉默认预览行与键盘提示
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

2026-10-25 在 MCP 浏览器（PC 1440×900 / 1000×800、手机 390×844）实测 `src/modules/chat/composer/InputSuggestionChips.tsx`，三处缺陷（截图 `tmp/ux-pc-chat.png`、`tmp/ux-pc-chat-narrow.png`、`tmp/ux-m-chat.png`）：

1. **默认预览行误导。** `previewChip` 在既无悬停也无键盘选中时回退到第一个 model chip（`activeIndex === null` 分支），于是 chip 下方总是多出一行该 chip 的全文、无任何标记，读起来像「已选中」或「输入框里已有内容」。
2. **PC 上后面的 chip 看不到、拖不动。** 列表是 `overflow-x-auto whitespace-nowrap` + `[scrollbar-width:none]`，chip `shrink-0`；1000px 宽时可视 435px、内容 530px，95px 的 chip 被静默裁掉，鼠标没有横向拖动/滚轮的入口（手机靠触摸滑动才可达）。
3. **键盘提示 `Tab to select · Enter to accept · Esc to hide` 常驻占 ~202px**，与 chip 抢同一行宽度，且不会随使用消失。

做法：
- chip 区改为 `flex-wrap` 多行；单个 chip 允许最多两行文本（`line-clamp-2`，不再 `truncate` 成一行），完整文本仍在 `title`。所有 chip 同时可见，不再依赖横向滚动；手机与 PC 用同一套布局。
- 删除预览行（`data-suggestion-preview` 元素、`previewTextFor`、`previewChip`、`showPreview` prop 与 `isCoarsePointer`）；悬停/键盘选中的反馈只靠 chip 自身高亮。
- 删除键盘提示 `<span>` 及三个 `input.suggestions.hint*` 文案键（12 个 locale）；键盘操作（Tab 选择、Enter 接受、Esc 隐藏）行为不变。
- chip 区高度随行数增长时，输入框与 transcript 的布局要跟随（chip 区不再 `absolute` 悬在 textarea 上，或为其预留 flow 行；参考已落地的 `fix(chat): reserve a flow row for the chip strip instead of textarea padding`），不得盖住 textarea 内容。
- 与 `gap-reply-suggestions-chip-row-polish`（done）的一行 chip 约定冲突之处，以本任务为准，同步改掉钉住旧设计的测试。

## AC

- [x] `InputSuggestionChips.tsx` 不再渲染预览行：`npx vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 含一例「无悬停、无选中、有 model chip 时，DOM 中没有 `[data-suggestion-preview]`」，exit 0。
- [x] 同一测试文件含一例：渲染 6 个长文本 chip 时，列表容器 class 含 `flex-wrap`、不含 `overflow-x-auto` 与 `whitespace-nowrap`，且每个 chip 都在 DOM 中；exit 0。
- [x] `npx vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx` exit 0，且该文件不再断言 `previewHint` / `Tab to select` 文案。
- [x] 12 个 `src/modules/i18n/locales/*/chat.json` 均不含 `hintSelect`、`hintAccept`、`hintHide`、`previewHint` 键：`node -e` 逐文件解析 `input.suggestions` 并断言四键不存在，exit 0；locale 键集合一致性检查（仓库既有 i18n parity 测试）exit 0。
- [x] 键盘行为不变：`npx vitest run src/modules/chat/tests/suggestionChipAcceptContract.test.tsx src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 中 Tab 选中、Enter 接受、Esc 隐藏的既有用例全部通过。
- [x] `npx tsc --noEmit -p tsconfig.json` exit 0（删除 prop 后无悬空引用）。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：MCP 浏览器在 PC 1440×900、1000×800 与手机 390×844 三个视口打开一个会话末尾带 model 回复 chip 的真实会话（隔离实例：`scripts/isolated-instance.sh`，挑小 transcript、清 `session_drafts`），截图存 `tmp/` 并贴出，须看到：(a) 所有 chip 同时可见、过长文本折成两行而不是被裁掉；(b) 没有 chip 下方的灰色全文行；(c) 没有 `Tab to select` 提示；(d) 点击任一 chip 仍把文本填入输入框且不发送。再跑 `node scripts/ui-scenario.mjs` 中涉及输入建议的场景（若存在）并贴出 JSON 报告。fixture 单测只是必要条件，不算落地。

## Touches

- src/modules/chat/composer/InputSuggestionChips.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/inputSuggestionsComposer.test.tsx
- src/modules/chat/tests/chatComposerReplyChips.test.tsx
- src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx
- src/modules/chat/tests/suggestionChipAcceptContract.test.tsx
- src/modules/chat/tests/inlineQuoteChip.test.tsx
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- tasks/gap-chat-suggestion-chips-wrap-no-default-preview.md
