---
id: gap-ac207-partial-message-window-read
title: AC-207 判据在转写分页窗口载满前读数：collapsed 读成 6 行/329px（真空绿）、首段成员数读成 4（[4,5,8]）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-207
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-10-21）：`grep -l "^goal_ac: AC-207" tasks/*.md` 只命中两份 **done** 任务——`gap-work-segment-browser-density-and-search-expand`（判据本体）与 `gap-ac207-expand-all-first-segment-recollapse`（上一次的间歇红修复）。按规则 done 不是重复，而是「上一次的修法没能让判据现在为真」的证据；在飞（todo/ready/needs-human）任务里没有一份携带 `goal_ac: AC-207`。`task-granularity-advice.js --touches e2e/transcript-work-segments.spec.ts` 的 `peers[]` 与 `mentions[]` 均为空（没有在飞任务认领同一文件），故单独立案、不并入他条。

**现状（直接测量，不是台账尾巴）。** AC-207 的 acceptance 是 `npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"`。`.quay/gate-events.jsonl` 最近四次：2026-10-21T13:37:30Z pass、13:40:38Z pass、13:44:26Z pass、13:48:11Z **fail**，四次的 `treeSha` 全是 `519ec5997329b8ad356f342952760613685f4ce0`。同一棵树四分钟内先绿后红 ⇒ 不是代码 delta 造成的回归，而是判据自身的间歇读数。

**红的逐字形态（落盘工件）。**
`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Ctf0Of/test-results/transcript-work-segments-w-2ce84-earch-hit-opens-its-segment/error-context.md`：
```
Error: each header count is its run’s member count (7, 8 and 5 in the fixture)
expect(received).toEqual(expected) // deep equality
- Expected  - 1
+ Received  + 1
  Array [
+   4,
    5,
-   7,
    8,
  ]
```
同一次运行的密度读数（trace 步骤逐字）是 `the collapsed transcript drew 6 rows at height 329px`——它**通过**了 `< 12` 与 `< 556` 两条断言。绿运行的对应读数一直是 `7 rows / 410px`（见上一条 done 任务的 Evidence）。6 vs 7、329 vs 410 是本条要解释的差。

**机制（从落盘 trace 逐条读出的链，不是猜测）。**
1. fixture 共 24 条消息：1 条 user prompt + 第一段 7 + 1 条 text + 第二段 8 + 1 条 text + 第三段 5 + 1 条 text（`playwright.config.ts:2099` 的 `seedWorkSegmentTranscript`）。
2. 客户端首屏按 `SESSION_MESSAGES_PAGE_SIZE = 20` 取最新一页（`src/modules/chat/utils/session/sessionMessagePagination.ts:3`，`useChatSessionState.ts:629/1678`）。失败运行的 network trace 里逐字可见 `GET /api/providers/sessions/e2e-work-segment/messages?limit=20&offset=0 → 200`，随后 `GET …/messages?limit=50&offset=20 → -1`（**未完成**）——older 页在读数时仍在飞。
3. 24 取最新 20 ⇒ 丢掉最早的 4 条（prompt + 第一段前 3 个成员）⇒ 第一段只剩 4 个成员；collapsed 画面 = 3 个段头 + 3 条 text = **6 行 / 329px**。
4. older 页落地后补齐为 4 条 text + 3 个段头 = 7 行 / 410px，第一段恢复 7 个成员。
5. 读数 (i) 是**上界**断言（`< ROW_LIMIT` / `< PX_LIMIT`），窗口没载满反而更容易通过；进入读数的条件只有「第一行 `.chat-message` 可见」＋ `settledDensity` 两次采样相同（`e2e/transcript-work-segments.spec.ts:229-232`），完全不判别 fixture 是否已整份在屏。红最终落在嵌入的 AC-208 标题读数（`:255-260` 的 `toEqual([5,7,8])`）只是因为它恰好是等值断言。⇒ **读数 (i) 的真空绿是本条的根因；标题读数是症状。**

**为什么上一次的修法没兜住。** 8486f354 修的是「全展开正控制在 Vite 整页重载后首段塌回折叠」，它用 `settledDensityWithEverySegment` 把**正控制**的段头状态在读数文档上重建；但最初两个读数（`:232` 的 `collapsed` 与 `:255` 的 `readSegmentTitles`）仍发生在「第一行可见」之后立刻。上一次修的是「跨重载保住展开态」，本条缺的是「夹具的消息窗口已载满」——两条不同的起点条件，所以上一次的修法对它无效。

**方向（判据侧；不改产品语义）。** 分页窗口是设计，AC-110 明确钉住首屏那 20 条的形状，因此**不得**为了这条判据去改 `SESSION_MESSAGES_PAGE_SIZE`、预载全量或改产品加载路径。判据要做的是：在**同一份将被测量的文档上**建立「夹具会话已完整」这一状态，再读密度与标题。可用的机械读数（择一或组合）：(a) 在 `.chat-messages-pane` 内等到 fixture 最早那条 user prompt（`Show me the release notes for the work segment browser.`）出现；(b) 等到该会话的 older 页请求已落地且 `hasMore` 为假（经 DOM/网络可观测的读数，不读内部 ref）；(c) 等到窗格内 `[data-work-segment-key]` 的第一段成员计数达到夹具的 7。阈值、`ROW_LIMIT`/`PX_LIMIT`/`PRE_MERGE_BASELINE_*` 与 (i)(ii) 两条腿的断言一律不动。若探针证明窗口在「内容不足一屏」时不会自动补页，就驱动用户自己的滚到顶/「Load all」手势，并记录这一手势——不得改用 sleep 或放大页大小。

**判别力要求（防止把修法写成「多等一会」）。** 在 older 页被延迟/阻断时，现行判据会以 6 行/329px 通过读数 (i)、随后在标题读数上红——这是可确定复现的基线。修后同一注入下，判据必须红在**新增的完整性读数**上（或明确报出窗口未载满），而不是照旧通过然后红在别处；解除注入后复绿。只有这样才能证明新条件是判别性的，而不是一段固定等待。

## AC

- [x] AC1 确定性复现（承重）：在 e2e 层用 `page.route` 延迟（或阻断）`**/providers/sessions/e2e-work-segment/messages*offset=20*` 这条 older 页，使读数发生在它落地之前；逐字记录现行判据的读数与失败：`collapsed {"rows":6,"heightPx":329}` 通过、`each header count is its run’s member count (7, 8 and 5 in the fixture)` 收到 `[4,5,8]`。同形复现 ≥3 次。命令与逐字输出入 Evidence。
- [x] AC2 判据修到根上（承重）：在 `collapsed` 与 `readSegmentTitles` 之前，于同一份被测量的文档上建立「夹具会话已完整」的读数（见 Proposal 的 (a)/(b)/(c)），并写明选哪一条、为什么它不会被部分窗口骗过。`git diff` 只含这段起点逻辑；`PRE_MERGE_BASELINE_ROWS/PX`、`ROW_LIMIT`、`PX_LIMIT` 与两条腿的断言逐字未变（`git diff` 可核对）。
- [x] AC3 新条件有判别力（承重）：保持 older 页延迟/阻断，修后的判据必须**红在那条完整性读数上**（逐字失败行，例如等待超时或明确的「窗口未载满」）；解除阻断后同一命令复绿。红在别的腿不算满足。
- [x] AC4 稳定绿（承重）：安静态 `npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"` 连续 ≥5 次 exit 0；每次落盘 `collapsed` 与 `expanded` 读数，collapsed 每次为 7 行/≈410px（6/329 的形态不再出现），expanded 每次 ≥24 行。5 次读数逐条入 Evidence。
- [x] AC5 两条假形态仍红（承重）：(a) `groupWorkSegments` 首行 `return messages;`（一行一块）⇒ 读数 (i) 红；(b) 关掉 `ChatMessagesPane.tsx` 的搜索命中自动展开 ⇒ 读数 (ii) 红。逐条记录变异 diff、逐字失败行，`git checkout -- <file>` 恢复后判据复绿。
- [x] AC6 静态门：`npm run typecheck` 与 `npm run lint` 均 exit 0（只改 spec 也要跑）。
- [ ] AC7 台账翻转：合入 develop 后由驱动重跑判据，AC-207 的 goal acceptance 连续 ≥2 轮 pass，台账尾不再是 fail（待外部）

## DoD

- 红是可确定性复现的对象：older 页注入的命令、改前读数（6 行/329px 真空绿 + `[4,5,8]`）与改后读数（7 行/≈410px + `[5,7,8]`）都逐字在 Evidence 里，不是「跑几遍碰运气」。
- 修的是「读数发生在分页窗口载满之前」这条链：能说清新条件如何区分「完整夹具」与「最新 20 条」，并给出 AC3 的判别读数；不接受 sleep、固定重试、放宽阈值或放大页大小。
- 五连绿逐次落盘且读数落在阈值同侧；两条假形态仍红。
- 不把本运行里的 401/403 控制台噪音、或启动空白页类的 load flake 当成本条原因（失败运行里三段头、密度读数、转写正文都已渲染）。
- 只动 `## Touches` 列出的文件；若确实需要改别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- e2e/transcript-work-segments.spec.ts
- tasks/gap-ac207-partial-message-window-read.md

## Evidence

**AC1 确定性复现（同一注入，4 次同形）。** 在 spec 内临时加 `page.route('**/providers/sessions/e2e-work-segment/messages*offset=20*', …)`，把 older 页（逐字 URL `…/messages?limit=50&offset=20`）挂起 20s，使读数落在它落地之前（探针只在本工作树，提交前已移除）。命令：`AC207_OLDER_PAGE_DELAY_MS=20000 npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"`。逐字：`[AC-207][probe] holding older page http://127.0.0.1:8767/api/providers/sessions/e2e-work-segment/messages?limit=50&offset=20`、`[AC-207][probe] collapsed {"rows":6,"heightPx":329}`（两条上界断言都通过），随后 `Error: each header count is its run’s member count (7, 8 and 5 in the fixture)` / `+   4,` / `-   7,`（收到 `[4,5,8]`）。另外三次独立运行（端口 26979 / 30411 / 15441）同一失败行逐字相同。

**AC2 起点逻辑（diff：38 insertions / 0 deletions，只加不删）。** 选 Proposal 的 (a) 腿：在 `.chat-messages-pane .chat-message` 里等 fixture 最早的 user prompt 行（`Show me the release notes for the work segment browser.`）出现。为什么它不会被部分窗口骗过：该行只存在于 older 页（最新 20 条从第一段第 4 个成员开始），所以它在同一份被测 DOM 里出现 ⇔ older 页已落地、窗口 = 完整 24 行；密度或成员计数都能被「窗口短」伪造，这一条不能。helper 同时在全展开正控制每次重读数前调用（文档被 Vite 重载替换后的新 pane 也从最新 20 条开始）。`git diff` 核对：`PRE_MERGE_BASELINE_ROWS/PX`、`ROW_LIMIT`、`PX_LIMIT` 与 (i)(ii) 两条腿的断言逐字未变。

**AC3 判别力。** 保持注入（`AC207_OLDER_PAGE_DELAY_MS=120000`）跑修后判据，红在新增完整性读数上：`Error: the pane never showed the fixture’s first row: the older page had not landed, so the transcript held only its newest 20 rows and would be measured as a short (but not merged) turn`（`expect(locator).toBeVisible() failed` / `element(s) not found`，30s 等待超时）。解除注入（同一命令、无 env）复绿：`[AC-207] collapsed {"rows":7,"heightPx":413} expanded-positive-control {"rows":27,"heightPx":1290}` / `1 passed`。

**AC4 五连绿（逐次落盘）。** `npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"`：
- RUN1 exit 0 `collapsed {"rows":7,"heightPx":413}` `expanded-positive-control {"rows":27,"heightPx":1290}` 12.7s
- RUN2 exit 0 同读数 12.4s
- RUN3 exit 0 同读数 13.2s
- RUN4 exit 0 同读数 14.1s
- RUN5 exit 0 同读数 12.6s

collapsed 每次 7 行 / 413px（6/329 形态不再出现），expanded 每次 27 行 ≥ 24。

**AC5 两条假形态（先提交实现再变异，跑完 `git checkout --` 恢复）。**
- (a) `src/modules/chat/utils/transcript/workSegments.ts` 的 `groupWorkSegments` 首行插入 `return messages;`（+1 行）：逐字 `Error: the collapsed transcript drew 24 rows at height 1161px`（读数 (i) 红）。恢复后 `git status --porcelain` 干净、复绿 `collapsed {"rows":7,"heightPx":413}`。
- (b) `src/modules/chat/transcript/ChatMessagesPane.tsx` 搜索命中自动展开 effect 首行插入 `return;`（+1 行）：逐字 `Error: the segment holding the search hit never opened` / `Timeout 20000ms exceeded while waiting on the predicate`（读数 (ii) 红；同次 collapsed/expanded 读数仍通过，红在这条腿）。恢复后复绿 `1 passed`。

**AC6 静态门。** `npm run typecheck` exit 0（tsconfig + server/tsconfig + scripts/tsconfig 三段全过）；`npm run lint` exit 0（仅仓库既有 warning，无新增）。

**写面。** 实现提交后 `git status --porcelain` 仅 `M e2e/transcript-work-segments.spec.ts`；两处变异均以 `git checkout --` 复原。