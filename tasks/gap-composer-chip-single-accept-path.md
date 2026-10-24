---
id: gap-composer-chip-single-accept-path
title: 输入框 chip 接受逻辑统一封装：一个接受入口、一个回调、来源差异只靠数据、跨来源契约测试
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

2026-10-24 yale 发现：点输入框里的「检查进展」这个习惯 chip，文本填入输入框等待确认；而点模型生成的 chip，文本被直接发出。同一个「接受 chip」的动作，不同来源的行为不一致。这不是单点的疏忽，而是 chip 的接受处理没有封装成一个概念。

**现状（已读代码确认）。**

- `src/modules/chat/hooks/useChatComposerState.ts`（约 1490 行）里，「接受」有三条并行的路径：习惯 chip 走 `acceptSuggestion`，模型 chip 走 `acceptSuggestionChip` 的模型分支加一条按索引接受的 `acceptModelSuggestion`，引用 chip 走第三个分支加 `acceptQuotedSuggestion`。代码注释明说「各来源有意不同」。
- `src/modules/chat/composer/InputSuggestionChips.tsx` 按 `chip.source` 在组件内分叉，对外暴露 `onAccept`、`onAcceptModel`、`onAcceptQuoted` 三个回调；`ChatComposer.tsx` 与 `ChatInterface.tsx` 再把三个 prop（`onAcceptInputSuggestion`、`onAcceptModelSuggestion`、`onAcceptQuotedSuggestion`）原样逐层传下。
- chip 相关状态（`modelChipFillRef`、`lastChipFillRef`、`pinnedQuote` 等）在该大 hook 里被引用 24 处。
- 测试按来源分别钉住各自的行为，没有「所有来源接受后都不发送」这样跨来源的约束，所以偏差能通过。

模型 chip 点击即发出的症状，已由单独的修复任务处理（两处去掉 `submitComposer()`）；本任务处理结构，使这类偏差无法再出现。

**目标结构。**

1. **一个接受入口。** 新建 `src/modules/chat/hooks/useSuggestionChips.ts`（该 hook 拥有 chip 的接受逻辑与全部 chip 相关状态），导出唯一的 `acceptChip(chip: SuggestionChip)`。统一规则：把该 chip 的填入文本写入输入框（沿用现有「写两份存储」的路径）、聚焦、光标到末尾，**永不发送**；Ctrl+Z 可撤回（保留现有 `lastChipFillRef` 的语义）。
2. **来源差异只靠数据。** 在 `src/modules/chat/utils/inputSuggestions.ts` 里为每个来源（`quoted`、`model`、`habit`）定义一条描述记录，字段至少包括：如何由 chip 与当前输入算出要填入的文本（引用加 `> ` 前缀并按输入是否为空决定追加方式；其余原样）、填入后是否需要保持该 chip 可见（引用的 pinned）、`picked` 事件是否上报、展开实验开启时要发的请求（模型发 `seed`，引用发 `focus`，习惯不发）。接受入口只读这条记录，**不得出现 `chip.source ===`、`switch (chip.source)` 一类的分支**。
3. **一个回调。** `InputSuggestionChips` 对外只暴露 `onAccept(chip)`；`ChatComposer` 与 `ChatInterface` 只传这一个 prop。原来的三个 prop（`onAcceptInputSuggestion`、`onAcceptModelSuggestion`、`onAcceptQuotedSuggestion`）以及组件内的 `onAcceptModel`、`onAcceptQuoted`、hook 返回值里的 `acceptInputSuggestion`、`acceptModelSuggestion`、`acceptQuotedSuggestion` 全部删除，不留兼容别名。
4. **跨来源契约测试。** 新增 `src/modules/chat/tests/suggestionChipAcceptContract.test.tsx`：对每个来源逐一断言接受后「输入框内容等于该来源规定的填入文本、焦点在输入框、光标在末尾、发送回调与表单提交均未被调用、Ctrl+Z 撤回到接受前」；并有一条用例向描述记录里注册一个合成来源，不改接受入口的任何代码，断言它同样满足上述不变式——这条用例证明「新增来源只改数据」。

**必须保持的行为（不得回退）。** 模型 chip 的 `picked` 事件与 `sent` 账（只有人之后发出的文本与填入文本完全相同才报）；引用 chip 的 `> 原文` 加换行格式、输入框非空时的追加方式、pinned 行为；展开实验开启时的 `seed` 与 `focus` 请求；点击后焦点与光标；清空按钮与 Esc 清空对 chip 的联动；`aria-activedescendant` 与键盘 Tab／Enter 接受。

**范围外**：窄屏底栏、chip 行的遮挡与预览（另有任务，在改同一批文件，合并时以并集为准）；服务端；展开实验的行为。

## AC

- [ ] 契约测试逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/suggestionChipAcceptContract.test.tsx` 退出码 0；独立用例：(a) 习惯 chip；(b) 模型 chip；(c) 引用 chip（输入框为空）；(d) 引用 chip（输入框非空，追加）——每条都断言：输入框内容符合该来源的填入规则、焦点在输入框、光标在末尾、没有发送、Ctrl+Z 撤回；(e) 向描述记录注册合成来源，不改接受入口，满足同样的不变式；(f) 展开实验开启时模型 chip 与引用 chip 各发出一次对应请求（`seed`／`focus`），习惯 chip 不发；(g) 模型 chip 的 `picked` 恰好上报一次，习惯 chip 不上报。
- [ ] 来源分支已消失：`grep -nE "chip\.source\s*(===|!==)|switch \(chip\.source\)|source === '(quoted|model|habit)'" src/modules/chat/hooks/useSuggestionChips.ts` 无任何输出（退出码 1）；且 `grep -c "acceptChip" src/modules/chat/hooks/useSuggestionChips.ts` ≥ 2。
- [ ] 三个 prop 与旧回调查不到：`grep -rnE "onAcceptInputSuggestion|onAcceptModelSuggestion|onAcceptQuotedSuggestion|onAcceptModel\b|onAcceptQuoted\b|acceptInputSuggestion|acceptModelSuggestion|acceptQuotedSuggestion" src` 无任何输出（退出码 1）。
- [ ] 单一回调：`grep -nE "onAccept\b" src/modules/chat/composer/InputSuggestionChips.tsx src/modules/chat/composer/ChatComposer.tsx src/modules/chat/ChatInterface.tsx` 有输出，且这三个文件里与 chip 接受有关的 prop 只有 `onAccept` 一个（人工核对并在 DoD 里列出 prop 清单）。
- [ ] chip 状态已搬出大 hook：`grep -cE "modelChipFillRef|lastChipFillRef|pinnedQuote" src/modules/chat/hooks/useChatComposerState.ts` 为 0；`wc -l src/modules/chat/hooks/useChatComposerState.ts` 的行数小于改动前（改动前的行数在 DoD 里贴出）。
- [ ] 既有测试迁移到单一回调且仍然通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/composerClearInput.test.tsx src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx src/modules/chat/tests/inputSuggestionsComposer.test.tsx src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx src/modules/chat/tests/replyItemReferences.test.tsx` 退出码 0；迁移只改回调名与装配，不删用例、不放宽断言（`git diff --stat` 里这六个文件的删除行数与新增行数一并贴出，并说明每处删除的原因）。
- [ ] 行为反证：在 `useSuggestionChips.ts` 的接受入口里临时加一行 `submitComposer()`，契约测试 (a)(b)(c)(d)(e) 全部变红；再临时给合成来源的描述记录加一个会触发发送的字段，(e) 变红；恢复后 `git diff` 对该文件为空（过程贴在 DoD）。
- [ ] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。

- [ ] 三个来源逐个在真页上点击并贴截图与网络请求：习惯 chip、模型 chip、引用 chip——每个都只填入输入框，网络里没有发送消息的请求；贴三个来源点击前后的输入框内容。
- [ ] 展开实验开启（设置文件改成 `vary`，运行期按修改时间重读）后重做模型 chip 与引用 chip：各发出一次展开请求，没有发送消息的请求；贴请求体里的 `seed` 与 `focus`。
- [ ] 键盘路径：Tab 选中 chip 后按 Enter，三个来源都只填入；贴截图。
- [ ] Ctrl+Z：填入后撤回到接受前的内容（含引用在非空输入框里追加的情形）；贴操作记录。
- [ ] 清空 ✕：清空后 chip 重新出现，网络里没有新的抽取请求；贴截图与请求读数。
- [ ] 贴出改动前后 `useChatComposerState.ts` 的行数、`useSuggestionChips.ts` 的行数，以及三个组件的 chip 接受 prop 清单。

## Touches

- `src/modules/chat/hooks/useSuggestionChips.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/hooks/useInputSuggestions.ts`
- `src/modules/chat/utils/inputSuggestions.ts`
- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/modules/chat/tests/suggestionChipAcceptContract.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `src/modules/chat/tests/composerClearInput.test.tsx`
- `src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx`
- `src/modules/chat/tests/replyItemReferences.test.tsx`
- `tasks/gap-composer-chip-single-accept-path.md`
