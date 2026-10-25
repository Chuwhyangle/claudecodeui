---
id: gap-chat-suggestion-chips-share-the-empty-textarea-line
title: Chat 建议 chip：与空 textarea 叠在同一格，chip 上方不留空行；左侧留 44px 穿透区便于点击唤起键盘
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 接续 `gap-chat-suggestion-chips-empty-textarea-reserves-two-rows`（done，空 textarea 改 `rows=1`）与 `gap-chat-suggestion-chips-single-row-swipe-on-narrow`（done，窄屏单行 + 虚线统一），机制不同：前者把 textarea 从 64px 压到 40px，但 chip 行仍在 textarea **下方**的 flow 行里，上方留下一条 40px 的纯空白行（用户 2026-10-25 截图反馈）；本任务改成 chip 与空 textarea **叠在同一格**。kept separate：前两个任务已 done，本任务只改布局摆法，不改 `rows=1`、单行滑动、虚线外框。

现状读数（2026-10-25，隔离实例，手机 390×844 与 PC 1440×900）：有 chip、输入为空时 textarea 40px（`rows=1`，无 placeholder，纯空白），chip 行 top 比输入体 top 低 40px，手机输入区 149px。原设计里「chip 与输入框顶边之间没有 ≥1 行空白」的要求被 ≤44px 的验收数字放过了（40px 恰好是一行），这是上一个任务的设计缺陷。

做法：
- **同格重叠。** 输入体里把 textarea 与 chip 条放进同一个 CSS grid 单元格（同一 `grid-area`），单元格高度 = max(textarea 高度, chip 行高度)。空输入且 chip 显示时，chip 占在 textarea 那一行里，上方没有空行；PC 上 chip 换成多行时，格高随 chip 行增长，textarea 在同一格里被盖在下面。输入非空 / 无 chip 时恢复现有布局，不改。
- **左侧 44px 穿透区。** chip 条不再整块盖住 textarea：chip 滚动区（窄屏 `overflow-x-auto` 的 listbox）从左侧让出 44px，这块区域**不属于任何元素、`pointer-events: none`**，点击直接落到下面的 textarea 上（原生点击聚焦，手机弹出键盘；长按可唤出粘贴菜单）。该占位必须在滚动区**之外**（固定，不随 chip 横向滑动而滑走）。PC 同样让出 44px（用户裁定「PC 也加宽」），整个组件用同一个常量。
- textarea 左内边距保持 16px，使聚焦后的光标落在这块穿透区内闪烁，作为「已进入输入状态」的反馈；**不加图标、不加文字提示**。
- 不再依赖 `onBackgroundPress` 的程序化 `focus()`（iOS 上不一定弹键盘）作为主路径；chip 之间的缝隙与右侧空位仍可保留该回调作兜底，但穿透区靠原生点击。
- 不改：chip 的填入/聚焦行为、键盘选择（Tab/Enter/Esc）、窄屏单行滑动、PC 换行与 `line-clamp-2`、虚线外框、quoted chip 内嵌形态。窄屏 chip 可视宽度因此从约 372px 降到约 328px，第一个 chip（约 234px）仍应完整显示、第二个露出一截提示可滑。

## AC

- [x] `npx vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 含一例：空输入且有 chip 时，textarea 与 chip 条是同一个 grid 容器的子元素，并落在同一格（相同的 `grid-area` / `col-start-1 row-start-1` 类名或等价断言）；输入非空时 chip 条不渲染、textarea 独占布局；exit 0。取假：把 chip 条放回 textarea 之后的 flow 行，该例必须红。
- [x] 同一文件含一例：chip 滚动区的左侧让出量取自导出的单一常量（值为 44），且该占位元素不在滚动容器内部、含 `pointer-events-none`；窄屏与宽屏读同一个常量；exit 0。取假：把占位挪进滚动容器或改成可点击元素，该例必须红。
- [x] `npx vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/suggestionChipAcceptContract.test.tsx src/modules/chat/tests/inlineQuoteChip.test.tsx` exit 0，且这些文件里已有的 `expect` 没有被删减或放宽（`git diff` 只允许新增，或因布局改变而同步改写、并在提交说明里逐条列出）。
- [x] 源码里不再依赖「flow 行在 textarea 之后」：`git grep -n "flow row" -- src/modules/chat/composer/ChatComposer.tsx || true` 不再含描述旧摆法的注释（注释须改写为同格重叠）。
- [x] `npx tsc --noEmit -p tsconfig.json` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：隔离实例（`scripts/isolated-instance.sh`，用本任务分支构建，不碰 live 的 `dist`）里 MCP 浏览器打开末尾带 model 回复 chip 的真实会话，手机 390×844 与 PC 1440×900 各截图存 `tmp/` 并贴出，并用 `browser_evaluate` 贴出读数：
(a) 空输入且有 chip 时，输入体高度 ≤ chip 行高度 + 底部 padding（手机目标：`.chat-composer-shell` 由 149px 降到约 109px，推算值以实测为准），chip 行 top 与输入体 top 之差 ≤ 8px（修复前 40px）；
(b) `document.elementFromPoint` 取穿透区中心点（chip 条左侧 0–44px 内）命中的是 `textarea`，而不是 chip 条或其子元素；
(c) 手机视口下用真实触摸点击穿透区，`document.activeElement` 为 textarea（键盘弹起的真机确认另见下一条）；光标在穿透区内可见；
(d) 窄屏横向拖动 chip 滚动区，穿透区保持不动，`scrollLeft` 变化；第一个 chip 完整可见；
(e) 键入一个字后 chip 消失、textarea 正常增长；清空后回到 chip 与 textarea 同格；
(f) PC 上 chip 多行时格高随之增长，穿透区仍命中 textarea。
**真机确认（外层验证）：** 手机真机点击穿透区能弹出软键盘、长按能唤出粘贴菜单（外层验证，由人在真机完成，worker 不得代为勾选）。fixture 单测只是必要条件，不算落地。

## Touches

- src/modules/chat/composer/InputSuggestionChips.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/InlineQuoteChip.tsx
- src/modules/chat/tests/inputSuggestionsComposer.test.tsx
- src/modules/chat/tests/chatComposerReplyChips.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- src/modules/chat/tests/inlineQuoteChip.test.tsx
- tasks/gap-chat-suggestion-chips-share-the-empty-textarea-line.md
