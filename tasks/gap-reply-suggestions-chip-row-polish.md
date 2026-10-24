---
id: gap-reply-suggestions-chip-row-polish
title: 回复建议四个小问题：引用后 chip 行遮挡文字、预览与选中项错位、新会话「建议」空操作、chip 尾部多余标点
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-24 在 :3001 真实页面走查（截图 `tmp/rs-live-*.png`，该目录不入库）发现四个相互独立的小问题，合为一个任务：它们都在 chip 行与「建议」按钮的同一小块代码里，分开做会反复改同几个文件。

**1. 点「引用」后，chip 行盖在输入框第一行文字上。** 现象：点引用 chip 后输入框里是 `> 原文` 加换行，而 pinned 的引用 chip 仍显示在输入框顶部，把第一行文字遮住。读数：输入框 `getBoundingClientRect` 的 top 为 670、高 88；chip 行 top 为 678、高 24，落在第一行文字内。原因：`src/modules/chat/composer/InputSuggestionChips.tsx` 的行是 `pointer-events-none absolute inset-x-0 top-0 z-10` 的覆盖层，只为「空输入框」设计；引用 chip 放宽成非空也显示，却没有给文字让位。期望：任何时候 chip 行与输入框里的文字不重叠。做法由实现者选（文字让位：非空时给 textarea 加上与 chip 行等高的上内边距；或填入后让引用 chip 退场，因为它已经完成使命），但要在 DoD 里说明选了哪种以及为什么。

**2. 引用 chip 被选中时，输入框第二行的灰色预览显示的是别的 chip 的文本。** 现象：引用 chip 排在最前并有高亮边框，但预览仍是第一个模型 chip 的文本。期望：预览永远对应「当前悬停或键盘选中的 chip」，没有悬停与选中时才回退到第一个**模型** chip；选中的是引用 chip 时，预览显示它将填入的内容（`> 原文` 的首行，截断显示）。

**3. 「建议」按钮在没有助手消息的会话里是无声的空操作。** 现象：新会话页按钮可见、没有禁用样式，点击后既不发请求也没有任何提示（网络面板里没有 `POST /api/reply-suggestions`）。期望：没有可回应的助手消息时不显示该按钮（与 `/status` 为关闭时一致）；有助手消息、但请求失败时给出一个短暂的失败状态（按钮短暂显示失败态或提示），不能静默。

**4. 模型 chip 文本末尾常带一个多余的「；」。** 现象：发出的文本是「选 Python 单文件脚本，附带测试；」；预览里「挪到仓库内吧，顺便加个简短 README 带调用示例；」同样如此。原因：内置提示词要求第 1 条用「；」分隔各待答点，只有一个要点时尾巴残留。期望：`reply-suggestions.service.ts` 在解析 chip 时去掉末尾的分隔类标点（`；`、`;`、`，`、`,`、`、`），保留句末的「。」「？」「！」以及成对括号；同时在内置提示词里补一句「单个要点时不要以分隔符结尾」。这属于服务端对 chip 文本的后处理，要有解析层的单测。

**范围外**：模型 chip 的点击行为（另有任务）；窄屏底栏溢出（另有任务）；扩展实验。

## AC

- [x] 引用后不遮挡（纯逻辑可测部分）：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 退出码 0（沿用既有文件新增独立用例）：(a) 输入框非空且引用 chip 可见时，渲染结果里文字区域与 chip 行的垂直位置不重叠（用结构断言：textarea 的上内边距类或 chip 行的退场之一成立，具体断言按实现选的方案写）；(b) 输入框为空时的布局与改动前一致；(c) 引用被点击填入后，chip 行与文字的关系符合所选方案。
- [x] 预览跟随选中项：同上两个测试文件内新增独立用例：(a) 悬停引用 chip 时预览是它将填入的内容首行；(b) 键盘选中某模型 chip 时预览是该 chip 的文本；(c) 没有悬停与选中时，预览是第一个**模型** chip（没有模型 chip 时不显示预览）；(d) 选中从引用 chip 移到模型 chip 再移回，预览随之变化。
- [x] 「建议」按钮可见性与失败态：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/useReplySuggestions.test.tsx` 退出码 0（沿用既有文件新增独立用例）：(a) 没有助手消息时不渲染「建议」按钮；(b) 有助手消息时渲染；(c) 点击后请求失败，按钮进入可见的失败态并在数秒后恢复，没有未捕获异常；(d) `/status` 为关闭时仍不渲染（原有行为不回退）。
- [x] 尾部标点后处理：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts` 退出码 0（沿用既有文件新增独立用例）：(a) 「选 Python；」解析成「选 Python」；(b) 「好，就这样,」去掉末尾逗号；(c) 句末「？」「。」「！」保留；(d) 末尾是右括号或引号时不动；(e) 只有标点的 chip 被丢弃而不是留下空串；(f) 去重发生在去尾标点之后（「甲；」与「甲」算同一条）。
- [x] 提示词补句：`grep -c "不要以分隔" server/modules/reply-suggestions/reply-suggestions.service.ts` ≥ 1，且 `bash`-可运行的提示词用例验证默认提示词含该句。
- [x] 行为反证：把第 4 条后处理临时改成恒等，则尾部标点用例 (a)(b) 变红；把第 3 条的可见性条件临时去掉，则 (a) 变红；恢复后 `git diff` 为空（过程贴在 DoD）。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；不要在运行中的会话页面按 Escape；测试会话的提示词要写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。

- [x] 问题 1：在真页里选中 transcript 的一段文字、点引用 chip，贴截图与几何读数：输入框内第一行文字的 top 与 chip 行的 bottom，证明不重叠；说明选了哪种方案及原因。再贴空输入框时的截图，证明布局未变。
- [x] 问题 2：选中文字出现引用 chip 时，贴截图：预览显示引用首行；Tab 切到模型 chip，贴截图：预览变为该 chip 文本。
- [x] 问题 3：新会话页截图：没有「建议」按钮；有助手消息后截图：按钮出现；把设置里的模型改成错的再点一次，贴失败态截图与控制台读数（无未处理错误）。
- [x] 问题 4：用真实网关抽取 5 次（每次独立 session，避免被「已展示」去重吞掉），贴出全部 chip 文本，证明没有以分隔标点结尾；再贴一条以「？」结尾的 chip 仍保留问号。
- [x] 窄屏回归：390px 下重做问题 1 与 2，贴截图。

## Evidence

**隔离实例**：在本 worktree 起后端 `SERVER_PORT=3241`、前端 Vite 5241；`DATABASE_PATH=/tmp/gap-chip-verify/auth.db`（live auth.db 的 sqlite backup），`SERVER_SETTINGS_PATH=/tmp/gap-chip-verify/server.settings.json` = `{"residentRestore":{"enabled":false}}`，`REPLY_SUGGESTIONS_SETTINGS_PATH` 指向 live 网关设置的副本（baseUrl `127.0.0.1:26510` / model `v4.1flash`）。常驻 :3001 未碰、未重启；`ps` 中没有本实例新起的 `claude --resume`（现存那批始于 17:55，早于本实例 19:10）。没有新建测试会话，因此无需下发「不要写代码、不要调用任何工具」的提示词：页面只读既有 transcript 并调用 `POST /api/reply-suggestions`。收尾后 3241/5241 均已关闭、无残留进程。

**AC 判据读数**（提交 `063141791`）：
- `bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx src/modules/chat/tests/inputSuggestionsComposer.test.tsx` → 2 files / 47 passed，exit 0。
- 同上换 `src/modules/chat/tests/chatComposerReplyChips.test.tsx src/modules/chat/tests/useReplySuggestions.test.tsx` → 2 files / 41 passed，exit 0。
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts` → 22 pass / 0 fail，exit 0。
- `grep -c "不要以分隔" server/modules/reply-suggestions/reply-suggestions.service.ts` → 1；用例 (t) 断言默认 system prompt 含该句。
- `npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning）。

**行为反证（AC6）**：把 `stripTrailingSeparatorMarks` 临时改成恒等 ⇒ server 用例 (p)(r)(s) 变红（19 pass / 3 fail）；把 `useReplySuggestions.enabled` 的 `lastAssistantMessageId !== null` 临时去掉 ⇒ hook 用例 (i) 与 composer 用例 (a) 变红。两处均改回原样；改回后 `git diff` 对这两处为空（恢复期间另提交了 `88b4284a1`：把「不存在」断言改成布尔比较，避免失败消息序列化 DOM 节点导致 worker OOM）。

**问题 1（方案：文字让位，48px flow spacer）**：不用 textarea 上内边距的原因来自真机读数——`paddingTop=48px` 生效后 textarea 的 `height` 仍是 64px、`scrollTop=40`，即自动增高在 class 落地前用旧 padding 量过，浏览器把首行又滚回 chip 行下面（`item1-after-quote` 的早期版本可见文字与 chip 重叠）。改为 `[data-slot="chip-row-clearance"]` 的 `h-12` flow spacer，在测量之前就位；高亮 overlay 同步 `pt-12` 保持口述底色对齐。1280×900 填入 `> environmental — it was this task's own` 的真机读数：`firstLineTop=742`、`chipRowBottom=726`、`previewBottom=730` → 不重叠；空输入框时无 spacer（`chipRowOverText=false`），布局不变。截图：`tmp/gap-chip-verify/item1-empty-box.png`、`item1-after-quote.png`。

**问题 2**：实页读数：悬停引用 chip → preview 文本 `> environmental — it was this task's own`（`data-suggestion-preview=quoted`）；Tab 选中 model chip → preview 变为「收到，按你说的让 worker-driver 跑 fan-in」（source=model）；Shift+Tab 回到引用 → preview 回到 `> …`。截图 `item2-hover-quoted.png`、`item2-tab-model.png`。

**问题 3**：点侧栏「New Session」进入空会话页（textarea 1、chip 行 0）：`[data-slot="reply-suggest-button"]` 0 个（`item3-new-session.png`）；打开有 9 条助手消息的会话：按钮 1 个、state=idle（`item3-assistant-button.png`）；把网关设置副本的 model 改成不存在的值再点 Suggest → 按钮显示红色「Suggest failed」、`data-reply-suggest-state="failed"`，约 3s 后回到 idle（`item3-failure.png`）。`pageerror` 0 条；console 只有既有的 403 资源、既有的 cockpit `validateDOMNesting` 警告，以及本次预期内的 502（失败请求本身），无未处理异常。

**问题 4**：真实网关 5 次抽取，5 个独立 session（`POST /api/reply-suggestions`，读数 `tmp/gap-chip-verify/report-item4.json`），共 15 条 chip：
1. 就选 fleet-liaison-stable-addressing-probe，直接派发 / 先别派发，我再看看别的候选 / 确认，派发这个
2. 全部通过，按你说的留给 fan-in 做全量测试和类型检查；合并已完成，工作树干净 / 先别急着 fan-in，我想再看看 charter grantScope 的 fail-closed 逻辑 / 收到，10/10 和 73/73 都过了，继续
3. 好，已确认 eligible，继续推进 / 先别推进，我想再核对一下那四个 (new) 标注 / 收到，保持现状
4. 已确认，全部通过，可以继续；接下来需要我做什么？ / 先别推进，我想再看看 Touches 的改动 / 收到，谢谢
5. 收到，按你说的交给 worker-driver 接管；我这边不再动 worktree / 先别交接，把全量测试跑一遍再交 / 好，记下了

末尾分隔标点违例 0 条（`；;，,、` 全无）；draw 1 首条的原始尾部「；」已被去掉。draw 4 首条以「？」结尾，问号保留。

**窄屏 390×844**：重做问题 1/2。填入后 `firstLineTop=722`、`chipRowBottom=706`（不重叠）；悬停引用 → preview `> Done. The prior round's suite red is fix`；Tab 到 model chip → preview「收到，按你说的退出，交给 driver 合到 develop；不用我再跑全量测试。」。截图 `narrow-item1-empty.png`、`narrow-item2-hover-quoted.png`、`narrow-item2-tab-model.png`、`narrow-item1-after-quote.png`。

**测试产物核对**：isolated usage ledger 落在临时 HOME（`/tmp/gap-chip-verify/home/.cloudcli/reply-suggestions-usage.jsonl`，27 行）；live `~/.cloudcli/reply-suggestions-usage.jsonl` 的近期新增行全部是 live 会话（`d01bc610` / `98c54580`）的既有使用，与本实例 session 无关。没有新建会话行、没有向任何 transcript 写入。截图与一次性脚本仅在 worktree 的 gitignored `tmp/gap-chip-verify/`。

## Touches

- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/hooks/useReplySuggestions.ts`
- `src/modules/chat/hooks/useInputSuggestions.ts`
- `src/modules/chat/tests/inputSuggestionChipsBackground.test.tsx`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `src/modules/chat/tests/useReplySuggestions.test.tsx`
- `server/modules/reply-suggestions/reply-suggestions.service.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts`
- `tasks/gap-reply-suggestions-chip-row-polish.md`

## Blocker

**2026-10-24T11:28:07.974Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=ff: fan-in-ff-merge: suite 证书 — suite_head..tip 恰为本任务的单个 flip-done 提交（身份判定：仅 M tasks/gap-reply-suggestions-chip-row-polish.md）⇒ 判惰性，⛔ 未调分类器
fan-in-ff-merge: FF FAILED — To .; not a fast-forward. Retry record written (attempt 1). Return to 无锁段 step 1 (merge develop again — 必须 merge 不得 rebase, AC75), re-judge the delta (step 2) and re-run.
fan-in-ff-merge: measure ff_only_locked=false
- run_id：wk-prod-anchor
- session_id：e20d3a45-2174-46c7-9cd1-a07786f71e45
