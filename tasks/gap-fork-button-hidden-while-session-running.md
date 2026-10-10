---
id: gap-fork-button-hidden-while-session-running
title: 会话运行期间 fork 按钮不应整会话消失：只在进行中的回合上隐藏，已结束回合的回复照常提供「从这里分支」
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

- [ ] 骨架红态：在未改产品代码的树上跑 `npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx`，新增的「运行中仍显示前序回合按钮」用例**红**，红态文案写进完成记录。
- [ ] 新行为：同一命令改后退出码 0，且新增用例断言——会话运行中（`isProcessing=true`）、消息序列为 `[prompt1, answer1(forkAnchorId), prompt2, answer2(forkAnchorId), prompt3, narration(无锚点)]` 时，`answer1` 与 `answer2` 两行**各有** "Fork from here" 按钮，点击后 `api.forkSession` 被以各自的 `forkAnchorId` 调用；进行中回合（`prompt3` 之后）的行**没有**该按钮。
- [ ] 进行中回合不泄漏（负控制）：同文件用例断言——运行中，进行中回合里**即便**某条回复带有残留的 `forkAnchorId`（陈旧页），该行也**没有**按钮；回合结束（`isProcessing=false`）后同一行出现按钮，证明先前的缺席是运行态而不是该行画不出。
- [ ] work-segment 内成员：同文件用例断言——位于已结束回合、被折叠进 work-segment 的 assistant 文本成员，展开后在运行中同样可见按钮（防「只改了普通行、漏了 segment 成员那一处」）。
- [ ] 空闲行为不变：同文件既有用例（回合结束时按钮在、用户气泡上无 fork、用户气泡保留编辑控件）逐条仍绿，且其断言文本未被改弱（`git diff` 里这些断言行无删除）。
- [ ] 假形态承重（实测红文案写进完成记录）：临时把条件改回「`isProcessing` 为真则一律隐藏」后，新行为用例**必须变红**，还原后转绿。
- [ ] 工具链：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 均退出码 0。

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`，真浏览器，非 jsdom）里，对一个**正在运行**且含至少两个已结束回合的会话打开页面，读数写进完成记录：(a) 页面里「Fork from here」按钮（`aria-label` 精确匹配 `message.forkFromHere` 的当前语言文案）的数量不少于已结束回合数，且点击其中一个后新会话出现、源会话不受影响；(b) 进行中回合的行上该按钮数为 0；(c) 同一会话在回合结束后重新读数，按钮数增加恰好 1（进行中回合的回复现在有了锚点）。若本环境无法起一个会话停在进行中的回合，可用 debug agent 的可控回合替身（项目内已有），但须在记录里如实写明用了替身，不得声称是真模型回合。

## Touches

- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/tests/forkFromAssistantReply.test.tsx
- tasks/gap-fork-button-hidden-while-session-running.md
