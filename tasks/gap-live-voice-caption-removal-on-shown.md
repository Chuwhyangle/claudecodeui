---
id: gap-live-voice-caption-removal-on-shown
title: Live Voice caption 只在「真实消息已可见」后移除（修 AC-326 折叠回归）：投递状态显式化
  accepted/queued/shown，排队未上屏时词留在屏上并可辨识，含关闭时未上屏话语的可见留痕
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 逐文件复核，行号取自当前 develop 树；写前逐条重读，仍成立）

**回归本身。** `src/modules/chat/voice-realtime/placeCaptions.ts:97-103`（`foldCaptionsIntoTranscriptRow`）：先由全部 `voice.deliveries` 的 `itemIds` 建 `claimed` 集合，再 `captions.filter((c) => !claimed.has(c.itemId))` —— **无条件**剔除任何被任一 delivery 认领过的 caption，不问那条真实消息此刻是否已经出现在转写上。它自己的文档注释（`:77-79`）自述「Their words are in the real message the transcript now shows」——这个前提在 `sent` 帧与转写追上之间的窗口里**并不成立**。

- `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:683-702`：收到 `sent` 帧时把**每一条** final 且未被认领的 caption 记入 `attributedRef`，并落一条 delivery `{message, at, heard, itemIds}`。也就是说触发认领的是 `sent`（= 控制服务已受理），而**不是**「真实消息已可见」。
- `src/modules/chat/ChatInterface.tsx:425-439`：`const folded = foldCaptionsIntoTranscriptRow(voice.captions, voice.deliveries, voice.delivering);` 之后 `markDeliveredVoiceMessages(visibleMessages, folded ? [folded] : [], voice.deliveries)` —— 折行现在是**唯一**的 caption 行。
- `placeCaptions.ts:149-156` 的 `markDeliveredVoiceMessages` **本来就有一道正确的守卫**：`if (index === -1) continue;`，即「一条 delivery 还没有可匹配的真实消息（转写尚未重读）时不认领，其 caption 留屏，词不会在中间消失」。但因为折行已在**更早一层**把那些词删掉，**这道守卫再也看不到它们**。回归的本质：AC-326 把一个决定（「这些词现在可以移除了吗？」）拆到两处，却把守卫留在了不再拥有那些词的那一处。

### 实测影响（2026-10-11 01:54–01:57 CST，会话 tag `d88c6722`，journal `~/.cloudcli/voice-realtime-log/95a9d738-4f11-4431-a156-659c4b8c2f51.jsonl`）

操作者连续说了 >2 分钟；服务端 6 条 caption 全部正确下发、做了 4 次交付、每次都有 `sent` 帧。屏幕上只有**一条**用户消息；其中 3 次交付还停在 CLI 自己的队列里（`server/modules/providers/list/claude/claude-sessions.provider.ts:1216` 注释「Where one queued user message is in the CLI's own queue」），从未变成回合；它们的 caption 已被折行删掉。操作者的话几分钟内不可见，且折行的删除**无法撤销**。

### P3 —— 关闭时刻的余波（并入本任务）

同一次会话：`speech_started` 01:56:22 → 上游 01:56:53 才回答（31 s），比浏览器关 socket（teardown 01:56:47.537）晚 5 s。转写 `"现在我看见只有…后面我说的字又都消失了。"` 在 01:56:53.319 到达，而它的 caption 帧**从未发出**（socket 已不在）。屏幕上没有任何东西记录这句话发生过——只有日志知道。`UPSTREAM_STALLED`（可恢复）已在 8 s 发出，这部分是对的、保留。要求：关闭连接必须给「从未上屏的 utterance」留一条**可见**的痕迹，而不是静默丢弃。

### 已有、应当复用而非重建的机件

- `src/modules/chat/voice-realtime/useFollowSentRun.ts` 已在跟随一条 sent run（`MAX_FOLLOW_MS` 15 分钟）——「真实消息是否已可见」可由它已触发的转写重读来观测，无需新造轮询。
- CLI 自己的队列在服务端已可读（`claude-sessions.provider.ts:1216`），所以「queued」是可观测的既有状态，不是假想。

### SCOPE BOUNDARY（有意划下，评审应能看出这条线）

- ⛔ **不**去让投递文本忠实于所言。中继模型合法地改写/丢弃片段，这是操作者确认接受的行为，不是缺陷。
- ⛔ **不**碰 Claude Code CLI 自己的队列 drain（操作者已明确接受放着不管：CLI 排空时会把排队消息并进下一条输入）。
- ✅ 本任务只关 CloudCLI 自己的**显示/移除决定**：词什么时候可以从屏幕上移除，以及尚未上屏时屏幕必须说什么。

<!-- dedup-ref --> 机制去重与合并判定（立案时实测）：`gap-live-voice-*` 家族 6 条**全部 done**；open 任务检索 `caption` / `placeCaptions` / `shown` / `真实消息已可见` / `排队中` / `未送达` / `移除` 无一覆盖本条机制（「删除 caption 的键从 `sent` 改为 `shown`」）。相关但机制不同、判定 **separate**：`gap-live-voice-single-transcript-row`（AC-326，done）建了这道折行，本任务修它引入的回归；`gap-live-voice-delivery-state-visible`（AC-327，done）让 `sent` **之前**的合并窗口可见（「已听到」/「整理中」），本任务管的是 `sent` **之后**「已受理但尚未上屏」的窗口，并把移除改键到 `shown`——两条窗口不同、验收相互独立，且都已是 done。同 incident 的 `gap-live-voice-bounded-queue-refusal-visible`（todo）在同一处实测（01:54–01:57 tag `d88c6722`，3 条堆在 CLI 队列）上做的是**准入控制**（设上限、超限即拒、队列深度可见，主要落在 `server/` 的投递点与 `voice-realtime-ws-proxy.service.ts`）；本任务做的是**移除决定**（client 侧折行改键到 `shown` + 关闭留痕），两者 Touches 只在 `useVoiceRealtimeSession.ts` 与该 e2e spec 上交叠、由调度器串行，机制与验收相互独立——**keep separate**（本任务体是上游已拟好的既定内容，按 skill「handed-drafted 不重写为合并」保留独立）。`gap-voice-realtime-empty-transcript-delivery-guard`（ready）在**服务端**为关闭后到达的上游事件记 `not-delivered (socket closed)` 的 journal 记录；本任务 P3 要的是**屏幕上可见**的痕迹（客户端侧），机制不同。

## Plan

1. **投递状态显式化。** 在 `useVoiceRealtimeSession.ts` 的 delivery 类型上引入一个状态 `accepted | queued | shown`：`accepted` = 收到 `sent`；`queued` = 真实消息尚未出现在转写里；`shown` = 已出现。`queued`/`shown` 由「该 delivery 的文本是否已能在 `visibleMessages` 里匹配到」判定——判定**复用** `markDeliveredVoiceMessages` 已在用的同一条匹配规则（`normalizeForMatch` + `DELIVERY_SKEW_MS` 时间下界，`placeCaptions.ts:34-36,146-155`），不新发明第二套。
2. **移除改键到 `shown`。** `foldCaptionsIntoTranscriptRow` 的 `claimed` 集合只纳入**真实消息已可见（`shown`）**的 delivery；`queued`（已受理、未上屏）的 delivery 不认领，其词留在行上。实现上把「已 shown 的 itemId 集合」算好传入（或按第 1 条把 `visibleMessages` 传进来、由该函数自己判定），删掉「出现在任一 delivery 即算认领」这个无条件判据。`markDeliveredVoiceMessages` 的 `index === -1` 守卫原样保留——它现在终于能再次看到那些词。
3. **`shown` 之前可辨识。** `accepted`/`queued` 的行带一枚可观测的待办标记（新 testid，如 `data-testid="voice-row-queued"`；`整理中`/`已听到` 沿用 AC-327 的 `voice-row-delivering`/`voice-row-heard`），使「我的话在排队、还没上屏」看得见而不是像丢失。样式复用现有 muted 前景约定，底栏不动（AC-323 的判据钉住它）。
4. **关闭时刻留痕。** `useVoiceRealtimeSession.ts` 的 `onclose` 分支里，若关连接时仍存在**未上屏**的 utterance（有 final caption 但其 delivery 未 `shown`，或有一段正在转写而未收到任何 caption），留下一枚**可见**痕迹（如 `data-testid="voice-closed-unshown-utterance"`，说明「连接关闭时有一句未上屏」）**并**记一条客户端记录（`voiceLog` 一条含 utterance 计数/connection 的行）；全部已上屏时**不留**任何痕迹（负控）。
5. **判据文件新建。** `src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx` —— AC 点名的判据文件，必须是它自己那条 `npm run test:client` 的**唯一**过滤器：既有文件并列时 vitest 会因另一个过滤器命中而 exit 0，判据即空过（AC-326 条〇的实况）。取假形态断言（「`sent` 已收到但真实消息不可见 ⇒ 词仍在」）**排在文件最前**。
6. **既有测试同步。** `placeCaptions.test.ts` / `voiceSingleTranscriptRow.test.ts` / `voiceDeliveryState.test.tsx` 里任何断言「被认领即删除」的用例，按新语义收紧或更新；不得放宽成恒绿。
7. **e2e（本 AC 自己的证据）。** `e2e/voice-realtime-upload-fixture.spec.ts` 增一条浏览器读数用例：假上游在 `session_send` 之后**不**立刻让真实消息出现在转写里（复现 CLI 队列窗口），断言那些词**仍在**那一行且带待办标记；随后让真实消息出现，断言该行就地定型、无重复。**注意**：fan-in 套件（`scripts/test.sh`）只跑 typecheck + lint + server node:test + client vitest，**不跑 Playwright e2e**——不得声称 fan-in 会跑这条。
8. **静态门。** `npm run typecheck`、`npm run lint` 退出 0。

## AC

- [ ] AC1 取假形态（排在判据文件最前）：一条 delivery 已记录（收到 `sent`）但 `visibleMessages` 里**没有**匹配的真实消息时，折行**仍显示**那些词——`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx` 退出 0，且该断言是该文件里的**第一条**断言；给出折行文本的实测读数（今天必红：折行无条件剔除）。
- [ ] AC2 负控：真实消息**已可见**（`shown`）后，caption 行被移除、与既有行为一致、**不双显**——同文件断言折行文本不再含该 delivery 的词，且该文本的真实 user 行计数为 1。
- [ ] AC3 `accepted`/`queued` 与 `shown` 在屏幕上可分辨：`accepted`/`queued` 的行带 `data-testid="voice-row-queued"`（命名以实现为准，语义不可换），`shown` 后该 testid 消失、该行带 `voice-transcript-badge`；给出 DOM 读数（两态互斥、testid 计数）。
- [ ] AC4 关闭留痕：连接在存在**未上屏** utterance 时关闭 ⇒ 屏幕上有一条可见痕迹（`data-testid="voice-closed-unshown-utterance"`）**且**有一条客户端记录；**负控**：全部已上屏时关闭 ⇒ 该 testid 计数为 0、且无该记录。
- [ ] AC5 回归守卫：AC-326 的单行折叠仍成立（一次语音一行、在同一行内累积、交付就地定型）——`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx` 退出 0。
- [ ] AC6 e2e 证据（自证，非 fan-in）：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 退出 0，且新用例实测「已受理未上屏时词仍在 + 带待办标记 → 真实消息出现后该行就地定型」；Evidence 须写明 fan-in 套件不跑 Playwright e2e。
- [ ] AC7 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过（DIR-026 读法 A）：一次真实 Live Voice 会话，其 turn 在途时继续说，操作者能**看见**自己的话处于「已受理但尚未上屏」（带待办标记、词仍在），并在回合落地时看见它们就地定型为真实消息；外加一次真实关闭、留一句未上屏的 utterance，屏幕上留下可见痕迹。单元测试是必要但不充分的：真实浏览器读数/截图（沿用 AC-326/AC-327 的形态——真浏览器 + 假上游复现忙会话窗口；操作者自己的真实忙会话是更强的证据）与那条客户端记录落在本任务 Evidence。⛔ 断言投递文本与所言相符是范围外的，不得写成 AC。

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