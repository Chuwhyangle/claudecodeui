---
id: gap-composer-chip-single-accept-path
title: 输入框 chip 统一封装：一个接受入口、一个回调、来源差异只靠数据、跨来源契约测试；去掉旧的字符串表示并收拢 ChatComposer 的
  chip prop
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-reply-suggestions-model-chip-fill-only
---
## Proposal

2026-10-24 yale 发现：点输入框里的「检查进展」这个习惯 chip，文本填入输入框等待确认；而点模型生成的 chip，文本被直接发出。同一个「接受 chip」的动作，不同来源的行为不一致。这不是单点的疏忽，而是 chip 的接受处理没有封装成一个概念。同日的面向对象评审还指出：chip 同时有两套数据表示，`ChatComposer` 还收着约 15 个 chip 相关 prop。本任务一并处理。

**现状（已读代码确认）。**

- `src/modules/chat/hooks/useChatComposerState.ts`（约 1490 行）里，「接受」有三条并行的路径：习惯 chip 走 `acceptSuggestion`，模型 chip 走 `acceptSuggestionChip` 的模型分支加一条按索引接受的 `acceptModelSuggestion`，引用 chip 走第三个分支加 `acceptQuotedSuggestion`。代码注释明说「各来源有意不同」。
- `src/modules/chat/composer/InputSuggestionChips.tsx` 按 `chip.source` 在组件内分叉，对外暴露 `onAccept`、`onAcceptModel`、`onAcceptQuoted` 三个回调；`ChatComposer.tsx` 与 `ChatInterface.tsx` 再把三个 prop（`onAcceptInputSuggestion`、`onAcceptModelSuggestion`、`onAcceptQuotedSuggestion`）原样逐层传下。
- chip 相关状态（`modelChipFillRef`、`lastChipFillRef`、`pinnedQuote` 等）在该大 hook 里被引用 24 处。
- **两套数据表示并存**：`InputSuggestionChips` 同时接受旧的 `suggestions?: string[]`（注释写着为了让独立渲染和旧测试继续工作而保留）与新的 `chips?: SuggestionChip[]`；`ChatComposer` 同时收 `inputSuggestionCandidates: string[]` 与 `suggestionChips`，再用 `suggestionChips?.length ?? inputSuggestionCandidates.length` 二选一。
- **prop 膨胀**：`ChatComposer` 有约 15 个 chip 相关 prop（`inputSuggestionCandidates`、`inputSuggestionsVisible`、`selectedInputSuggestionIndex`、`inputSuggestionListId`、三个 `onAccept*`、`suggestionChips`、`replySuggestionsEnabled`、`replySuggestionsLoading`、`onRequestReplySuggestions`、`replyExpansionChips`、`onAcceptReplyExpansionChip` 等），由 `ChatInterface` 原样逐层传下。
- 测试按来源分别钉住各自的行为，没有「所有来源接受后都不发送」这样跨来源的约束，所以偏差能通过。

模型 chip 点击即发出的症状，已由单独的修复任务处理（两处去掉 `submitComposer()`）；本任务处理结构，使这类偏差无法再出现。

**目标结构。**

1. **一个接受入口。** 新建 `src/modules/chat/hooks/useSuggestionChips.ts`（该 hook 拥有 chip 的接受逻辑与全部 chip 相关状态），导出唯一的 `acceptChip(chip: SuggestionChip)`。统一规则：把该 chip 的填入文本写入输入框（沿用现有「写两份存储」的路径）、聚焦、光标到末尾，**永不发送**；Ctrl+Z 可撤回（保留现有 `lastChipFillRef` 的语义）。
2. **来源差异只靠数据。** 在 `src/modules/chat/utils/inputSuggestions.ts` 里为每个来源（`quoted`、`model`、`habit`）定义一条描述记录，字段至少包括：如何由 chip 与当前输入算出要填入的文本（引用加 `> ` 前缀并按输入是否为空决定追加方式；其余原样）、填入后是否需要保持该 chip 可见（引用的 pinned）、`picked` 事件是否上报、展开实验开启时要发的请求（模型发 `seed`，引用发 `focus`，习惯不发）。接受入口只读这条记录，**不得出现 `chip.source ===`、`switch (chip.source)` 一类的分支**。
3. **一个回调。** `InputSuggestionChips` 对外只暴露 `onAccept(chip)`；`ChatComposer` 与 `ChatInterface` 只传这一个回调。原来的三个 prop（`onAcceptInputSuggestion`、`onAcceptModelSuggestion`、`onAcceptQuotedSuggestion`）以及组件内的 `onAcceptModel`、`onAcceptQuoted`、hook 返回值里的 `acceptInputSuggestion`、`acceptModelSuggestion`、`acceptQuotedSuggestion` 全部删除，不留兼容别名。
4. **跨来源契约测试。** 新增 `src/modules/chat/tests/suggestionChipAcceptContract.test.tsx`：对每个来源逐一断言接受后「输入框内容等于该来源规定的填入文本、焦点在输入框、光标在末尾、发送回调与表单提交均未被调用、Ctrl+Z 撤回到接受前」；并有一条用例向描述记录里注册一个合成来源，不改接受入口的任何代码，断言它同样满足上述不变式——这条用例证明「新增来源只改数据」。
5. **只留一种数据表示。** 删除旧的字符串形态：`InputSuggestionChips` 的 `suggestions?: string[]`、`ChatComposer` 的 `inputSuggestionCandidates`，以及 `useInputSuggestions` 返回值里仅为旧形态服务的 `candidates`（若仍有内部使用者则改为内部私有）。strip 的唯一输入是 `SuggestionChip[]`；原先依赖旧形态的测试迁移到 `SuggestionChip[]`，不留回退分支。
6. **收拢 `ChatComposer` 的 chip prop。** 在 `src/shared/types.ts` 定义一个 `ComposerChipStrip` 类型（两个以上文件使用，按规则放共享类型并写注释），把可见性、选中项、listbox id、chip 列表、接受回调、「建议」按钮的 enabled／loading／request、展开 chip 及其接受回调收成一个对象；`ChatComposer` 只收这一个 prop（例如 `chipStrip`），`ChatInterface` 传一个对象。第 1 项列出的约 15 个零散 prop 全部从 `ChatComposer` 的 props 里消失。该对象由 `useChatComposerState`（或新 hook）一次产出，不在 `ChatInterface` 里逐字段拼装。

**必须保持的行为（不得回退）。** 模型 chip 的 `picked` 事件与 `sent` 账（只有人之后发出的文本与填入文本完全相同才报）；引用 chip 的 `> 原文` 加换行格式、输入框非空时的追加方式、pinned 行为；展开实验开启时的 `seed` 与 `focus` 请求；点击后焦点与光标；清空按钮与 Esc 清空对 chip 的联动；`aria-activedescendant` 与键盘 Tab／Enter 接受。

**范围外**：窄屏底栏、chip 行的遮挡与预览（另有任务，在改同一批文件，合并时以并集为准）；服务端；展开实验的行为；`useReplySuggestions` 内部的拆分（另有任务）。

## AC

- [x] 契约测试逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/suggestionChipAcceptContract.test.tsx` 退出码 0；独立用例：(a) 习惯 chip；(b) 模型 chip；(c) 引用 chip（输入框为空）；(d) 引用 chip（输入框非空，追加）——每条都断言：输入框内容符合该来源的填入规则、焦点在输入框、光标在末尾、没有发送、Ctrl+Z 撤回；(e) 向描述记录注册合成来源，不改接受入口，满足同样的不变式；(f) 展开实验开启时模型 chip 与引用 chip 各发出一次对应请求（`seed`／`focus`），习惯 chip 不发；(g) 模型 chip 的 `picked` 恰好上报一次，习惯 chip 不上报。
  - 实测：退出码 0，`8 tests passed`（(a)-(g) 各一条 + 一条三来源合并顺序用例）。
- [x] 来源分支已消失：`grep -nE "chip\.source\s*(===|!==)|switch \(chip\.source\)|source === '(quoted|model|habit)'" src/modules/chat/hooks/useSuggestionChips.ts` 无任何输出（退出码 1）；且 `grep -c "acceptChip" src/modules/chat/hooks/useSuggestionChips.ts` ≥ 2。
  - 实测：grep 退出码 1；`acceptChip` 计数 4。
- [x] 三个 prop 与旧回调查不到：`grep -rnE "onAcceptInputSuggestion|onAcceptModelSuggestion|onAcceptQuotedSuggestion|onAcceptModel\b|onAcceptQuoted\b|acceptInputSuggestion|acceptModelSuggestion|acceptQuotedSuggestion" src` 无任何输出（退出码 1）。
  - 实测：退出码 1。
- [x] 旧的字符串表示查不到：`grep -rnE "inputSuggestionCandidates|suggestions\?: string\[\]" src` 无任何输出（退出码 1）；`grep -nE "suggestionChips\?\.length \?\? " src/modules/chat/composer/ChatComposer.tsx` 无任何输出。
  - 实测：两条 grep 均退出码 1。
- [x] `ChatComposer` 的 chip prop 已收拢：`grep -nE "inputSuggestionsVisible|selectedInputSuggestionIndex|inputSuggestionListId|replySuggestionsEnabled|replySuggestionsLoading|onRequestReplySuggestions|replyExpansionChips|onAcceptReplyExpansionChip" src/modules/chat/composer/ChatComposer.tsx src/modules/chat/ChatInterface.tsx` 无任何输出（退出码 1）；`grep -c "chipStrip" src/modules/chat/composer/ChatComposer.tsx` ≥ 1；`grep -n "ComposerChipStrip" src/shared/types.ts` 有输出且紧邻该类型有注释。
  - 实测：grep 退出码 1；`chipStrip` 计数 17；`src/shared/types.ts:3667` 是 `export type ComposerChipStrip = {`，其上紧邻说明注释。
- [x] 单一回调：`grep -nE "onAccept\b" src/modules/chat/composer/InputSuggestionChips.tsx` 有输出，且该组件里与 chip 接受有关的 prop 只有 `onAccept` 一个（人工核对并在 DoD 里列出 prop 清单）。
  - 实测：有输出（类型声明、解构、点击处各一处）。组件 prop 全表：`listId`、`chips`、`selectedIndex`、`onAccept`、`onBackgroundPress`、`showPreview`；其中与 chip 接受有关的只有 `onAccept`。
- [x] chip 状态已搬出大 hook：`grep -cE "modelChipFillRef|lastChipFillRef|pinnedQuote" src/modules/chat/hooks/useChatComposerState.ts` 为 0；`wc -l src/modules/chat/hooks/useChatComposerState.ts` 的行数小于改动前（改动前的行数在 DoD 里贴出）。
  - 实测：计数 0；行数 1498 → 1235。
- [x] 既有测试迁移到单一回调与单一表示且仍然通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/composerClearInput.test.tsx src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx src/modules/chat/tests/inputSuggestionsComposer.test.tsx src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx src/modules/chat/tests/replyItemReferences.test.tsx src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/composerCompactTier.test.tsx` 退出码 0；迁移只改回调名、数据形态与装配，不删用例、不放宽断言（`git diff --stat` 里这八个文件的删除行数与新增行数一并贴出，并说明每处删除的原因）。
  - 实测：连同契约测试共 `9 files / 138 tests passed`，退出码 0。
  - `git show --stat HEAD` 的这八个文件：chatComposerReplyChips +215/-?（298 insertions / 184 deletions 为八文件合计）；逐文件 diffstat：chatComposerReplyChips 215 行变更、chatComposerResponsive 28、composerClearInput 24、composerCompactTier 21、inputSuggestionChipsBackground 49、inputSuggestionsComposer 93、inputSuggestionsDockTurn 27、replyItemReferences 25；合计 `8 files changed, 298 insertions(+), 184 deletions(-)`。
  - 删除原因（逐类）：(1) 旧三回调的断言与夹具行（`onAcceptInputSuggestion`/`onAcceptModelSuggestion`/`onAcceptQuotedSuggestion` 及其 mock 调用断言）换成唯一的 `onAccept(chip)` 与 `chipStrip` 断言；(2) 旧的字符串形态夹具（`suggestions: [...]`、`inputSuggestionCandidates`）换成 `chips: buildSuggestionChips(...)`/`chipStrip.chips`；(3) 组件 props 装配处把十余个零散 chip prop 换成 `chipStrip` 对象（纯装配替换）；(4) hook 返回值读取改为 `state.chipStrip.*`。没有任何用例被删除或断言被放宽；两处语义等价性展开放进了新契约测试（跨来源「不发送 + Ctrl+Z」由契约测试承担）。
- [x] 行为反证：在 `useSuggestionChips.ts` 的接受入口里临时加一行 `submitComposer()`，契约测试 (a)(b)(c)(d)(e) 全部变红；再临时给合成来源的描述记录加一个会触发发送的字段，(e) 变红；恢复后 `git diff` 对该文件为空（过程贴在 DoD）。
  - 实测（反证臂 1）：在 `acceptChip` 末尾加 `submit();` 后，契约测试 `5 failed | 3 passed`，(a)(b)(c)(d)(e) 全部因 `accepting a chip never sends` 变红，(f)(g) 仍绿。
  - 实测（反证臂 2）：恢复后把测试里合成来源的 `submitsAfterFill` 改为 `true`，契约测试 `1 failed | 7 passed`，只有 (e) 变红。
  - 恢复后 `git diff --stat` 对 `useSuggestionChips.ts` 与契约测试均为空，契约测试回到 8/8 绿。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。
  - 实测：`npm run typecheck` 退出码 0（client + server + scripts 三个 tsconfig）；`npm run lint` 退出码 0（仅既有 warning）。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。

验证环境：本会话没有 MCP 浏览器（ToolSearch 无 browser/playwright 工具），按既有回退办法用一次性 Playwright spec 驱动真实 Chromium + 真实 server/Vite。实例由 `playwright.config.ts` 的隔离 run 提供：独立 server/client 端口、独立 `DATABASE_PATH`、`HOME`、`QUAY_E2E_DATA_DIR`；另临时给它 `SERVER_SETTINGS_PATH=…/server.settings.json`（内容 `{"residentRestore":{"enabled":false}}`）与 `REPLY_SUGGESTIONS_SETTINGS_PATH=…/reply-suggestions.settings.json`（operator 真网关设置的副本，`apiKeyFile` 绝对化后继续指向同一个 0600 key 文件）。常驻 :3001（pid 2465137）未重启、未触碰；结束后一次性 spec 与 playwright.config.ts 临时块已删除/还原，`git status` 干净；无本 run 遗留的 session scope（`claudecodeui-session-28249-*` / `-22797-*` 均无）。截图与报告在 `tmp/chip-accept-dod/`（tmp/ 被 gitignore）。

- [x] 三个来源逐个在真页上点击并贴截图与网络请求：习惯 chip、模型 chip、引用 chip——每个都只填入输入框，网络里没有发送消息的请求；贴三个来源点击前后的输入框内容。
  - 截图：`tmp/chip-accept-dod/01-empty-box-chips.png`（三个真实网关生成的模型 chip + 习惯 chip「检查进展」）、`02-habit-filled.png`、`03-model-filled.png`、`04-quoted-filled-empty.png`。
  - 报告：`tmp/chip-accept-dod/report.json`。习惯 chip：`""` → `"检查进展"`，`focused: true`，`selectionStart: 4`；模型 chip：`""` → 一条真实模型回复，`focused: true`，`selectionStart: 13`，恰好一次 `picked`（`{"event":"picked","index":0,"draw":1}`）；引用 chip：`""` → `"> The release checklist confirms the build is signed, the note\n"`（左对齐 `> ` + 末行换行），`focused: true`，`selectionStart: 63`。
  - 网络：WS `framesent` 全程捕获到 `chat.send`/`chat.edit-send` 数量 **0**（`sentFramesTotal: []`）；HTTP 侧三次点击都没有任何 `POST /api/reply-suggestions` 抽取请求（只有模型的 `picked` 事件）。
- [x] 展开实验开启（设置文件改成 `vary`，运行期按修改时间重读）后重做模型 chip 与引用 chip：各发出一次展开请求，没有发送消息的请求；贴请求体里的 `seed` 与 `focus`。
  - 步骤：把隔离实例的 `reply-suggestions.settings.json` 的 `expansion` 改为 `vary`（服务端按 mtime 重读；客户端 `/status` 每次挂载读一次，故 reload 一次让实验生效），`GET /api/reply-suggestions/status` 返回 `{"enabled":true,"expansion":"vary","maxChips":3,"maxChipChars":120}`。
  - 模型 chip：一次 `POST /api/reply-suggestions`，body `{"sessionId":"e2e-suggestion-chip","expand":true,"seed":"发布前检查都过了，按计划发布"}`；输入框保留该 seed；展开 chip 出现 3 条（`"发布前检查已通过，就按计划发布吧"` 等）。
  - 引用 chip：一次 `POST /api/reply-suggestions`，body `{"sessionId":"e2e-suggestion-chip","expand":true,"focus":"The release checklist confirms the build is signed, the note"}`（无 seed）；输入框保留 `> …`；展开 chip 出现 3 条。
  - 网络：本段同样无任何 `chat.send`/`chat.edit-send` 帧。截图：`11-expansion-model.png`、`12-expansion-quoted.png`。
- [x] 键盘路径：Tab 选中 chip 后按 Enter，三个来源都只填入；贴截图。
  - 报告读到 `aria-activedescendant` 分别落到 `…-option-0`（模型）、`…-option-1`（习惯）、`…-option-0`（引用，pinned 后唯一一条）。Enter 后：模型 → 模型回复（`selectionStart` 末尾 13）、习惯 → `"检查进展"`（末尾 4）、引用 → 再次追加 `> …\n`。截图：`06-keyboard-model.png`、`07-keyboard-habit.png`、`08-keyboard-quoted.png`。
- [x] Ctrl+Z：填入后撤回到接受前的内容（含引用在非空输入框里追加的情形）；贴操作记录。
  - 报告：习惯 `"检查进展"` → `""`；模型 → `""`；引用（空框）`"> …\n"` → `""`；引用追加（`"发布清单…"` 后追加 `\n\n> …\n`，共 78 字符）→ 撤回为 `"发布清单…"`（13 字符）。四条 `focused: true`，光标随值回退。
- [x] 清空 ✕：清空后 chip 重新出现，网络里没有新的抽取请求；贴截图与请求读数。
  - 报告 `clearControl`：清空后 strip 回到 `["model","model","model","habit"]`；`newSuggestCalls: 0`（清空按钮与 Esc 一样只清 draft，不触发新的抽取）。截图：`09-after-clear.png`。
- [x] 「建议」按钮与展开 chip 在收拢 prop 之后仍然正常：点「建议」整批替换（一次 POST）；展开实验开启时展开 chip 出现并可替换正文；贴截图。
  - 「建议」：点击后恰好一次 `POST /api/reply-suggestions`，body `{"sessionId":"e2e-suggestion-chip","redraw":true}`，strip 重绘为新的 3 条模型 chip + 习惯 chip。截图：`10-suggest-button.png`。
  - 展开 chip：点击第一条后正文被替换、`> 原文` 行保留（`"> The release checklist confirms the build is signed, the note\n清单里这三项都确认了，那就按计划推进。"`），并以其为 seed 继续发下一次展开请求；`picked` 事件带 `source: "focus"`。截图：`13-expansion-chip-accepted.png`。
- [x] 贴出改动前后 `useChatComposerState.ts` 的行数、`useSuggestionChips.ts` 的行数、`ChatComposer` 的 props 个数（改动前后），以及 `InputSuggestionChips` 的 chip 接受 prop 清单。
  - `useChatComposerState.ts`：1498 → 1235 行。
  - `useSuggestionChips.ts`：新建，356 行（含 chip 接受入口、pin/undo/sent 状态、模型与展开 draw 的接线）。
  - `ChatComposer` 的 props：91 → 79（14 个零散 chip prop 收成 1 个 `chipStrip`）。
  - `InputSuggestionChips` 的 props：`listId`、`chips`、`selectedIndex`、`onAccept`、`onBackgroundPress`、`showPreview`；chip 接受相关只有 `onAccept(chip)`。

## Touches

- `src/modules/chat/hooks/useSuggestionChips.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/hooks/useInputSuggestions.ts`
- `src/modules/chat/utils/inputSuggestions.ts`
- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/shared/types.ts`
- `src/modules/chat/tests/suggestionChipAcceptContract.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `src/modules/chat/tests/composerClearInput.test.tsx`
- `src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx`
- `src/modules/chat/tests/replyItemReferences.test.tsx`
- `src/modules/chat/tests/chatComposerResponsive.test.tsx`
- `src/modules/chat/tests/composerCompactTier.test.tsx`
- `tasks/gap-composer-chip-single-accept-path.md`
