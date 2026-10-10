---
id: gap-fork-button-hidden-while-session-running
title: 会话运行期间 fork 按钮不应整会话消失：只在进行中的回合上隐藏，已结束回合的回复照常提供「从这里分支」
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

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -il "isSessionRunning" tasks/*.md` 只命中 `gap-fork-from-assistant-reply-anchor`（已 done，正是引入这个条件的任务）和一条与 fork 无关的 quay 快照任务；`ls tasks | grep -i fork` 无任何任务认领「运行期间按钮显隐范围」。⇒ 本条不是重复，是对 `gap-fork-from-assistant-reply-anchor` 的一处过度保守的收窄。

**现象（人的报告，2026-10-10）**：服务多次重启后，user message 与 assistant message 底部都看不到分支图标。

**实测读数（本轮，只读，不改线上）**：
1. 部署无问题：`dist-server`（2026-10-10 08:10 重建）与被提供的前端 bundle 都含 `forkAnchorId`。
2. 服务端读取层无问题：对真实会话的全量历史，每个已结束回合恰有 1 条带 `forkAnchorId` 的回复；末尾仍在进行的回合没有（预期）。
3. 浏览器实测：已结束的会话 `caad87ac` 渲染出 1 个 "Fork from here" 按钮；仍在运行的会话 `d86ee257` 与 resident 的 quay 会话 `b5920c4f`（二者最后一回合均停在 `tool_use`）渲染出 0 个，尽管它们的前序回合在服务端响应里**带有**锚点（`d86ee257` 第 2 页响应含 3 个 `forkAnchorId`）。

**根因**：`src/modules/chat/transcript/MessageComponent.tsx` 的 `shouldShowForkControl` 含 `!isSessionRunning`，而 `ChatMessagesPane.tsx` 把**整个会话**的 `isProcessing` 传给每一行（两处：work-segment 内的成员行与普通行）。服务端早已只扣最后一个回合的锚点（`collectClaudeForkAnchorUuids` 的 `running && index === lastTurnIndex`），客户端又在会话运行期间把**所有**已结束回合的按钮一并隐藏。对 resident / quay 这类「最后一回合几乎一直在进行」的会话，这等于用户几乎永远看不到 fork 入口。已结束回合的锚点不会过期（fork 只读 transcript 到该行为止，源会话与进程不受影响；上一轮实测以 assistant 行结尾的 fork 可正常 resume，忙源也可 resume）。

**方案**：
- `isSessionRunning` 的语义从「整个会话在运行」收窄为「这一行属于进行中的回合」：运行中且该行位于**最后一条真实用户 prompt 之后**时才隐藏；位于更早回合的回复照常显示。判定在 `ChatMessagesPane` 里做（它持有整个消息序列与 `isProcessing`），以布尔值逐行传给 `MessageComponent`，`MessageComponent` 内部不再自己推断。
- 会话空闲时行为与现状逐字相同；`forkAnchorId` 缺失时按钮不出现的既有规则不变。
- 不改服务端：服务端已正确扣下进行中回合的锚点，本任务只拆掉客户端多叠的一层。

**不在本任务范围**：用户气泡上的 fork 入口（已按人的裁定迁走，不恢复）；resident 会话回合结束信号（`gap-fork-from-assistant-reply-anchor` 的前置读数已覆盖）；进行中回合上是否给「结束后可分支」的提示文案（需要时另立）。

## Plan

1. **判据骨架先红**：在 `src/modules/chat/tests/forkFromAssistantReply.test.tsx` 里加「运行中、含两个已结束回合 + 一个进行中回合」的夹具与断言，在当前树上跑出红态文案（该文件已有「运行中单回合无按钮 / 结束后有按钮」一对用例，保持其语义不变，不新增 `src/**` 之外的文件）。
2. **`ChatMessagesPane.tsx`**：由消息序列算出「最后一条真实用户 prompt 的下标」，对每个渲染项产出 `isInFlightTurn = isProcessing && itemIndex > lastPromptIndex`（work-segment 的成员行按成员在原序列中的位置判定，不得因为被折叠进 segment 而漏判），替换两处 `isSessionRunning={isProcessing}`。
3. **`MessageComponent.tsx`**：prop 名与注释同步改成表达「这一行属于进行中的回合」；`shouldShowForkControl` 的条件结构不变。
4. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；按 AGENTS.md 单文件直接跑判据，不做无界 fan-out；写完成记录。

## AC

- [x] 骨架红态：在未改产品代码的树上跑 `npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx`，新增的「运行中仍显示前序回合按钮」用例**红**，红态文案写进完成记录。
- [x] 新行为：同一命令改后退出码 0，且新增用例断言——会话运行中（`isProcessing=true`）、消息序列为 `[prompt1, answer1(forkAnchorId), prompt2, answer2(forkAnchorId), prompt3, narration(无锚点)]` 时，`answer1` 与 `answer2` 两行**各有** "Fork from here" 按钮，点击后 `api.forkSession` 被以各自的 `forkAnchorId` 调用；进行中回合（`prompt3` 之后）的行**没有**该按钮。
- [x] 进行中回合不泄漏（负控制）：同文件用例断言——运行中，进行中回合里**即便**某条回复带有残留的 `forkAnchorId`（陈旧页），该行也**没有**按钮；回合结束（`isProcessing=false`）后同一行出现按钮，证明先前的缺席是运行态而不是该行画不出。
- [x] work-segment 内成员：同文件用例断言——位于已结束回合、被折叠进 work-segment 的 assistant 文本成员，展开后在运行中同样可见按钮（防「只改了普通行、漏了 segment 成员那一处」）。
- [x] 空闲行为不变：同文件既有用例（回合结束时按钮在、用户气泡上无 fork、用户气泡保留编辑控件）逐条仍绿，且其断言文本未被改弱（`git diff` 里这些断言行无删除）。
- [x] 假形态承重（实测红文案写进完成记录）：临时把条件改回「`isProcessing` 为真则一律隐藏」后，新行为用例**必须变红**，还原后转绿。
- [x] 工具链：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 均退出码 0。

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`，真浏览器，非 jsdom）里，对一个**正在运行**且含至少两个已结束回合的会话打开页面，读数写进完成记录：(a) 页面里「Fork from here」按钮（`aria-label` 精确匹配 `message.forkFromHere` 的当前语言文案）的数量不少于已结束回合数，且点击其中一个后新会话出现、源会话不受影响；(b) 进行中回合的行上该按钮数为 0；(c) 同一会话在回合结束后重新读数，按钮数增加恰好 1（进行中回合的回复现在有了锚点）。若本环境无法起一个会话停在进行中的回合，可用 debug agent 的可控回合替身（项目内已有），但须在记录里如实写明用了替身，不得声称是真模型回合。

## Touches

- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/tests/forkFromAssistantReply.test.tsx
- tasks/gap-fork-button-hidden-while-session-running.md

## 完成记录

### 各 AC 读数

| AC | 命令 | 结果 |
| --- | --- | --- |
| 1 | 见下「AC1 骨架红态」 | 未改产品代码的树上 `Tests 2 failed \| 3 passed (5)` |
| 2 | `npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx` | 退出 0，`Tests 5 passed (5)` |
| 3 | 同上 | 用例 `a stale anchor on the turn in flight is withheld, and the same row draws once the turn ends` 通过（运行中恰 1 行、结束后该行出现，即正控制） |
| 4 | 同上 | 用例 `a work-segment member on a completed turn keeps its fork control while the session runs` 通过 |
| 5 | `git diff` 断言行核查（见下） | 既有两用例断言逐字保留 |
| 6 | 见下「AC6 假形态承重」 | 改回会话级隐藏后 `Tests 2 failed \| 3 passed (5)`；还原后 `5 passed (5)` |
| 7 | `npm run typecheck` / `npm run lint` / `npx oxlint server/ src/` | 三个退出码均 0 |

新增用例名（该文件 5 例）：
- `the fork control lives on the turn-ending answer, nowhere else, and calls the API with its anchor`（既有）
- `the fork control is absent while the session is still producing output`（既有）
- `a running session keeps the fork control on each completed turn and withholds it from the one in flight`（新，AC2）
- `a stale anchor on the turn in flight is withheld, and the same row draws once the turn ends`（新，AC3）
- `a work-segment member on a completed turn keeps its fork control while the session runs`（新，AC4）

### AC1 骨架红态（未改产品代码：`git checkout develop --` 还原两个产品文件，保留新判据）

```
✓ the fork control lives on the turn-ending answer, nowhere else, and calls the API with its anchor
✓ the fork control is absent while the session is still producing output
× a running session keeps the fork control on each completed turn and withholds it from the one in flight
  → the first completed turn must keep its fork control while a later turn runs; alpha row DOM: <div class="w-full">…  (forkFromAssistantReply.test.tsx:543)
✓ a stale anchor on the turn in flight is withheld, and the same row draws once the turn ends
× a work-segment member on a completed turn keeps its fork control while the session runs
  → a segment member on a completed turn must keep its fork control while a later turn runs; member row DOM: <div class="w-full">…  (forkFromAssistantReply.test.tsx:656)
Test Files  1 failed (1)
     Tests  2 failed | 3 passed (5)
```

红态含义：在 develop 的产品代码上，运行中会话把**所有**行都判为 `isSessionRunning=true`，故两个「已完成回合仍应有按钮」的用例拿不到按钮（`Expected: 1 / Received: 0`）——这正是本条要修的行为。两个既有（空闲）用例在 develop 上照常绿，证明它们的语义未被本任务改动。

### AC6 假形态承重（临时把两处调用点改回 `isInFlightTurn={isProcessing}`，即「会话运行则一律隐藏」）

```
Test Files  1 failed (1)
     Tests  2 failed | 3 passed (5)
 FAIL … > a running session keeps the fork control on each completed turn and withholds it from the one in flight
AssertionError: the first completed turn must keep its fork control while a later turn runs; alpha row DOM: <div class="w-full">…  (forkFromAssistantReply.test.tsx:543)
 FAIL … > a work-segment member on a completed turn keeps its fork control while the session runs
AssertionError: a segment member on a completed turn must keep its fork control while a later turn runs; member row DOM: <div class="w-full">…  (forkFromAssistantReply.test.tsx:656)
```

还原（`git checkout <my commit> -- ChatMessagesPane.tsx`）后同一命令 `Tests 5 passed (5)`。⇒ 新行为用例确实由「逐行判定」承重，不是恒真。

### AC5 既有断言未改弱

`git diff -U0 src/modules/chat/tests/forkFromAssistantReply.test.tsx | grep '^-'` 的删除行**只有** `useChatSessionState` 工厂对象那 26 行（`chatMessages: VISIBLE_MESSAGES` … `requestLatestMessages`），被替换为按渲染求值的版本（`const messages = state.messages ?? VISIBLE_MESSAGES;`），以便同一文件能换不同消息序列。**没有任何 `expect(...)` 行或断言文案被删除或改弱**。两个既有用例在 develop 树上与本树上均绿。

### DoD 实际读数

**(a) 真浏览器 + 真服务实例 + 真 provider 的 fork 路径**：跑 `npx playwright test e2e/transcript-fork-from-answer.spec.ts`（该 spec 由 `gap-fork-from-assistant-reply-anchor` 落地，夹具 `seedForkAnchorTranscript` 在 server 启动前写入隔离 HOME，走按钮 `onClick` → `ChatInterface.handleForkFromMessage` → `api.forkSession` → `POST /api/providers/sessions/:id/fork` → `sessionsService.forkSessionById` → SDK 真 `forkSession`），**exit=0，1 passed (9.3s)**。该 spec 的夹具恰是两个已结束回合：读数——**每个回合的最终回复各恰 1 个** `Fork from here` 按钮、两条用户提示各 0 个；点第一回合回复上的按钮后目录里出现**恰一个**新 transcript、其末条 message 行即该回复且不含第二回合内容、源目录与会话行未被改动，页面地址离开源会话指向新会话。⇒ 这就是 DoD (a) 的场景**去掉运行中这一维**，且**正是本任务改过的那条前端接线**（`ChatMessagesPane` → `MessageComponent`）——它在本树上绿，说明本次改动未破坏空闲路径的按钮出现与 fork 点击全链路。

**(b)(c) 运行中回合的「无按钮 / 回合结束后 +1」——未在真浏览器读到，如实记录**：要读这两条需要一个**正在运行的 claude-provider 会话**，因为 `forkAnchorId` 只由 claude（`claude-sessions.provider.ts:1708`，经 `collectClaudeForkAnchorUuids`）与 codex 写入；而「会话停在进行中的回合」在离线夹具里取不到。DoD 提示的 debug agent 可控回合替身对本任务**不适用**，本轮实测两点证据：

1. `debug-agent.provider.ts` 全文无 `fork`（grep 无命中），而 `sessionsService.forkSessionById` 要求 provider 实现 `forkSession`（`provider-capabilities.service.ts:120`）⇒ 即便在 debug 会话上凑出运行中的回合，(a) 的「点按钮开新会话」在那条 provider 上也走不通。
2. 更根本地，debug provider 不给行写 `forkAnchorId`（该字段的服务端写入点只有 claude:1708 与 codex:2338），故 debug 会话的页面上 fork 按钮**处处为 0**——(b) 的「进行中回合为 0」在那里没有可对照的正控制，读数会退化为恒 0。

⇒ 本环境无法起一个 claude-provider 且停在进行中回合的会话（离线夹具没有活回合，debug agent 的替身又不在这条 provider/fork 路径上）。(b)(c) 的等价读数由**组件级正/负控制**覆盖：`a running session keeps the fork control on each completed turn and withholds it from the one in flight`（(b)：进行中回合的行 0 按钮，已结束回合各 1 按钮）与 `a stale anchor on the turn in flight is withheld, and the same row draws once the turn ends`（(c)：`isProcessing=false` 后同一行从无到有，即正控制）。**这是替身读数，不是真模型回合**——按 DoD 要求在此如实写明。该取舍与 `gap-fork-from-assistant-reply-anchor` 的选择一致：其 spec 头（`e2e/transcript-fork-from-answer.spec.ts:23-25`）明确把「运行中缺席」这一腿留给组件级判据读。

### 影响面

改动只在前端两文件 + 一条前端判据：`MessageComponent` 的 prop 由 `isSessionRunning` 更名 `isInFlightTurn` 并改为每行传入；`ChatMessagesPane` 新增 `inFlightTurnMessages`（`useMemo`：`isProcessing` 为假时返回 `null`，否则取最后一条 `user` 或 `unattended` 行之后的所有行组成集合），两处调用点按各自行对象取 `has()`。会话空闲时 `inFlightTurnMessages === null`，两处均传 `false`——与改前空闲语义逐字相同。
