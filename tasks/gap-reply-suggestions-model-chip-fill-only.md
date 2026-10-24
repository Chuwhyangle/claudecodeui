---
id: gap-reply-suggestions-model-chip-fill-only
title: 模型回复 chip 点击只填入输入框、由人确认后手动发送（修复点击即发出）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-24 在 :3001 上的真实页面走查发现：点一个模型生成的回复 chip，文本被**立即发出**（输入框来不及确认），助手随即按这条文本开始行动并写了文件。预期行为是：点击或 Enter 接受 chip = 把文本**填入输入框**、光标在末尾、焦点留在输入框，由人看过、必要时编辑，再自己按发送。习惯 chip 本来就是这样（`acceptSuggestion`），引用 chip 与展开实验分支也是；只有模型 chip 的非展开分支多走了 `submitComposer()`。

**原因（已读代码确认）。** `src/modules/chat/hooks/useChatComposerState.ts` 的 `acceptSuggestionChip` 里模型分支与另一处按索引接受的 `onAcceptModel` 路径都在填入后调用 `submitComposer()`，注释写着「模型回复是完整的，所以点击＝填入并发送」。这来自前端任务正文里「点击 = 填入再发送」这句有歧义的话：它的原意是「填入，之后由人发送」，被当成了自动发送；该任务的 DoD 还写了「点一个模型 chip 后文本被发出」，进一步固化了误读。`src/modules/chat/tests/chatComposerReplyChips.test.tsx` 里有一条用例（标题为 fills AND sends the complete text when a model chip is accepted）把错误行为钉住了。

**要做的事。**

- 模型 chip 的两处接受路径都改为：`reportReplySuggestionEvent('picked', index)` 照旧，文本填入输入框（走与习惯 chip 同样的「写两份存储 + 聚焦 + 光标到末尾」的路径），**不调用 `submitComposer()`**。展开实验开启时的分支不变。
- `sent` 事件的语义保持：只有人之后发出的文本与 chip 填入的文本完全相同时才上报；用户编辑过、清空、或换成别的 chip 后，`modelChipFillRef` 要失效，不能让一条被改过的消息记成 chip 的「sent」。现有 `commitSentComposerState` 里的比较逻辑保留，补上「编辑即失效」的覆盖。
- 同步改正三处措辞：`src/modules/chat/tests/chatComposerReplyChips.test.tsx` 文件头注释与上述用例标题；`docs/proposals/composer-reply-suggestions-llm.md` 里「点击 = 填入再发送」改成「点击 = 填入输入框，由人确认后发送」并说明 Enter 在 chip 被选中时同样只是接受；`docs/operations/reply-suggestions.md` 已写 "never sends"，核对它与行为一致即可。
- 输入框下方提示行的「Enter to accept」不改：接受就是填入。

**范围外**：窄屏底栏宽度、chip 行遮挡文字、预览错位、「建议」在新会话的空操作、chip 尾部多余标点——各有单独任务。

## AC

- [x] 模型 chip 点击只填入：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx` 退出码 0；用例（独立）：(a) 点击模型 chip 后输入框内容等于 chip 文本、焦点在输入框、光标在末尾，发送回调与表单提交均未被调用；(b) 选中模型 chip 后按 Enter 同样只填入、不发送；(c) 填入后再按一次发送键才发出，且恰好上报一次 `sent`；(d) 填入后用户改动文字再发送，不上报 `sent`；(e) 填入后换点另一个 chip，旧的填入记录失效，发出新文本时只按新 chip 判断；(f) 展开实验开启时模型 chip 的行为与改动前一致（填入、请求展开、不发送）。原先标题含 fills AND sends 的用例被改写为 (a)，而不是保留后加 `skip`。
- [x] 兄弟测试不被打红：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx src/modules/chat/tests/useReplySuggestions.test.tsx` 退出码 0。
- [x] 行为反证：把 `acceptSuggestionChip` 的非展开模型分支临时改回调用 `submitComposer()`，上面 (a) 与 (b) 必须变红；恢复后 `git diff` 对该文件为空（过程贴在 DoD）。
- [x] 措辞三处一致：`grep -c "fills AND sends" src/modules/chat/tests/chatComposerReplyChips.test.tsx` 为 0；`grep -nE "填入再发送" docs/proposals/composer-reply-suggestions-llm.md` 无任何输出；`grep -c "never sends" docs/operations/reply-suggestions.md` ≥ 1。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

在真实运行的页面上操作并截图，存 `tmp/`，截图随任务贴出。用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**。测试会话的提示词里要明确写「不要写代码、不要调用任何工具」，并在结束后核对没有在仓库内外留下测试产物。

证据材料在 `tmp/model-chip-fill/`（截图 `before-click.png` / `after-click.png` / `after-send.png` / `after-edit-send.png` / `after-tab-enter.png`，读数 `before.json` / `fill.json` / `send.json` / `edit.json` / `keyboard.json`）。隔离方式：仓库 e2e 运行器自起的独立 data dir / HOME / DATABASE_PATH（每腿一个全新 data dir），`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，`REPLY_SUGGESTIONS_SETTINGS_PATH` 指向真实网关设置文件的副本（`apiKeyFile` 改为绝对路径），未触碰常驻 :3001、未重启常驻服务。五条腿各用一个独立 session（`e2e-model-chip-fill-a…e`），避免服务端「已展示 chip」记忆把后续抽取滤空。

- [x] 复现旧行为（改动前）：让助手以提问结尾，点第一个模型 chip，贴截图与网络请求，证明消息被立即发出。→ 旧客户端（develop 版 hook，经 `QUAY_E2E_CLIENT_ROOT` 快照服务）点 chip 后：用户消息行 1→2、输入框被清空、页面发出的帧里恰好 1 条 `chat.send`，其 `content` 就是 chip 文本；ledger 依次 `shown`、`picked`、`sent`。截图 `before-click.png`，读数 `before.json`。
- [x] 改动后：同样操作，贴截图——输入框里是 chip 文本、光标在末尾、没有新的用户消息；网络请求里没有发送消息的请求。→ 输入框值等于 chip 文本、`document.activeElement` 是该 textarea、`selectionStart == text.length`（15）、用户消息行仍为 1、`chat.send`/`chat.edit-send` 帧数为 0；ledger 只有 `shown`、`picked`。截图 `after-click.png`，读数 `fill.json`。
- [x] 随后手动按发送，助手收到的文本与输入框一致；贴截图，以及 `/api/reply-suggestions/events` 里依次出现 `picked` 与 `sent` 的读数。→ 发送后出站的 `chat.send.content` 与输入框完全一致；ledger 依次 `shown`、`picked`、`sent`（`picked` 在下标 1、`sent` 在下标 2）。截图 `after-send.png`，读数 `send.json`。
- [x] 填入后改动一个字再发送，贴 events 读数：只有 `picked`，没有 `sent`。→ 在 chip 文本末尾加一个「。」后发送，`chat.send.content` 是改过的文本；ledger 只有 `shown`、`picked`，没有 `sent`（`modelChipFillRef` 在编辑时失效）。截图 `after-edit-send.png`，读数 `edit.json`。
- [x] 用 Tab 选中 chip 再按 Enter，贴截图，同样只填入。→ 点击输入框后按 Tab，`aria-activedescendant` 指向第一个 chip option；按 Enter 后输入框为 chip 文本、焦点仍在输入框、光标在末尾（14）、`chat.send` 帧数为 0；ledger 只有 `shown`、`picked`。截图 `after-tab-enter.png`，读数 `keyboard.json`。

反证过程（AC3）：在 `acceptSuggestionChip` 非展开模型分支的 `acceptSuggestion(chip.text)` 之后临时加回 `submitComposer()`，`vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx` 得 `Tests 2 failed | 18 passed`，失败的正是 (a) 与 (b)；`git checkout -- src/modules/chat/hooks/useChatComposerState.ts` 恢复后 `git diff` 对该文件为空，同一命令恢复为 `20 passed (20)`。

测试卫生：临时 e2e seed 与一次性 spec、`playwright.config.ts` 的临时预算条目均已还原/删除（`git status --short` 为空）；e2e 运行留下的隔离 data dir 已清理；两个发送腿因种子 session id 不是 UUID，隔离实例里的 `claude --resume` 只报错、未调用工具、未写代码，仓库内外无测试产物。

## Touches

- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `docs/proposals/composer-reply-suggestions-llm.md`
- `docs/operations/reply-suggestions.md`
- `tasks/gap-reply-suggestions-model-chip-fill-only.md`