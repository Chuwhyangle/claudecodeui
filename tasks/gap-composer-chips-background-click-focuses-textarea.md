---
id: gap-composer-chips-background-click-focuses-textarea
title: 输入框建议 chip 条的空白处点击不聚焦 textarea：listbox 只占 chip 宽度，缝隙与周边空白的按下事件转交给 textarea
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

**症状（人报，随后在真实页面复现）。** 输入框为空、建议 chip 可见时，点击 chip 后面的空白想输入或粘贴文字，没有反应，必须点 chip 下面那一行才行。

**复现读数（隔离实例，真实鼠标点击后输入一个字符，看文字是否进入 textarea）。** 1280px 宽：`listbox` 宽 619px（x 368 至 987），三个 chip 只占 158px（x 368 至 526），右侧 461px 是死区；两个 chip 之间 4px 的缝同样是死区。390px 宽：`listbox` 宽 340px，chip 占 158px，右侧 182px 是死区。各位置点击后的读数：

| 点击位置 | 命中元素 | textarea 获得焦点 | 输入的字符 |
|---|---|---|---|
| chip 上 | chip | 是（填入该 chip） | 正常 |
| chip 之间的缝 | `listbox` | 否 | 丢失 |
| 最后一个 chip 右侧的空白 | `listbox` | 否 | 丢失 |
| 提示文字下方 | textarea | 是 | 正常 |
| chip 行下面那一行 | textarea | 是 | 正常 |

**根因（读代码，已定位）。** `src/modules/chat/composer/InputSuggestionChips.tsx` 里内层 `listbox` 的 class 同时带 `pointer-events-auto` 与 `flex-1`：`flex-1` 让它撑满外层一行的全部剩余宽度，`pointer-events-auto` 又让整块都接收点击。于是一块透明元素盖在 textarea 上方，吃掉点击；它自己的 `mousedown` 既没有聚焦 textarea，也没有交还给 textarea，焦点因此落空。该文件顶部注释写的是「只有 chip 自己接收指针事件」，与实现不一致。单测在 jsdom 里没有布局，测不到这类问题，上一个任务的 DoD 也只要求「点击 chip 能填入」，没有要求「点击 chip 周围空白能聚焦输入框」。

**修复（已在真实页面用临时补丁验证：桌面与 390px 下所有区域都能聚焦并输入，缝隙也能，之前丢失的字符都进了输入框）。**

- `listbox` 去掉 `flex-1`，改为只占内容宽度且可收缩（`flex: 0 1 auto`，保留 `min-w-0` 与 `overflow-x-auto`）。内容超出一行时它收缩到可用宽度并横向滚动，所以窄屏的横向滚动不受影响。验证读数：60 字的长条目下 `scrollWidth` 506 大于 `clientWidth` 340，`scrollLeft` 可设到 80，修复前后一致。
- `listbox` 增加 `onMouseDown`：当 `event.target === event.currentTarget`（点在 chip 之间的缝上）时，调用 `preventDefault` 并通知 composer 聚焦 textarea。chip 自己的 `onMouseDown` 取消默认行为保持不变。
- `InputSuggestionChips` 新增**可选** prop `onBackgroundPress?: () => void`（缺省不报错、什么也不做，不得改成必填，以免逼改既有调用与测试）。`ChatComposer.tsx` 传入 `() => textareaRef.current?.focus()`。

**不用 `pointer-events-none` 的原因：** 窄屏下 `listbox` 要接收触摸拖动才能横向滚动，所以只收缩宽度，不关闭指针事件。

**非目标。** 不改 chip 的可见条件（另一个任务 `gap-composer-chips-visibility-follows-dock-turn-anchor` 在改，Touches 不重叠，可并行）；不改候选来源与排序；不改键盘语义与提示文字。

<!-- dedup-ref --> 相关但不同机制：`gap-composer-empty-box-history-frequency-chips`（chip 本体，已完成）。合并判断：`task-granularity-advice` 对本任务 Touches 返回 peers 为空，改动预计 100 至 200 行（含测试），保持单任务。

## AC

- [ ] 新测试文件通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx` 退出码 0；该文件为下列每条各有一个独立 `it`（一腿一 test）：(a) 在 `listbox` 元素自身上触发 `mousedown`，事件的 `defaultPrevented` 为 true 且 `onBackgroundPress` 恰好被调用 1 次；(b) 在某个 chip 上触发 `mousedown`，`defaultPrevented` 为 true 且 `onBackgroundPress` 没有被调用；(c) 点击 chip 恰好以该 chip 的下标调用 `onAccept` 1 次；(d) 不传 `onBackgroundPress` 时，在 `listbox` 上触发 `mousedown` 不抛错；(e) 经 `ChatComposer` 接起来的集成：在 `listbox` 背景上触发 `mousedown` 后，`document.activeElement` 是 composer 的 textarea；(f) `listbox` 元素的 className 按空白切分后不含 `flex-1` 这个词元（jsdom 没有布局，这是对根因的类名层面约束，真正的布局读数由下面的 DoD 承担）。
- [ ] 既有测试保持绿，以下每个文件单独运行退出码均为 0：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx`、`.../chatComposerResponsive.test.tsx`、`.../composerCompactTier.test.tsx`；其中 `inputSuggestionsComposer.test.tsx` 既有 `it` 的断言行没有被修改或删除（diff 只增不改）。
- [ ] 静态门通过：`npm run typecheck` 与 `npm run lint` 退出码均为 0。
- [ ] 前端规范：新增测试文件 `src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx` 与被改动的 `src/modules/chat/composer/InputSuggestionChips.tsx` 中，`grep -nE "from '\.{1,2}/"` 与 `grep -nE "^(export )?interface "` 均无输出（退出码 1）；`git diff --name-status` 相对任务起点没有新建目录。

## DoD

真实页面上的读数，缺一不可；测试只是必要条件。

- [ ] 在隔离实例（按 AGENTS.md 与 cockpit 隔离实例做法，不碰常驻的 :3001；本项只测点击，不需要模型）的真实页面上，1280px 与 390px 两种宽度各做一遍：让 chip 可见（本项测的是点击聚焦而不是 chip 首次出现，允许用 `localStorage['chat-input-history']` 播种，并在报告里写明），对下列五个位置依次执行「先让 textarea 失焦、真实鼠标点击该点、再输入一个字符」：chip 上、两个 chip 之间的缝、最后一个 chip 右侧的空白、提示文字下方（仅桌面）、chip 行下面那一行。贴出每个位置的 `document.elementFromPoint` 命中元素、`document.activeElement` 是否为 textarea、textarea 的值。chip 上的点击读作填入该 chip，其余四个位置必须读作「已聚焦且字符进入输入框」。
- [ ] 同一次真实页面里，点击「最后一个 chip 右侧的空白」后做一次真实粘贴（例如 Playwright 的 `keyboard.insertText` 或剪贴板粘贴），贴出粘贴的文字进入了 textarea。
- [ ] 对照读数：在修复之前的提交上跑同样的探测，贴出「chip 之间的缝」与「最后一个 chip 右侧的空白」读作未聚焦、字符丢失，证明探测本身能区分修复前后。
- [ ] 窄屏横向滚动不退化：390px 下用一个接近 60 字上限的长条目（需出现至少两次才会入选），贴出 `scrollWidth` 大于 `clientWidth`，且把 `scrollLeft` 设为 80 后读回大于 0。
- [ ] 贴出 `listbox` 在修复前后的实际宽度读数（桌面应由 619px 一类的整行宽度变为约等于 chip 之和加缝隙的宽度）。
- [ ] 证伪记录：临时恢复 `flex-1`，贴出 AC 中 (f) 对应的 `it` 变红的输出；临时撤掉 `onMouseDown`，贴出 (a) 与 (e) 对应的 `it` 变红的输出；再恢复。

## Touches

- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx`
- `tasks/gap-composer-chips-background-click-focuses-textarea.md`
