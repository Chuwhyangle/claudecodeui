---
id: gap-composer-quote-chip-inline-at-caret
title: 引用 chip 内嵌在输入框光标处并参与文本排版（输入框非空时），删除文字上方的占位行
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-composer-quote-chip-insert-at-caret
---
## Proposal

2026-10-24 yale 的要求：引用 chip 显然在输入框里，位置在输入框**当前光标处**，并且**参与文本排版**（光标后面的文字被它推开，像插入了一个词）；点击它的效果是：插入文本、chip 消失、光标停在插入文本末尾（插入规则由前一个引用任务实现，本任务只负责 chip 的呈现与点击接入）。

**现状。** 输入框里有字、而你在 transcript 里选中文字时，引用 chip 现在是 chip 行覆盖在输入框顶部（`composer/InputSuggestionChips.tsx` 的 `absolute top-0` 覆盖层）；为了不盖住文字，`ChatComposer.tsx` 在 `chipRowOverText`（chip 显示且输入框非空）时给文字上方加一个 48px 的占位行（`CHIP_ROW_CLEARANCE_SPACER_CLASS = 'h-12'`）和镜像层的 `pt-12`。后果：每次选中文字输入框就长高 48px、取消选中又缩回去，布局来回跳；chip 也不在光标处。

**可行性（2026-10-24 已在 :3001 真页上用克隆镜像层探测过，未改动任何 React 管理的节点）。** 输入框的镜像层（`ChatComposer.tsx` 里 `inputHighlightRef` 那个 `aria-hidden` 的 `absolute inset-0` 层，内层用 `renderInputWithMentions` 渲染文字）与 textarea 的字体、行高、内边距、换行规则完全一致（14px/24px，`pre-wrap`，`overflow-wrap: break-word`）；不带 chip 时，镜像层内容高度与 textarea 的 `scrollHeight` 相等（1280px 下 64 对 64，390px 下 136 对 136）。把镜像层显示出来并在光标处插入一个行内块，后面的文字被推开并正常换行；窄屏下放不下时 chip 整体换到下一行，像一个词。要处理的问题是：加了 chip 后内容多出一行（88 对 64，160 对 136），textarea 高度必须跟着镜像层走，否则最后一行被截断。

**方案：只在 chip 可见期间切换显示模式。** 能这样做，是因为用户在 transcript 里选中文字时输入框本来就失焦，没有光标和选区需要与镜像层对齐。

1. **何时显示内嵌 chip。** 同时满足：输入框**非空**；transcript 里有实时选区（引用 chip 的现有显示条件）；现有的 chip 显示条件成立（空闲、无菜单、无排队草稿与附件等）；语音听写未在进行（`provisionalVoiceRange` 为空）。输入框为空时引用 chip 仍在 chip 行里，行为不变。
2. **插入点。** chip 出现时从 textarea 元素读 `selectionEnd`（失焦后浏览器仍保留）作为插入点；有选区时是选区末尾。点击插入时使用的光标位置与此一致（插入规则与位置的读取由前一个引用任务的统一接受入口负责，本任务不重复实现）。
3. **镜像层内容。** 切换为显示模式：文字可见（去掉 `text-transparent`），内容是 `光标前的文字` + 一个与 chip 同宽的**行内块占位元素** + `光标后的文字`，前后两段仍用 `renderInputWithMentions` 渲染；textarea 的文字在此模式下变透明（光标颜色不变）。占位元素参与排版，把后面的文字推开。
4. **真正的 chip 是一个单独的按钮。** 镜像层是 `aria-hidden` 的，辅助技术看不到里面的东西，所以 chip 不画在镜像层里，而是一个真实的 `button`，按占位元素的坐标叠在它上面（占位元素尺寸变化、窗口缩放、textarea 滚动时重新定位，用 `ResizeObserver` 与现有的滚动同步）。按钮有可读名称（沿用引用 chip 现有的文案键，不新增键）与 `title`（完整原文）；标签约 16–20 个字、超出省略；`mousedown`／`pointerdown` 阻止默认行为，使 transcript 的选区在点击前不被浏览器塌缩；点击走统一接受入口。
5. **高度跟镜像层走。** chip 模式下 textarea 的高度由镜像层内容高度决定（仍受 `max-h-[40vh]` 等现有上限约束，超出时 textarea 滚动，镜像层按现有的 `syncInputOverlayScroll` 同步滚动）；chip 出现、消失、窗口宽度变化时重新计算。
6. **滚动条宽度补偿。** textarea 出现竖向滚动条时内容宽度比镜像层窄，换行会错位；chip 模式下镜像层右内边距补上 `textarea.offsetWidth - textarea.clientWidth`。
7. **退出模式。** 实时选区消失（点回输入框等）、点击插入之后、输入框被清空、听写开始，立即回到普通模式（镜像层文字重新透明，textarea 文字恢复显示，高度按普通规则重算）。
8. **删除占位行。** 删除 `CHIP_ROW_CLEARANCE_SPACER_CLASS`、`CHIP_ROW_CLEARANCE_PADDING_CLASS`、`chipRowOverText` 与 `data-slot="chip-row-clearance"` 的那个占位 `div` 及其相关逻辑；chip 行不再需要在非空输入框上方预留空间。
9. **键盘。** 该 chip 只在选中 transcript 文字时出现，此时输入框失焦，所以只服务指针与触屏，不设键盘路径（yale 已同意）。

**范围外**：引用的插入规则与光标位置的读取（前一个引用任务）；空输入框时 chip 行里的引用 chip；模型与习惯 chip；iOS 与 Android 真机的行为只做标注（待外部）。

## AC

- [x] 内嵌模式的结构逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inlineQuoteChip.test.tsx` 退出码 0（新增）；独立用例：(a) 输入框非空、有实时选区时渲染内嵌 chip 按钮（`data-slot="inline-quote-chip"`）与镜像层里的占位元素（`data-slot="inline-quote-chip-spacer"`），占位元素在镜像层里的位置等于 textarea 的 `selectionEnd`（前后文字分段正确，含中文与代理对字符）；(b) 输入框为空时不渲染内嵌 chip，引用 chip 仍在 chip 行里；(c) 没有实时选区时不渲染；(d) 语音听写进行中（`provisionalVoiceRange` 非空）不渲染；(e) chip 模式下 textarea 带透明文字的标记（类或 `data-inline-chip-mode`）、镜像层文字可见；退出模式后两者复原；(f) 按钮有可读名称与 `title`，不新增 i18n 键（`en` 与 `zh-CN` 键集合与改动前一致）；(g) 按钮的 `mousedown` 被 `preventDefault`；(h) 点击按钮调用统一接受入口一次，并传入引用 chip；(i) 选区消失后模式退出；(j) 光标在文字中间（有「后」文字）与在末尾（无「后」文字）两种情形的镜像层分段各一条用例。
- [x] 占位行已删除：`grep -rnE "CHIP_ROW_CLEARANCE|chip-row-clearance|chipRowOverText" src` 无任何输出；既有依赖占位行的测试（`inputSuggestionChipsBackground.test.tsx` 里相关用例）改为断言新结构，不删用例、不放宽断言（`git diff --stat` 的删除与新增行数贴在 DoD，说明每处删除的原因）。
- [x] 既有 chip 测试不被打红：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx src/modules/chat/tests/inputSuggestionsComposer.test.tsx src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/suggestionChipAcceptContract.test.tsx` 退出码 0。
- [x] 空输入框的布局不变：`inputSuggestionChipsBackground.test.tsx` 里空输入框的几何与类名断言保持通过，且新增一条用例：输入框为空、有引用选区时，textarea 与镜像层的类名与改动前逐字一致。
- [x] 高度逻辑可测部分：把「chip 模式下 textarea 高度 = min(镜像层内容高度, 上限)」抽成纯函数并有单测（`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inlineQuoteChipHeight.test.ts` 退出码 0）：内容高于上限时取上限；低于上限取内容高度；滚动条宽度补偿值计算正确。
- [x] 行为反证：临时让内嵌 chip 在输入框为空时也渲染，(b) 变红；临时去掉 `mousedown` 的 `preventDefault`，(g) 变红；临时不退出模式，(i) 变红；恢复后 `git diff` 为空（过程贴在 DoD）。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数，缺一不可；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。视口宽度依次设为 320、360、390、412、1280 像素。

  执行说明：全程未发送任何消息（没有 agent 回合），因此不存在测试会话提示词，也没有留下测试产物；隔离实例（DATABASE_PATH / SERVER_SETTINGS_PATH（residentRestore.enabled=false）/ HOME / 端口 3121 与 5181）全部在 worktree 的 tmp/iso 下，常驻 :3001 未触碰、未重启。真实页面由一次性 Playwright 脚本驱动（会话内没有 MCP 浏览器），所有截图与读数在 worktree 的 tmp/dod/（gitignored），源码树 git status 只含本任务改动。

- [x] **排版一致（先于 chip 验证模式切换本身没有位移）：** 每个宽度、三种文本（纯中文长句、中英混排、含一个很长的无空格串如网址），分别量：不带 chip 时镜像层内容高度与 textarea 的 `scrollHeight` 是否相等；把镜像层切到文字可见、textarea 文字透明后，截图与切换前（textarea 文字可见）做像素对比，差异应在可忽略范围，贴出对比的截图与差异读数。
  读数（tmp/dod/parity-report.json、tmp/dod/parity2-report.json）：5 个宽度 × 3 种文本，不带 chip 时镜像层内容高度 == textarea.scrollHeight 全部为 true（320: 136/136、136/136、112/112；360: 136/136、112/112、112/112；390: 112/112、112/112、112/112；412: 112/112、112/112、88/88；1280: 64/64、64/64、64/64）。把镜像层切到文字可见、textarea 文字透明后，以 textarea 自身矩形为锚截图并遮掉 chip 所在行及以下做像素对比：差异像素 0 / 302×136、0 / 342×136、0 / 372×112、0 / 372×112、0 / 394×112；1280 三例全 0。截图 tmp/dod/re-<width>-<text>-before.png / -after.png。（首轮用整个表单矩形作裁剪锚时读到 17–1627 像素差，是表单因高度变化导致的 1px 栅格偏移；改用元素自身矩形为锚后全部为 0。）
- [x] **有滚动条的情形：** 构造足够长的文本，使 textarea 出现竖向滚动条（在会出现经典滚动条的环境下做；若环境只有覆盖式滚动条，注明并在 DoD 里说明如何构造了等价的宽度差），量出镜像层补偿后与 textarea 的行数一致，贴读数与截图。
  读数：headless Chromium 只提供覆盖式滚动条（长文本下 offsetWidth == clientWidth == 866），按 DoD 允许的方式构造等价宽度差：给 textarea 加 15px 透明右边框（box-sizing: border-box，clientWidth 866→851，内容盒右边缘左移 15px，与经典滚动条对内容宽度的作用相同）。补偿后镜像层 padding-right = 31px（16 + 15），textarea 内容右边缘 1186.5 == 镜像内容右边缘 1186.5（delta 0），textarea.scrollHeight 976 == 镜像 scrollHeight 976（行数一致）；textarea 高 300（40vh 上限生效，clientH 300）。滚到底部：textarea.scrollTop 676 == 镜像外层 scrollTop 676（同步）。截图 tmp/dod/scrollbar-chip-top.png、tmp/dod/h2-scrollbar-bottom.png。
- [x] **chip 位置与推开：** 光标分别放在文字开头、中间、末尾，在 transcript 里选中一段文字：chip 出现在光标处（贴 chip 的矩形与光标处字符的矩形，二者重合或紧邻），后面的文字被推开（chip 之后第一个字符的 x 大于 chip 右边缘，或换到了下一行）；贴截图。
  读数（1280px，文本「前面中间后面结尾」，选区「OMITTED (real conten)」）：光标在开头 chip.x=367.5 == textarea 内容左边缘 367.5；在中间 beforeChar.right=424 == chip.x=424；在末尾 beforeChar.right=480 == chip.x=480。三种位置 chip 与占位元素矩形完全重合（x/y/宽差 ≤1px）；chip 之后第一个字符 x == chip 右边缘（544/544、600/600），即后方文字被紧邻推开。截图 tmp/dod/chip-position-start.png / -middle.png / -end.png。
- [x] **高度：** chip 出现与消失时输入框高度的读数（出现后内容多出一行时高度相应增长，最后一行未被截断；消失后复原），以及增长超过上限时 textarea 滚动、镜像层同步滚动的读数；确认没有 48px 的整体跳动。
  读数：一行草稿 64→64（+0，无跳动）；chip 被挤到新行时 64→88（+24，恰为一行，镜像 scrollHeight 88，最后一行未被截断）；增长超过上限时 textarea 高 300、scrollHeight 976，滚动同步见上一条。无 48px 的整体跳动。实现偏差（有意）：高度取 max(镜像内容高度, 普通模式内容高度) 再受上限约束——纯跟随镜像会把两行默认高的一行草稿在选中时缩成一行（64→40）；现在 chip 只会让框长高一行，不会反向跳。截图 tmp/dod/h2-wrap-grow.png、tmp/dod/grow-n56.png。
- [x] **点击：** 点击内嵌 chip 后：插入结果与光标位置（读 `textarea.value`、`selectionStart`、`selectionEnd`）符合前一个引用任务的规则，chip 消失，模式退出，textarea 文字恢复显示且位置与退出前一致；贴读数与截图。
  读数：点击前 value=「我同意」且内嵌 chip 在；点击后 value=「我同意 OMITTED (real conten」（末尾补空格规则）、selectionStart=selectionEnd=24 == 3 + 1 + 20、chip 消失、data-inline-chip-mode 为 null、textarea color 从 rgba(0, 0, 0, 0) 恢复为 rgb(13, 11, 8)、document.activeElement 是 textarea、页面选区 1 个且 collapsed。截图 tmp/dod/h2-click-before.png / h2-click-after.png。
- [x] **退出路径：** 点回输入框、清空输入框、开始听写（可用现有的听写调试入口），chip 与模式各自正确退出；贴读数。
  读数：点回输入框 → chip=false、mode=null（focused=true）；程序化清空输入框（不聚焦）→ chip=false、mode=null，空框 chip 行出现（listbox=true）；点 Voice input 开始听写（真实录音，出现 Stop recording）→ chip=false、mode=null、textarea 文字恢复。听写期间 chip 行不再覆盖文字：非空框不再画 chip 行（占位行已删除，没有空间给它）。截图 tmp/dod/dict-exit-before.png / dict-exit-after.png、tmp/dod/h2-exit-clear.png。
- [x] **窄屏：** 390px 与 360px 下 chip 放不下时整体换到下一行的情形，贴截图；确认底栏（附件、建议、更多、清空、模型、权限、麦克风、发送）没有因此溢出或位移。
  读数（390 / 360，30 个汉字、光标在第 20 字）：chip 整体换到下一行（chip.y 802 / 778 均大于前一字符底部 798 / 774）；chip 之后第一个字符 x == chip 右边缘（201 / 201）；底栏按钮无溢出（footer overflow=false）。截图 tmp/dod/narrow2-390.png、tmp/dod/narrow2-360.png。
- [x] **空输入框：** 选中文字时 chip 仍在 chip 行里，布局与改动前一致，贴截图。
  读数：空框 + 引用选区时内嵌 chip 不渲染（inlineChip=false、mode=null），chip 行/listbox 仍在（listbox=true）；textarea 与镜像层 class 与改动前逐字一致（classesEqual=true）。截图 tmp/dod/h2-empty.png。
- [x] **降级条件：** 若某个宽度或滚动条情形下无法做到排版一致，不要静默上线：在该情形下不显示内嵌 chip，并把降级条件与读数列在 DoD 里（这是兜底，不是目标）。
  未触发降级：5 个宽度与滚动条情形均做到排版一致，所有宽度都渲染内嵌 chip。
- [ ] iOS Safari 与 Android Chrome 真机上选中 transcript 文字后点击内嵌 chip，确认选区不被提前塌缩、插入与光标正确、输入法与滚动正常。（待外部）

  变更统计（相对 develop 合并基点）：8 files changed, 1087 insertions(+), 70 deletions(-)——ChatComposer.tsx 142、InlineQuoteChip.tsx 64（新）、useInlineQuoteChip.ts 252（新）、useTextareaInteractionState.ts 22、inlineQuoteChip.test.tsx 423（新）、inlineQuoteChipHeight.test.ts 87（新）、inputSuggestionChipsBackground.test.tsx 74、inlineQuoteChipLayout.ts 93（新）。删除项及原因：CHIP_ROW_CLEARANCE_SPACER_CLASS / CHIP_ROW_CLEARANCE_PADDING_CLASS 两个常量、chipRowOverText 分支、data-slot="chip-row-clearance" 占位 div、镜像层的 pt-12 —— 非空框的引用 chip 已改在文本流里画，chip 行只在空框出现，不再需要预留行；inputSuggestionChipsBackground.test.tsx 的 3 个占位行用例改为断言新结构（不删用例、不放宽断言），另外新增 1 条空框类名逐字一致的用例。
  行为反证（在最终代码上重跑，日志 tmp/dod/final-mutA/B/C.log）：令 `active = enabled && chip !== null`（空框也渲染内嵌 chip）⇒ inlineQuoteChip.test.tsx 红在 (b)；令 `active = enabled && input !== ''`（选区消失也不退出）⇒ 红在 (a)(j)(e)(i)；删掉 onMouseDown 的 preventDefault ⇒ 红在 (g)。三次恢复后 git status 干净（工作树与 HEAD 一致）。

## Touches

- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/composer/InlineQuoteChip.tsx`
- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/hooks/useInlineQuoteChip.ts`
- `src/modules/chat/hooks/useTextareaInteractionState.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/utils/inlineQuoteChipLayout.ts`
- `src/modules/chat/tests/inlineQuoteChip.test.tsx`
- `src/modules/chat/tests/inlineQuoteChipHeight.test.ts`
- `src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `tasks/gap-composer-quote-chip-inline-at-caret.md`
