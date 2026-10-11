---
id: gap-live-voice-caption-removal-on-shown
title: Live Voice caption 只在「真实消息已可见」后移除（修 AC-326 折叠回归）：复用已交付的 queued/在途状态，只补
  shown 判定（移除键从 sent 改为可见），含关闭时未上屏话语的可见留痕
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

### 现状（2026-10-11 逐文件复核；行号取自当前 develop 树，写前重读仍成立）

**回归本身（本任务的全部要点）。** `src/modules/chat/voice-realtime/placeCaptions.ts:97-103`（`foldCaptionsIntoTranscriptRow`）：先由全部 `voice.deliveries` 的 `itemIds` 建 `claimed` 集合，再 `captions.filter((c) => !claimed.has(c.itemId))` —— **无条件**剔除任何被任一 delivery 认领过的 caption。而 delivery 是在收到 `sent` 帧时落下的（`useVoiceRealtimeSession.ts:683-702`），所以「词被移走」这个动作键在 `sent`（= 控制服务已受理）上，**不问那条真实消息此刻是否已经出现在转写上**。它自己的文档注释（`:77-79`）自述「Their words are in the real message the transcript now shows」——这个前提在 `sent` 与转写追上之间的窗口里并不成立。`placeCaptions.ts:149-156` 的 `markDeliveredVoiceMessages` 本来就有一道正确的守卫（`if (index === -1) continue;`：没有可匹配的真实消息时不认领、词留屏），但因为折行已在**更早一层**删掉了那些词，**这道守卫再也看不到它们**。

### 已交付、必须复用而非重建的机件（逐条核实，2026-10-11）

协调者提示本任务要建的「交付状态可见」可能已经落地。**逐条复核：确实已落地，本任务不得重建。**

1. `gap-live-voice-delivery-state-visible`（AC-327）**状态 = done**（`task_get` 复核；其记录显示实现提交 `8be9df6b`…`3d9da820`、已合入 develop）。
2. 中继**已**发出 `queued` 帧：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:784-790`（`if (openingWindow && pendingParts.length > 0) { seams.log?.(…); send({ type: 'queued' }); }`）。
3. 客户端**已**消费它：`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:676-682`（`if (frame.type === 'queued') { setDelivering(true); return; }`）；DOM 标记 `data-testid="voice-row-heard"` / `voice-row-delivering` 在 `src/modules/chat/transcript/MessageComponent.tsx`（AC-327 落地）。
4. 中继**已**用 `waitingExtraMessages` 记等待中的消息：`voice-realtime-ws-proxy.service.ts:636-637`（声明）与 `:644-646`（`waitingExtraMessages.push(args.message)`），在 `deliverSessionSend`（`:639-705`）内。

**这套已交付的状态覆盖到哪里、缺什么（精确到 delta，不是重述整套状态机）：** 已交付的 `queued`→`delivering` 覆盖的是合并窗口（`sessionSend` 到 `flushCoalesced`）——**严格早于 `sent`**；客户端在 `sent` 上把它关掉（`useVoiceRealtimeSession.ts:685`）。缺的是 `sent` **之后**那一段：已受理、但真实消息尚未出现在转写里（CLI 队列窗口）时，既没有标记、词也已被删。而且**没有任何地方**把一条 delivery 与 `visibleMessages` 比对出「已可见」——唯一的比对在 `markDeliveredVoiceMessages`，它跑在折行**之后**、那时词已经没了。所以本任务只补这一处 delta：一个 `shown` 判定（**复用** `markDeliveredVoiceMessages` 已在用的同一条匹配规则），并把移除与行标记的生命周期键到它上面。**不新增帧、不新增状态词汇、不改服务端。**

### 实测影响（2026-10-11 09:54–09:57 CST（日志原文为 UTC `01:54:14Z`–`01:57:05Z`），会话 tag `d88c6722`，journal `~/.cloudcli/voice-realtime-log/95a9d738-4f11-4431-a156-659c4b8c2f51.jsonl`）

操作者连续说了 >2 分钟；服务端 6 条 caption 全部正确下发、做了 4 次交付、每次都有 `sent` 帧。屏幕上只有**一条**用户消息；其中 3 次交付还停在 CLI 自己的队列里（`server/modules/providers/list/claude/claude-sessions.provider.ts:1216` 注释「Where one queued user message is in the CLI's own queue」），从未变成回合；它们的 caption 已被折行删掉。操作者的话几分钟内不可见，且删除**无法撤销**。

### P3 —— 关闭时刻的余波（并入本任务）

同一次会话（时间为日志 UTC）：`speech_started` 01:56:22 → 上游 01:56:53 才回答（31 s），比浏览器关 socket（teardown 01:56:47.537）晚 5 s。转写 `"现在我看见只有…后面我说的字又都消失了。"` 在 01:56:53.319 到达，而它的 caption 帧**从未发出**（socket 已不在）。屏幕上没有任何东西记录这句话发生过——只有日志知道。`UPSTREAM_STALLED`（可恢复）已在 8 s 发出，这部分是对的、保留。要求：关闭连接必须给「从未上屏的 utterance」留一条**可见**的痕迹，而不是静默丢弃。

### SCOPE BOUNDARY（有意划下）

- ⛔ **不**去让投递文本忠实于所言。中继模型合法地改写/丢弃片段，这是操作者确认接受的行为，不是缺陷。
- ⛔ **不**碰 Claude Code CLI 自己的队列 drain（操作者已明确接受放着不管：CLI 排空时会把排队消息并进下一条输入）。
- ✅ 本任务只关 CloudCLI 自己的**显示/移除决定**：词什么时候可以从屏幕上移除，以及尚未上屏时屏幕必须说什么。

### 去重（边界供评审核对）

<!-- dedup-ref --> 逐条边界（`gap-live-voice-*` 家族共 7 条，其中 6 条 done、1 条 todo）：

- `gap-live-voice-delivery-state-visible`（AC-327，**done**）：交付了 `queued` 帧与 `delivering`/`heard` 两个 DOM 标记——即**合并窗口内**（pre-`sent`）的「整理中」可见性。本任务**复用**它作为「已受理/在途」的状态源，只补它没覆盖的 post-`sent`「已交付未可见」窗口与移除键。不重建、不并行造一个交付状态机。
- `gap-live-voice-bounded-queue-refusal-visible`（**todo，刚立案**）：同一 incident（日志 UTC 01:54–01:57，tag `d88c6722`，3 条堆在 CLI 队列），但做的是**准入控制**（给同时等待的投递设上限、超限即拒、队列深度可见），主要落在 `server/` 的投递点（`voice-realtime-ws-proxy.service.ts` 的 `waitingExtraMessages` 一带）。本任务是**移除决定**（client 侧折行改键到 `visibleMessages` 的匹配 + 关闭留痕）。两者 Touches 只在 `useVoiceRealtimeSession.ts` 与该 e2e spec 交叠、由调度器串行；机制与验收相互独立——**keep separate**。
- `gap-live-voice-single-transcript-row`（AC-326，**done**）：建了这道折行（一行原地定型），本任务修它引入的回归（移除过早）。
- `gap-voice-realtime-empty-transcript-delivery-guard`（ready）：**服务端**为关闭后到达的上游事件记 `not-delivered (socket closed)` 的 journal 记录；本任务 P3 要的是**屏幕上可见**的痕迹（客户端侧），机制不同。

检索 `caption` / `placeCaptions` / `shown` / `真实消息已可见` / `排队中` / `未送达` / `移除`：open 任务无覆盖「移除键从 `sent` 改为 `shown`」者，不构成重复立案。

## Plan

1. **移除决策（本任务的要点）**：`foldCaptionsIntoTranscriptRow` 的 `claimed` 集合**只**纳入「其真实消息已可见（`shown`）」的 delivery；`sent` 已收到但真实消息尚未出现在 `visibleMessages` 里的 delivery **不认领**，其词留在行上。`shown` 由「该 delivery 的文本是否已能在 `visibleMessages` 里匹配到」判定——**复用** `markDeliveredVoiceMessages` 已在用的同一条匹配规则（`normalizeForMatch` + `DELIVERY_SKEW_MS` 时间下界，`placeCaptions.ts:34-36,146-155`）：把该规则提取成一个共享判定，折行与 `markDeliveredVoiceMessages` 共用它，不新发明第二套。转写的重读由**已存在**的 `useFollowSentRun.ts` 驱动，无需新造轮询。
2. **状态源复用（不重建）**：把已交付的 `queued` 帧 / 客户端 `delivering` 与 DOM 标记 `voice-row-heard`/`voice-row-delivering` **原样**作为「已受理/在途」的可见状态源。只补已交付状态缺的那一处 delta：`delivering` 目前在 `sent` 上被关掉（`useVoiceRealtimeSession.ts:685`），且移除键在 `sent`；把行标记的生命周期延续到 `shown`（真实消息已可见）为止——使 post-`sent`「已交付、尚未上屏」窗口里词**仍在屏上且仍带在途标记**。**不新增帧、不新增状态词汇、不改服务端**；若实现中发现已交付的 `delivering` 语义无法承载这一段，写清「缺的是 `shown` 判定本身」，而不是另起一套状态机。
3. **`shown` 之前可辨识（复用已交付的可观测面）**：未上屏的行沿用已交付的在途标记（`voice-row-delivering`）且**不含** `voice-transcript-badge`；已上屏的行不再有在途标记、改带 `voice-transcript-badge`。两个可观测面互斥即可分辨，**不新增 testid**。
4. **关闭时刻留痕**：`useVoiceRealtimeSession.ts` 的 `onclose` 分支里，若关连接时仍存在**未上屏**的 utterance（有 final caption 但无对应 `shown`，或有一段正在转写而未收到任何 caption），留下一枚**可见**痕迹（如 `data-testid="voice-closed-unshown-utterance"`）**并**记一条客户端记录（`voiceLog` 一条含 utterance 计数/connection 的行）；全部已上屏时**不留**任何痕迹（负控）。
5. **判据文件新建**：`src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx` —— AC 点名的判据文件，必须是它自己那条 `npm run test:client` 的**唯一**过滤器（既有文件并列时 vitest 会因另一个过滤器命中而 exit 0，判据即空过，见 AC-326 条〇的实况）。取假形态断言（「`sent` 已收到但真实消息不可见 ⇒ 词仍在」）**排在文件最前**。
6. **既有测试同步**：`placeCaptions.test.ts` / `voiceSingleTranscriptRow.test.ts` / `voiceDeliveryState.test.tsx` 里任何断言「被认领即删除」的用例按新语义收紧或更新；不得放宽成恒绿。
7. **e2e（本 AC 自己的证据）**：`e2e/voice-realtime-upload-fixture.spec.ts` 增一条浏览器读数用例：假上游在 `session_send` 之后**不**立刻让真实消息出现在转写里（复现 CLI 队列窗口），断言那些词**仍在**那一行且带在途标记；随后让真实消息出现，断言该行就地定型、无重复。**注意**：fan-in 套件（`scripts/test.sh`）只跑 typecheck + lint + server node:test + client vitest，**不跑 Playwright e2e**——不得声称 fan-in 会跑这条。
8. **静态门**：`npm run typecheck`、`npm run lint` 退出 0。

## AC

- [ ] AC1 取假形态（排在判据文件最前）：一条 delivery 已记录（收到 `sent`）但 `visibleMessages` 里**没有**匹配的真实消息时，折行**仍显示**那些词——`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx` 退出 0，且该断言是该文件里的**第一条**断言；给出折行文本的实测读数（今天必红：折行无条件剔除）。
- [ ] AC2 负控：真实消息**已可见**（`shown`）后，caption 行被移除、与既有行为一致、**不双显**——同文件断言折行文本不再含该 delivery 的词，且该文本的真实 user 行计数为 1。
- [ ] AC3 复用已交付的可观测面即可分辨：未上屏（已受理但在途）的行带已交付的 `data-testid="voice-row-delivering"` 且**不**带 `voice-transcript-badge`；`shown` 后该行不再带在途标记、改带 `voice-transcript-badge`；给出 DOM 读数（两态互斥、计数）。**不新增 testid。**
- [ ] AC4 关闭留痕：连接在存在**未上屏** utterance 时关闭 ⇒ 屏幕上有一条可见痕迹（`data-testid="voice-closed-unshown-utterance"`）**且**有一条客户端记录；**负控**：全部已上屏时关闭 ⇒ 该 testid 计数为 0、且无该记录。
- [ ] AC5 回归守卫：AC-326 的单行折叠仍成立（一次语音一行、在同一行内累积、交付就地定型）——`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx` 退出 0。
- [ ] AC6 e2e 证据（自证，非 fan-in）：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 退出 0，且新用例实测「已受理未上屏时词仍在 + 带在途标记 → 真实消息出现后该行就地定型」；Evidence 须写明 fan-in 套件不跑 Playwright e2e。
- [ ] AC7 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过（DIR-026 读法 A）：一次真实 Live Voice 会话，其 turn 在途时继续说，操作者能**看见**自己的话处于「已受理但尚未上屏」（词仍在、带已交付的在途标记），并在回合落地时看见它们就地定型为真实消息；外加一次真实关闭、留一句未上屏的 utterance，屏幕上留下可见痕迹。单元测试是必要但不充分的：真实浏览器读数/截图（沿用 AC-326/AC-327 的形态——真浏览器 + 假上游复现忙会话窗口；操作者自己的真实忙会话是更强的证据）与那条客户端记录落在本任务 Evidence。⛔ 断言投递文本与所言相符是范围外的，不得写成 AC。

## Touches

- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/index.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/transcript/MessageComponent.tsx
- src/shared/types.ts
- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx (new)
- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts
- src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx
- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-live-voice-caption-removal-on-shown.md (self)



**现场证据补充（2026-10-11，manager 侧从 `server.log` 提取；人 yale 同意并入）**

本任务的症状在**今天的真实使用**上再次复现，而且用户是**通过 Live Voice 自己说出来的**（模型原文转写并投递，会话 `d88c6722`）：

- `2026-10-11T01:56:53.679Z` `<< function_call session_send`：`"现在我看见只有用\"现在我在用live voice\"这几个字在屏幕上，后面我说的字又都消失了。"`
- `2026-10-11T01:57:05.023Z` 用户又说了一遍同义的话（第二次复述）。

同一次会话的时序（UTC 逐字）：`speech_started` 01:56:22.190 → **上游静默 31 s** → `speech_stopped` 01:56:53.118 → `transcription.completed` 01:56:53.319 → `function_call session_send` 01:56:53.679；另有浏览器侧早退 `teardown: the browser socket closed` @ 01:56:47.537（比上游收尾早 5 s）——正是本任务 P3 关心的「关闭时刻余波」形态。

现场环境（供判断是否部署落后）：`dist-server/server/index.js` 构建于 `2026-10-11 09:32 CST`、服务同刻启动 ⇒ 跑的是**当天新构建**，不是陈旧部署。

读数价值：把本任务的判据从「设计推演」变成「有真实时间戳与原文的复现窗口」——修好后可用同一形态（已受理但在途时用户看到文字消失）自证。