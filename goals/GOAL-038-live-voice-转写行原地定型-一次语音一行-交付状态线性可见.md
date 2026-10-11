---
id: GOAL-038
title: Live Voice 转写行原地定型：一次语音一行、交付状态线性可见
status: active
kind: goal
origin: 2026-10-11 人 yale 在使用 Live Voice
  后提出的交互问题与裁定。观察：说话时先冒出若干条分开的转写行，随后合成一条经过语义纠正的完整用户消息、并把那些转写行删掉，然后才开始推理。经代码与
  server.log 逐帧核实（连接 d88c6722：14:40:17/18/19 三条 caption「这条消息就用这种Live
  Boys。」「Order。」「让我们看看识别的准不准。」→ 14:40:20.142 一次 session_send 交付「这条消息是用 Live
  Voice 输入的，让我们看看识别得准不准。」→ 14:40:22.643 coalesced 1 relayed piece(s) →
  14:40:22.644 sent），确认为设计使然而非缺陷。人 yale 裁定采纳范围：方案 A（一次语音一行、原地定型）、P3 两段式状态显性化（已听到
  + 整理中）、P4 抑制空转写。GOAL-033/035 已 achieved，不重开。
activatedAt: 2026-10-10T18:14:59.004Z
---
## 背景

Live Voice 每说完一句，上游 VAD 切一次句，浏览器为每句渲染一条独立的 user 气泡（`ChatInterface.tsx:418-440` 把每条 caption 变成 `voice-caption-<itemId>` 的 user ChatMessage）；说停后中继模型把整段合并、顺手修掉识别错字，只调一次 `session_send`（系统提示见 `voice-realtime-ws-proxy.service.ts:110-118`），代理再压 `VOICE_REALTIME_COALESCE_MS = 2_500`（`server/index.ts:379`）才交付；`sent` 帧到达时 `placeCaptions.ts:52-76` 把前面那 N 条气泡一次删掉。用户读到的是「我的话出现好几次、被改写过、然后被删掉」。

已用 `server.log` 连接 `d88c6722` 逐帧核实这条链路，四个独立问题：

- **P1 碎片不可辨识**：临时气泡与定型消息用同一套气泡样式（`MessageComponent.tsx:265` 的 `data-message-style="user"`），只差一个徽章与一个编辑按钮，用户无法区分「这是临时的」与「这是定了的」。
- **P2 删除即塌缩**：屏幕上发生的是 N→1，而不是 1→1。
- **P3 静默无信号**：最后一句说停到交付之间有 2.50s，屏幕上没有任何变化。全部 11 次交付的服务端日志都是 `coalesced 1 relayed piece(s)`，即这段窗口没有合并任何东西。
- **P4 空转写产生空气泡**：`caption ""` 在日志里出现 3 次（如 `14:42:57.666`），会渲染成一个空白 user 气泡再消失。

## 目标

1. **一次语音只对应一行用户消息**：原声片段在同一行内按到达顺序累积；交付时那一行**就地定型**为真实消息，是 1↔1 而不是 N↔1。
2. **交付状态线性可见**：那一行在「已听到」与「整理中/交付中」之间有真实状态，静默段不再无提示；状态取自服务端的真实时刻，不是前端定时器推断出来的。
3. **空转写不产生任何行。**

## 范围

两个 AC，第二个依赖第一个：

- **AC-326（方案 A + P4，纯前端）**：N 行折成 1 行、交付就地定型、空 caption 不渲染。只改 `src/modules/chat/`，不动服务端。
- **AC-327（P3 两段式）**：服务端在 `session_send` 被接受、进入合并窗口的那一刻新增一个 outbound 帧；前端把「已听到」与「整理中」渲染在**同一行**上（不是新控件、不是新行）。

## 非目标

- **不缩短 `VOICE_REALTIME_COALESCE_MS`**。2.5s 窗口本身是「一个想法一条消息」的防线（人 yale 2026-10-09 抱怨过被拆成两次推理），当前样本只有 11 次且全是 1 piece，不足以断言模型从不连发。本 GOAL 只让这段等待可见。
- **不做方案 B**（把 in-flight 文字移出 transcript、放回 composer）。那要改 AC-317 的判据文本，属另一次 goal 级决策。
- **不做方案 C**（原声/交付文本的行内 diff 高亮、heard 行内展开）。AC-317 的 e2e 断言交付后原声文本作为 user 行的计数为 0，行内保留原声会直接推翻它。
- 不改 `session_send` 白名单、DashScope transport、turn detection（后者属 GOAL-034 与 `docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md`）。
- 不改底栏即时字幕（AC-323 的判据钉住它）。

## 退出条件

1. AC-326 与 AC-327 的判据命令各自 exit 0。
2. 真实浏览器 + 假上游的读数：三次转写 + 一次交付的全过程里，`.chat-messages-pane` 的 user 行计数**从不超过 1**；且那一行依次出现 `voice-row-heard`、`voice-row-delivering`，交付后变为带 `voice-transcript-badge` 的真实消息。
3. 既有判据一字不改仍绿：AC-317 的 `e2e/voice-realtime-upload-fixture.spec.ts` 三条既有用例（含「words heard and relayed verbatim appear once」与交付后原声行计数为 0 的断言）、AC-323 的三条 e2e spec 链、协议模拟套件。
4. 取假形态各自现场红、恢复后回绿。
5. `npm run typecheck` exit 0。