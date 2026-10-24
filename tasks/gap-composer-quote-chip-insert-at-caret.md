---
id: gap-composer-quote-chip-insert-at-caret
title: 引用 chip：把选中文本插入输入框光标处（按空格与回车规则）、用后即退场、删除「引用回应」展开路径、发送去掉末尾空格与回车
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-24 yale 在真实使用中发现并确认了下面几件事，本任务一并处理。chip 在输入框里的**呈现位置**（空输入框时在 chip 行，非空时在文字上方的占位行）本任务不动，另有任务把它改成内嵌在光标处。

**1. 点引用 chip 的效果（yale 原话规则，按字面实现）。**

- 把选中的文本插入输入框，**不加 `> `，不加换行**；插入位置是输入框的光标处，有选区时是选区末尾之后。
- 光标前有非空格文本，就在插入文本前补一个空格。
- 光标后有非空格文本，就在插入文本后补一个空格。
- 光标在输入框末尾且是空行，就在插入文本后再加 2 个回车。
- 光标停在刚追加的所有文本、空格、回车的末尾。

「非空格文本」按字面读：紧挨着光标的那个字符存在且不是空格，标点也算。唯一补充的定义（yale 已同意）：**回车不算文本**，所以光标紧挨着回车时（在行首、在两行之间）不补空格。「空行」指光标所在的那一行没有任何字符。

示例（`|` 是光标，`T` 是选中的文本，`↵` 是回车）：

| 插入前 | 插入后 |
|---|---|
| 空输入框 `\|` | `T↵↵\|` |
| `我同意\|` | `我同意 T\|` |
| `我同意 \|` | `我同意 T\|` |
| `\|后面` | `T \|后面` |
| `前面\|后面` | `前面 T \|后面` |
| `第一段↵\|` | `第一段↵T↵↵\|` |
| `a↵\|↵b` | `a↵T\|↵b` |
| `abc[def]ghi`（选中 def） | `abcdef T \|ghi` |
| `我同意，\|` | `我同意， T\|` |

T 是现有选区钩子给出的文本（已去首尾空格、限 600 字符），原样插入，多行选区保留其中的换行。

**2. 光标位置怎么取。** 接受 chip 的那一刻，从输入框元素上读 `selectionEnd`（输入框失焦后浏览器仍保留它），不用缓存的状态；从未聚焦过的输入框就是文本末尾。

**3. chip 用后即退场。** 现状：点引用 chip 后会把原文存进 `pinnedQuote`，而决定 chip 是否显示的值是「实时选区，否则（输入框非空时）固定值」，所以 chip 一直留在那里（`utils/inputSuggestions.ts` 里引用来源的描述记录还有 `keepVisibleAfterFill: true`）。这是错的：引用已经插进文本，chip 的使命已完成；追加多段引用也不需要它，每引一段都要先重新选一段，新选区会让 chip 再次出现。修法：

- chip 是否显示**只看实时选区**。选区消失（输入框获得焦点、点击别处）或点击插入之后，chip 立即退场。
- 点击插入之后主动清除页面选区（`window.getSelection()?.removeAllRanges()`），保证 chip 一定消失，也不会因重复点击插入两次；然后聚焦输入框并把光标放到插入文本末尾。
- 固定值保留但改名为 `quoteAnchor`，只用于「建议」按钮的 `focus` 请求，**不再参与 chip 是否显示**；删除来源描述里的 `keepVisibleAfterFill` 字段。

**4. 撤销。** 插入是程序写入，浏览器没有原生撤销记录。现有的「最近一次填入」要把插入前的光标位置也记下来，Ctrl+Z 回到插入前的文本**和**光标位置。

**5. 删除「引用 → 回应」展开路径。** 现在展开实验里引用 chip 填入后会发一个只带 `focus` 的展开请求，靠 `> ` 前缀识别草稿里哪一段是引用（`useSuggestionChips.ts` 的 `splitQuotedDraft`）。不再有前缀，识别不了，所以整条路径删除：前端不再发只带 `focus`、不带 `seed` 的展开请求，`splitQuotedDraft` 删除；服务端 `expand: true` 必须带 `seed`，只带 `focus` 的展开请求按 400 拒绝；展开专用的「针对引用给出回应」提示词删除；展开来源的类型 `ReplySuggestionsExpansionSource` 只剩 `'seed'`（服务端与 `src/shared/types.ts` 各有一份，同步改）；用量日志的 `expansion` 取值只剩 `seed`；文档同步。**保留**：模型 chip 的 `seed` 变体展开（默认关闭的实验），以及「建议」按钮用引用文本作 `focus` 的普通重抽（它不是展开请求，其提示词里「想回应它」那一句要保留）。

**6. chip 预览。** `composer/InputSuggestionChips.tsx` 里引用 chip 的预览现在显示 `> 首行`，改成显示将要插入的原文首行（不带 `> `）。

**7. 发送去掉末尾的空格和回车。** 发出的消息内容现在就是输入框原文（`useChatComposerState.ts` 里 `content: currentInput` 等处），空输入框点引用后直接发送会带着末尾的两个回车。发送前对消息内容去掉末尾的空格和回车；所有发送路径（普通发送、排队的草稿、持久化草稿）一致处理；去掉之后为空的消息仍按现有规则不发送。

**范围外**：chip 内嵌在光标处并参与排版（另有任务，会同时删除占位行）；模型与习惯 chip 的接受行为（不变）；服务端之外的展开实验行为。

## AC

- [x] 插入规则的纯函数逐条通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/quoteInsertion.test.ts` 退出码 0（新增）；独立用例，逐行对应上面的示例表：(a) 空输入框；(b) `我同意|`；(c) `我同意 |`（前面已是空格，不补）；(d) `|后面`；(e) `前面|后面`；(f) `第一段↵|`（末尾空行，加 2 个回车）；(g) `a↵|↵b`（光标两侧都是回车，不补空格）；(h) 有选区时在选区末尾之后插入；(i) `我同意，|`（标点算文本，补空格）；(j) 光标在末尾但所在行不是空行（`我同意|`）不加回车，且在末尾时没有「后」空格；(k) 多行选区原样插入，内部换行保留；(l) 光标在末尾且所在行只有空格（`  |`）不算空行，不加回车；(m) 返回的新光标位置等于「光标处起点 + 追加内容的总长度」，下标按 UTF-16 单位（含代理对字符）。每条断言新文本与新光标位置。
- [x] 来源描述接口改为接收选区、返回新文本与新光标位置：`grep -rnE "buildFill\(chip, currentInput\)|buildQuotedFill" src --include=*.ts --include=*.tsx | grep -v tests/` 无任何输出（旧签名与旧函数已不存在）；`grep -rn "keepVisibleAfterFill" src` 无任何输出。
- [x] 接受契约测试按新规则更新且仍然通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/suggestionChipAcceptContract.test.tsx` 退出码 0；习惯与模型来源的断言不变（整段填入、光标在末尾）；引用来源的用例改为新规则（空框与非空框、光标在中间与末尾）；每个来源仍断言「焦点在输入框、没有发送、Ctrl+Z 回到接受前的文本与光标」；合成来源的用例保留。迁移不删用例、不放宽断言（`git diff --stat` 的删除与新增行数贴在 DoD 并说明每处删除的原因）。
- [x] 光标取自输入框元素：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx` 退出码 0（沿用既有文件新增独立用例）：(a) 输入框设了 `selectionEnd` 为中间位置后点引用 chip，插入位置跟随该位置；(b) 从未聚焦的输入框插入在末尾；(c) 点击后输入框聚焦且 `selectionStart === selectionEnd` 等于新光标位置；(d) 点击后页面选区被清除（`window.getSelection().rangeCount === 0` 或折叠）。
- [x] chip 用后即退场：同一测试文件内新增独立用例：(a) 点击引用 chip 且输入框非空后，引用 chip 不再渲染；(b) 之后再产生一个新的实时选区，引用 chip 再次出现；(c) 实时选区消失（输入框获得焦点）后 chip 消失，不因输入框非空而留下；(d) 不存在「固定值决定 chip 可见」的路径：`grep -rnE "pinnedQuote|effectiveQuotedSelection" src --include=*.ts --include=*.tsx | grep -v tests/` 无任何输出；(e) 「建议」按钮在引用之后仍带上 `quoteAnchor` 作为 `focus`（用请求体断言）。
- [x] 撤销带光标：同一测试文件内新增独立用例：插入后 Ctrl+Z 回到插入前的文本，且光标回到插入前的位置（不是末尾）。
- [x] 「引用 → 回应」路径已删除（按符号与联合类型判，不按中文词判）：`grep -rn "splitQuotedDraft" src` 无任何输出；`grep -rnE "'seed' \| 'focus'|'focus' \| 'seed'" server src --include=*.ts --include=*.tsx` 无任何输出（展开来源类型只剩 `'seed'`）；`grep -rn "expansion: 'focus'\|expansionSource === 'focus'" server src --include=*.ts --include=*.tsx | grep -v tests/` 无任何输出。服务端：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts server/modules/reply-suggestions/tests/reply-suggestions-usage-log.test.ts` 退出码 0（沿用既有文件）；用例：(a) `expand: true` 带 `seed` 仍然成功；(b) `expand: true` 只带 `focus`、`seed` 为空得 400 且无上游调用；(c) 不带 `expand` 的普通重抽带 `focus` 在 `expansion` 为 `off` 时仍成功，且其提示词仍含 focus 文本；(d) 用量日志的展开标记只有 `seed`。前端：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/replySuggestionsController.test.ts src/modules/chat/tests/useReplySuggestions.test.tsx` 退出码 0，展开请求必须带非空 `seed`，没有只带 `focus` 的展开用例。
- [x] 文档与基准同步：`docs/operations/reply-suggestions.md` 里关于「引用 → 回应」展开的段落已删除，展开只描述 `seed` 变体；`grep -nE "seed. / .focus|empty .?seed|\"seed\" \| \"focus\"" docs/operations/reply-suggestions.md` 无任何输出；`python3 -I experiments/reply-suggestions-bench/bench.py selftest --only replay` 退出码 0。
- [x] chip 预览不带 `> `：`grep -nE "return \`> " src/modules/chat/composer/InputSuggestionChips.tsx` 无任何输出；既有预览用例改为断言引用 chip 的预览是原文首行（不带 `> `），并且悬停与键盘选中模型 chip 时预览仍是该 chip 文本。
- [x] 发送去掉末尾空格与回车：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 退出码 0（沿用既有文件新增独立用例）：(a) 输入框 `T↵↵` 发送，发出的内容是 `T`；(b) `abc  ↵` 发送得到 `abc`；(c) 中间的空格与回车不受影响；(d) 排队草稿与持久化草稿两条发送路径同样去末尾；(e) 去掉之后为空的消息不发送。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0；`npm run build:server` 退出码 0。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。每一项都读 `textarea.value`、`selectionStart`、`selectionEnd` 贴出。

- [x] 把示例表的 9 种情形逐一在真页上做一遍（在 transcript 里选中同一段文字，把光标放到相应位置后点引用 chip）：贴出每一行的「插入前、插入后、光标位置」读数，与表中预期逐行对照。
- [x] chip 退场：点击插入后 chip 立即消失（截图），页面选区已清除（贴 `getSelection().rangeCount` 读数）；再选一段新文字，chip 再次出现；点回输入框，chip 消失。
- [x] 连续引用：连续引用两段（每次重新选中），贴最终输入框内容与光标位置，确认第二段插在第一段之后的光标处，没有重复插入。
- [x] Ctrl+Z：插入后撤销，文本与光标都回到插入前；贴读数。
- [x] 发送：空输入框点引用后不输入别的直接发送，贴网络请求里的消息内容，末尾没有空格与回车。
- [x] 展开实验开启（设置文件改成 `vary`，运行期按修改时间重读）：点模型 chip 触发 `seed` 变体展开仍然正常；引用 chip 点击后**没有**发出展开请求（贴网络请求计数）；「建议」按钮仍带着引用的 `focus`（贴请求体）。
- [x] 把设置文件的展开关掉（`off`）后重做一遍引用，结果与上面一致，网络里没有展开请求。
- [x] 390px 触屏模拟：引用与插入、chip 退场各做一次，贴截图与读数（`tmp/dod/mobile-1-chip.png`、`tmp/dod/mobile-2-after.png`；390x844 下插入后 `textarea.value = "OMITTED | Th\n\n"`、`selectionStart = selectionEnd = 14`、引用 chip 已退场）。
- [ ] iOS Safari 与 Android Chrome 真机上选中 transcript 文字后点引用 chip，确认插入位置、光标、chip 退场正常（待外部）
- [x] 贴出 `git diff --stat`，以及删除的文件与符号清单（`splitQuotedDraft`、`buildQuotedFill`、`keepVisibleAfterFill`、`pinnedQuote`、服务端展开专用的回应提示词）。
### 真页读数（隔离实例 127.0.0.1:3149，Playwright，2026-10-24）

T = `OMITTED | The uttera`（transcript 里选中的 20 字）。逐行与 Proposal 示例表对照（`tmp/dod/report.json`）：

| 情形 | 插入前 value / 光标 | 插入后 value | 插入后光标 |
|---|---|---|---|
| a 空输入框 | `""` / 0 | `T⏎⏎` | 22 |
| b `我同意\|` | `我同意` / 3 | `我同意 T` | 24 |
| c `我同意 \|` | `我同意␣` / 4 | `我同意 T` | 24 |
| d `\|后面` | `后面` / 0 | `T 后面` | 21 |
| e `前面\|后面` | `前面后面` / 2 | `前面 T 后面` | 24 |
| f `第一段⏎\|` | `第一段⏎` / 4 | `第一段⏎T⏎⏎` | 26 |
| g `a⏎\|⏎b` | `a⏎⏎b` / 2 | `a⏎T⏎b` | 22 |
| h `abc[def]ghi` | `abcdefghi` 选区 3..6 | `abcdef T ghi` | 28 |
| i `我同意，\|` | `我同意，` / 4 | `我同意， T` | 25 |

- **chip 退场**：点击后 `quotedChipStillDrawn: false`，`getSelection().rangeCount = 1` 且 `isCollapsed = true`（折叠 = 已清除）；再选一段文字 chip 再次出现（`retreat-2-selection-again.png`）；点回输入框 chip 消失（`retreat-3-focus.png`）。
- **连续引用**：第一段后 `OMITTED | The⏎⏎`（光标 15）；第二次插入后 `OMITTED | The⏎⏎OMITTED |⏎⏎`（光标 26）——第二段落在第一段之后的光标处，无重复插入。
- **Ctrl+Z**：插入前 `我同意` 光标 1 → 插入后 `我␣T␣同意` → 撤销后 `我同意` 光标 1。
- **发送**：输入框 `收到。发送探针的引用段落⏎⏎` 直接回车；WebSocket `chat.send` 帧的 `content = "收到。发送探针的引用段落"`（末尾无空格与回车）。探针会话是隔离库里的合成行（jsonl 在 `tmp/dod/`），该轮随即以 "No conversation found" 结束，未写入任何真实 transcript。
- **展开 vary**：点模型 chip 发出 `{expand:true, seed:"明白，已确认「已经」不在转发消息里；就按这个结论继续"}`，出现 3 条变体 chip（`expansion-1-vary-seed.png`）；随后点引用 chip —— 该时段到 `/api/reply-suggestions` 的请求数 **0**；点「建议」发出 `{redraw:true, focus:"OMITTED | The ut"}`（引用作为 focus 的普通重抽）。
- **展开 off**：引用插入 `OMITTED | The⏎⏎`（光标 15），请求数 0（`expansion-4-off.png`）。
- 全程 `pageerror` 为空；结束时隔离实例已 `stop`（`residual_scopes: ""`、端口不再服务），常驻 :3001 未动（/health 200）。

### git diff --stat（相对 merge-base 85d7013da）

```
 docs/operations/reply-suggestions.md               |  20 +-
 .../reply-suggestions/reply-suggestions-draw.ts    |   4 +-
 .../reply-suggestions/reply-suggestions-prompts.ts |  34 +-
 .../reply-suggestions/reply-suggestions.routes.ts  |   2 +-
 .../reply-suggestions/reply-suggestions.service.ts |  20 +-
 .../tests/reply-suggestions-routes.test.ts         |  10 +-
 .../tests/reply-suggestions-service.test.ts        |  30 +-
 .../tests/reply-suggestions-usage-log.test.ts      |   4 +-
 src/modules/chat/composer/InputSuggestionChips.tsx |  17 +-
 src/modules/chat/hooks/useChatComposerState.ts     |  17 +-
 src/modules/chat/hooks/useReplySuggestions.ts      |   9 +-
 src/modules/chat/hooks/useSuggestionChips.ts       | 208 ++++++----
 .../chat/tests/chatComposerReplyChips.test.tsx     | 426 ++++++++++++++++++---
 .../tests/inputSuggestionChipsBackground.test.tsx  |  10 +-
 .../chat/tests/inputSuggestionsComposer.test.tsx   |  36 +-
 src/modules/chat/tests/quoteInsertion.test.ts      | 108 ++++++
 .../tests/suggestionChipAcceptContract.test.tsx    | 144 ++++++-
 .../chat/tests/useReplySuggestions.test.tsx        |  15 +-
 src/modules/chat/utils/inputSuggestions.ts         | 117 ++++--
 .../chat/utils/replySuggestionsController.ts       |  31 +-
 src/shared/types.ts                                |  12 +-
 21 files changed, 964 insertions(+), 310 deletions(-)
```

**删除的符号 / 文件**：`splitQuotedPrefix`（原提案写作 `splitQuotedDraft`，同一函数）、`buildQuotedFill`、`keepVisibleAfterFill`、`pinnedQuote`、`effectiveQuotedSelection`、`expansionRequest` 描述字段（改为 `expansionSeed`）、`builtInExpansionSystemPrompt` 的 `source` 参数与其「针对引用回应」分支、`buildExpansionPrompt` 的 `focus` 参数与回应分支、服务端 `ReplySuggestionsExpansionSource` 的 `'focus'`、路由 `EXPANSION_SOURCES` 的 `'focus'`。没有删除文件。

**接受契约测试的删除行（+124/−20）：迁移不删用例、不放宽断言。** 20 行删除逐条：5 行文件头注释改写（描述新的光标与 seed-only 展开）、1 行测试桩类型 `'seed' | 'focus'` 收窄为 `'seed'`、1 行 `assertAccepted` 解构改为含 `expectedCaret/beforeCaret`、1 行旧的「光标在末尾」断言改为逐来源的精确光标断言、2 行 (a)(b) 的调用补上光标参数、2 行 (c) 的 `> text` 期望、2 行 (d) 的 `> …` 期望、3 行合成来源描述字段改名、3 行 (f) 里「引用发 focus」的期望。用例只增不减：(c)(d) 保留并改期望，新增 (d2) 光标居中、(d3) 光标在行尾空行两个引用用例。

## Touches

- `src/modules/chat/utils/inputSuggestions.ts`
- `src/modules/chat/hooks/useSuggestionChips.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/utils/replySuggestionsController.ts`
- `src/shared/types.ts`
- `src/modules/chat/tests/quoteInsertion.test.ts`
- `src/modules/chat/tests/suggestionChipAcceptContract.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx`
- `src/modules/chat/tests/replySuggestionsController.test.ts`
- `src/modules/chat/tests/useReplySuggestions.test.tsx`
- `server/modules/reply-suggestions/reply-suggestions.service.ts`
- `server/modules/reply-suggestions/reply-suggestions-prompts.ts`
- `server/modules/reply-suggestions/reply-suggestions-usage-log.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-usage-log.test.ts`
- `docs/operations/reply-suggestions.md`
- `tasks/gap-composer-quote-chip-insert-at-caret.md`
- `src/modules/chat/hooks/useReplySuggestions.ts`
- `server/modules/reply-suggestions/reply-suggestions.routes.ts`
- `server/modules/reply-suggestions/reply-suggestions-draw.ts`
