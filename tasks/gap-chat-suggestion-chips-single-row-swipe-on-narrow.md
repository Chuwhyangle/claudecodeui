---
id: gap-chat-suggestion-chips-single-row-swipe-on-narrow
title: Chat 建议 chip：窄屏单行滑动压低输入区高度；chip 外框统一为虚线（quoted 保留主题色虚线边+淡底）
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

<!-- dedup-ref --> 接续 `gap-chat-suggestion-chips-wrap-no-default-preview`（done，chip 换行）与 `gap-chat-suggestion-chips-empty-textarea-reserves-two-rows`（ready，空 textarea 改 `rows=1`），机制不同：那两个任务处理 PC 的可见性与空白，本任务只处理窄屏上 chip 换行造成的高度，以及 chip 外框样式。kept separate：前者的 `rows=1` 已在途，本任务不改它，只改 chip 行在窄屏的排布与外框样式。

2026-10-25 在隔离实例手机视口 390×844 实测（截图 `tmp/ux-m-chip-height-before.png`）：输入为空、只有 3 个很短的 chip，输入区（`.chat-composer-shell`）高 203px，占屏高 24%：空 textarea 64px + chip 行 72px（3 个 chip 折成 2 行，每个 26px，加行距与上下 padding 16px）+ 底栏约 67px（推算值）。真机弹出键盘后可视高度只剩约 400–450px，这 203px 会占一半以上，transcript 几乎被挤没。单靠 `rows=1` 只省 24px，输入区仍约 180px。

做法：
- 窄屏（视口宽 ≤ 480px，沿用既有的 `min-[481px]` 分界；或粗指针 `(pointer: coarse)`，两者任一）下，chip 行改回**单行**：`flex-nowrap overflow-x-auto`，chip `shrink-0 whitespace-nowrap`、单个 chip 最长 `max-w-[85%]` 并 `truncate`，完整文本仍在 `title`；触屏横向滑动原生可用，滚动条隐藏即可。后面的 chip 靠露出一截提示可滑。
- PC（宽 ≥ 481px 且非粗指针）保持现有换行（`flex-wrap` + `line-clamp-2`），不改。
- 目标：手机 390×844、空输入、3 个短 chip 时，输入区高度 ≤ 150px（textarea 40 + chip 单行约 42 + 底栏约 67，推算值，以实测为准）。
- 不新增预览行、键盘提示或展开按钮；点击 chip 的填入/聚焦行为不变。
- **外框样式统一（2026-10-25 追加，用户裁定）：** 现状 `InputSuggestionChips.tsx` 里模型建议（`model`）是实线、历史高频输入（`habit`）是虚线、引用（`quoted`）是实线 + 主题色边 + 淡底，界面上没有任何图例，两类 chip 的点击行为完全相同，这个差异只增加认知负担。改为：**所有 chip 一律虚线**（`border-dashed`，不再有 `border-solid` 分支）；`quoted` 保留主题色边（`border-primary/50`）与淡底（`bg-primary/5`），但边也是虚线。键盘选中态（`border-primary bg-primary/10`）与 hover 样式不变。`InlineQuoteChip.tsx`（同一个 quoted chip 画进输入框正文的形态，现为 `border-solid border-primary/50 bg-primary/5`）同步改成虚线，保持 quoted chip 两种形态一致。

## AC

- [x] `npx vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 含一例：窄屏（`matchMedia` 桩为 ≤480px）渲染 6 个长文本 chip 时，列表容器 class 含 `flex-nowrap` 与 `overflow-x-auto`、不含 `flex-wrap`，每个 chip 含 `whitespace-nowrap`；exit 0。
- [x] 同一文件含一例：宽屏（≥481px、细指针）列表容器 class 含 `flex-wrap`、不含 `overflow-x-auto`，chip 含 `line-clamp-2`（PC 行为不变）；exit 0。
- [x] `npx vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/suggestionChipAcceptContract.test.tsx` exit 0。
- [x] `npx tsc --noEmit -p tsconfig.json` exit 0。
- [x] 外框统一为虚线：`npx vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 含一例：同时渲染 `model`、`habit`、`quoted` 三种来源的 chip，每个 chip 的 class 都含 `border-dashed` 且都不含 `border-solid`；`quoted` chip 另含 `border-primary/50` 与 `bg-primary/5`，`model` / `habit` chip 不含 `border-primary/50`；exit 0。取假：给 `model` 加回 `border-solid`，该例必须红。
- [x] `InlineQuoteChip` 同步：`npx vitest run src/modules/chat/tests/inlineQuoteChip.test.tsx` 含一例：内嵌 quoted chip 的 class 含 `border-dashed`、不含 `border-solid`，并保留 `border-primary/50` 与 `bg-primary/5`；exit 0。
- [x] 源码里不再有 chip 的实线分支：`git grep -n "border-solid" -- src/modules/chat/composer/InputSuggestionChips.tsx src/modules/chat/composer/InlineQuoteChip.tsx || true` 无输出（代码与注释都不得再出现该字面量）。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：隔离实例（`scripts/isolated-instance.sh`）里 MCP 浏览器打开末尾带 model 回复 chip 的真实会话，手机 390×844 与 PC 1440×900 各截图存 `tmp/` 并贴出，并用 `browser_evaluate` 贴出读数：手机、空输入、有 chip 时 `.chat-composer-shell` 高度（修复前 203px，目标 ≤ 150px）、chip 行是否单行（所有 chip 的 `getBoundingClientRect().top` 相同）、`listbox.scrollWidth > clientWidth` 时确实可横向滑动（`scrollLeft` 可改变，并用一次真实的触摸/拖动手势验证）；PC 读数确认 chip 仍换行、全部可见。fixture 单测只是必要条件，不算落地。

验证读数（2026-10-25，隔离实例 :3112，worktree 构建）：
- 手机 390×844、空输入、3 个 model chip：`.chat-composer-shell` **149px**（目标 ≤150；修复前 203），textarea rows=1 / 40px，chip 行 42px，单行（3 个 chip 的 top 均为 744）。`matchMedia('(max-width: 480px)')` 与 `(pointer: coarse)` 均 true，listbox class 含 `flex-nowrap overflow-x-auto`、不含 `flex-wrap`，`scrollWidth 557 > clientWidth 372`；真实 CDP 触摸拖动后 `scrollLeft 0 → 185`，三 chip 全部露出且仍在同一行。截图 `tmp/chip-dod/phone-390x844-before-swipe.png`、`tmp/chip-dod/phone-390x844-after-swipe.png`。
- PC 1440×900、细指针：listbox class 含 `flex-wrap`、无 `overflow-x-auto`，`scrollWidth == clientWidth == 866`，3 个 chip 全部完整可见（`line-clamp-2`），截图 `tmp/chip-dod/desktop-1440x900.png`。
- pageerror 0、console error 0（三条腿）。报告 `tmp/chip-dod/report.json`。

**重派追加的 DoD（外框统一，上面的读数不覆盖这一项）：** 在同一隔离实例再截 PC 与手机各一张，会话需同时出现 model chip 与 habit chip（空输入）；另在输入框里选中 transcript 文字生成一个 quoted chip，分别截「空框 quoted chip」与「内嵌在正文里的 quoted chip」两种形态。用 `browser_evaluate` 贴出每个 chip 的 `getComputedStyle(chip).borderTopStyle`（须全为 `dashed`，改前 model 为 `solid`），以及 quoted chip 的 `borderTopColor` 带主题色、`backgroundColor` 非透明。贴改前后并排截图，肉眼确认三类 chip 外框同为虚线、quoted 仍有主题色边与淡底。

验证读数（外框统一，2026-10-25，隔离实例 `:3123`，本 worktree 构建；会话 `9bd933fb…`，空输入，3 个 model chip + 2 个 habit chip）：
- **手机 390×844**：六个来源（quoted/model/habit）chip 的 `getComputedStyle(chip).borderTopStyle` 全为 `dashed`；model/habit 的 `borderTopColor` 为 `rgba(226,224,217,0.7)`、`backgroundColor` 透明；quoted 为 `rgba(37,99,235,0.5)`（主题色）与 `rgba(37,99,235,0.05)`（淡底）。同一次会话里 chip 行仍是单行（所有 chip top=744）、`scrollWidth 733 > clientWidth 372`、真实触摸拖动 `scrollLeft 0 → 361`，`.chat-composer-shell` 149px。截图 `tmp/chip-dod/phone-390x844-empty-after.png`、`phone-390x844-quoted-row-after.png`、`phone-390x844-after-swipe-after.png`。
- **PC 1440×900**：五/六个 chip 全部 `dashed`、quoted 同色值；listbox 为 `flex-wrap`、`scrollWidth == clientWidth == 866`、chip 折成两行（top 734 / 764）且全部完整可见。截图 `tmp/chip-dod/desktop-1440x900-empty-after.png`、`desktop-1440x900-quoted-row-after.png`。
- **内嵌 quoted chip**（输入框已有文字 + 实时选中 transcript 文字）：`[data-slot="inline-quote-chip"]` 的 `borderTopStyle` = `dashed`，`borderTopColor` = `rgba(37,99,235,0.5)`，`backgroundColor` = `rgba(37,99,235,0.05)`。截图 `tmp/chip-dod/desktop-1440x900-quoted-inline-after.png`、`phone-390x844-quoted-inline-after.png`。
- **改前对照**（同一实例、同一会话，把两个组件退回 develop 版本重建客户端）：model 与 quoted chip（行内与内嵌）`borderTopStyle` 均为 `solid`，habit 为 `dashed`。改前后并排裁剪图 `tmp/chip-dod/crop-desktop-before.png` ↔ `crop-desktop-after.png`、`crop-desktop-quoted-before.png` ↔ `crop-desktop-quoted-after.png`、`crop-desktop-inline-before.png` ↔ `crop-desktop-inline-after.png`。
- 三条腿 `pageerror` 0；仅有的控制台错误是应用自身的 GitHub 版本检查（`api.github.com` 403，外部限流），与本改动无关。读数报告 `tmp/chip-dod/report-after.json` / `report-before.json`。

## Touches

- src/modules/chat/composer/InputSuggestionChips.tsx
- src/modules/chat/composer/InlineQuoteChip.tsx
- src/modules/chat/tests/inputSuggestionsComposer.test.tsx
- src/modules/chat/tests/inlineQuoteChip.test.tsx
- src/modules/chat/tests/chatComposerReplyChips.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- tasks/gap-chat-suggestion-chips-single-row-swipe-on-narrow.md
