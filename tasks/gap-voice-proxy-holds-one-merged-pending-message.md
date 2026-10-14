---
id: gap-voice-proxy-holds-one-merged-pending-message
title: Live Voice 排队改由语音代理持有「一条」合并消息：Claude 忙时追加、空闲时一次发出；打断时排队+新话+说明一次发出
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**人的裁定（2026-10-14）**：
- 排队中最多只允许**一个**气泡：所有真正在排队的 Live Voice 消息合并为一条，**一次**发给 Claude Code；
- 特殊情况：前序排队内容未要求打断、新来的一条要求打断 ⇒ 执行打断，并把「所有排队 + 新来的」**一次**发给 Claude Code；
- 页面不提供撤回、打断操作（Live Voice 只有 Mute 和退出）；
- 实现形态选 (A)：**由语音代理自己持有这一条**（而非继续用 CLI 队列、页面合并显示）；
- 字节上限沿用 `VOICE_QUEUE_MAX_BYTES`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 约 280 行，1000 B）；超限时**字幕行**提示一句「Claude 仍在忙，这句未加入」，不新增页面元素。

**这推翻 A+ 裁定（2026-10-12，GOAL-041）中「忙时语音照常进 CLI 队列」一项**（`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3 / §18）。A+ 当时否决「代理自持缓冲」的两条风险与本任务的应对：①断线丢缓冲 → 连接关闭/退出时代理把缓冲立即投递（复用现有 teardown 冲刷路径），AC 覆盖；②文字/语音跨通道顺序反转 → 语音模式下文字输入框被语音条取代，同页无第二通道。A+ 的其余部分（语义打断、先入队后中止 G1、runId+utteranceSeq 栅栏）保留。

**现状（resident 排队模型）**：Claude 忙时每条 `session_send` 立刻进 CLI 自己的队列；前端 `VoicePendingUtterance.tsx` + `useVoicePendingWithdraw.ts` 按 `command_lifecycle` / `queue_reconcile` 一条一行地显示「Waiting in the queue · Withdraw」；两份登记表对账出过「Q 行卡住」（2026-10-14 早上实测）。CLI 只在回合边界把排队消息拼成一条，页面却是多行。

**修法**：
1. **忙闲读数**：用代理现有的 L3 状态读数（与注入状态行同源的 `phase`）。`running` / `queued`（有在跑的 run）/ `awaiting-permission` 视为忙。
2. **忙时**：被接受的转发片段追加进**唯一**的待发缓冲（即现有合并窗口在忙时一直保持打开），不调用投递到 CLI；每次缓冲变化向浏览器发 `pending` 帧 `{ text, bytes }`（清空时 `text: ''`）。
3. **空闲时**：phase 回到 idle（run 结束）立即把缓冲作为**一条**消息投递（走现有 `deliverSessionSend`），发 `sent`，清空缓冲。空闲时说的话行为不变（1 s 合并窗口后投递）。
4. **上限**：追加后超过 `VOICE_QUEUE_MAX_BYTES` 的片段不加入，发现有 `refused` 帧；浏览器在**字幕行**临时显示「Claude 仍在忙，这句未加入」（新 i18n 键，所有 `chat.json` 语言补齐），下一条字幕到来即恢复显示字幕。
5. **打断**：`session_interrupt` 时把「打断说明（`buildInterruptAftermathNote`）+ 缓冲 + 本次 `message`」拼成**一条**，走现有 G1（先入队、确认后中止），清空缓冲；这条打断路径上**不再**把说明延后挂到下一条消息。无 `message` 且缓冲为空时保持现有行为。
6. **断线/退出**：连接关闭时缓冲非空 ⇒ 立即投递一次（即使 Claude 仍忙，进 CLI 队列）；浏览器退出时回填输入框草稿（`collectUndeliveredUtterances`）**不得**再包含已进缓冲的话（避免重复）。
7. **前端**：语音条上方显示**至多一个**只读「排队中」卡片（视觉沿用文字模式的 `QueuedMessageCard` 风格，无编辑/删除/撤回按钮），内容为 `pending.text`；`text` 为空即消失。删除 `VoicePendingUtterance.tsx`、`useVoicePendingWithdraw.ts`、`ChatInterface.tsx` 中的 `cancelQueuedVoice` 及其导出与测试；`e2e/voice-pending-utterance-withdraw.spec.ts` 删除，`e2e/voice-realtime-intent-control.spec.ts` 中依赖撤回行的断言改写。服务端 `queue_reconcile` / `command_lifecycle` 推送可保留（浏览器不再消费）。

<!-- dedup-ref -->
合并决定：separate——与 `gap-voice-ui-strip-to-caption-and-connection-state`（纯前端减法）共享 `VoiceRealtimeBar.tsx`、`useVoiceRealtimeSession.ts`、`ChatInterface.tsx`、`index.ts` 与语言文件，但本任务以服务端排队机制为主、独立验收，调度器按 Touches 串行；与 `gap-voice-relay-mode-a-prompt-drop-continue-arm-and-session-status` 共享 `voice-realtime-ws-proxy.service.ts`，同样串行。

## AC

- [x] AC1 新增 `server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts`（经出货 `handleVoiceRealtimeConnection` + 脚本化上游/宿主），以下各用例断言**对 CLI 的投递次数与正文**，单跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` 退出 0：(a) 忙时 3 次 `session_send` ⇒ 投递 0 次、最后一个 `pending` 帧的 text 依次含三段；run 结束 ⇒ 恰 1 次投递、正文含三段且按说话顺序；(b) 忙时缓冲非空，再来一次带 `message` 的 `session_interrupt` ⇒ 中止之前恰 1 次入队，正文依次含打断说明、缓冲内容、新 message，之后下一条普通投递**不**再带打断说明；(c) 超过 `VOICE_QUEUE_MAX_BYTES` 的片段 ⇒ `refused` 帧、缓冲不变；(d) 忙时缓冲非空即关闭连接 ⇒ 恰 1 次投递；(e) 空闲时的单句仍在合并窗口后投递 1 次（行为不变）。
- [x] AC2 前端只读卡片：组件/hook 测试断言连续收到 3 个 `pending` 帧后页面上恰有 1 个排队卡片且文本为最后一帧 text、卡片内无 button；收到 `pending{text:''}` 后卡片消失；收到 `refused` 后字幕行显示新文案。`npm run test:client -- <该测试文件>` 退出 0。
- [x] AC3 撤回链路已移除：`grep -rnE "useVoicePendingWithdraw|VoicePendingUtterance|cancelQueuedVoice|voice-pending-utterance" src e2e --include=*.ts --include=*.tsx` 无输出（退出 1）。
- [x] AC4 退出不重复：hook/组件测试断言——缓冲中含某句时点 Exit，输入框草稿不含该句。
- [x] AC5 服务端回归面逐文件单跑、各自退出 0（`npx tsx --tsconfig server/tsconfig.json --test <file>`，均在 `server/modules/voice-realtime/tests/`）：`voice-realtime-bounded-queue.test.ts`、`voice-realtime-delivery-boundary.test.ts`、`voice-realtime-interrupt.test.ts`、`voice-realtime-interrupt-aftermath.test.ts`、`voice-realtime-interrupt-audit.test.ts`、`voice-realtime-interrupt-fence.test.ts`、`voice-realtime-interrupt-missing-intent.test.ts`、`voice-realtime-interrupt-revision-order.test.ts`、`voice-realtime-queue-depth-drain-refresh.test.ts`、`voice-realtime-queue-depth-truth.test.ts`、`voice-realtime-queue-lifecycle-completion.test.ts`、`voice-realtime-ws-proxy.protocol-simulation.test.ts`；因本裁定失效的断言（忙时逐条进 CLI、说明延后到下一条）改写为断言新行为，pass 数写入「验证读数」。
- [x] AC6 客户端：`src/modules/chat/voice-realtime/tests/` 下文件名含 `voice` 或 `Voice` 的测试逐文件单跑（`npm run test:client -- <file>`）各自退出 0；`npm run typecheck` 与 `npm run lint` 退出 0；`npx playwright test --list e2e/voice-realtime-intent-control.spec.ts` 退出 0。

## DoD

真实 Live Voice 中，Claude 忙时连续说的几句话在页面上只显示为一个排队卡片、随说随长；Claude 一空闲，这几句作为**一条**普通 user message 进入对话；忙时说出要求打断的话，当前回合停止，「排队内容 + 这句」连同打断说明作为一条消息立即交给 Claude；排队超上限时字幕行提示、页面无新增元素；断线或退出时排队内容不丢、不重复。由经出货代理的协议级测试与前端组件测试验证。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts
- server/modules/voice-realtime/tests/voice-realtime-bounded-queue.test.ts
- server/modules/voice-realtime/tests/voice-realtime-delivery-boundary.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-revision-order.test.ts
- server/modules/voice-realtime/tests/voice-realtime-queue-depth-drain-refresh.test.ts
- server/modules/voice-realtime/tests/voice-realtime-queue-depth-truth.test.ts
- server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/VoicePendingMessageCard.tsx
- src/modules/chat/voice-realtime/VoicePendingUtterance.tsx
- src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/index.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx
- src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx
- e2e/voice-pending-utterance-withdraw.spec.ts
- e2e/voice-realtime-intent-control.spec.ts
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- tasks/gap-voice-proxy-holds-one-merged-pending-message.md

## 验证读数

命令与读数（本 worktree，2026-10-14）：

- AC1 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` ⇒ pass 5 / fail 0（AC1(a)…(e) 各 1）。
- AC5 逐文件单跑 `npx tsx --tsconfig server/tsconfig.json --test <file>`，pass / fail 依次：
  - `voice-realtime-bounded-queue` 6 / 0、`voice-realtime-delivery-boundary` 4 / 0、`voice-realtime-interrupt` 14 / 0、`voice-realtime-interrupt-aftermath` 6 / 0、`voice-realtime-interrupt-audit` 4 / 0、`voice-realtime-interrupt-fence` 6 / 0、`voice-realtime-interrupt-missing-intent` 3 / 0、`voice-realtime-interrupt-revision-order` 7 / 0、`voice-realtime-queue-depth-drain-refresh` 3 / 0、`voice-realtime-queue-depth-truth` 5 / 0、`voice-realtime-queue-lifecycle-completion` 7 / 0、`voice-realtime-ws-proxy.protocol-simulation` 19 / 0。合计 84 / 0，零文件改写（新行为全部由 `readRunBusy()`/busy 缓冲门控，这些文件不设 busy）。
- AC6 客户端逐文件单跑 `npm run test:client -- <file>`（文件名含 voice/Voice，退出 0）pass 数：`useVoiceRealtimeSession.segmented` 10、`useVoiceRealtimeSession` 46、`voiceAttributionRewriteGap` 5、`voiceCaptionShownState` 7、`voiceDeliveryState` 3、`voiceMicSuspendedWaveform` 3、`voiceNoTranscriptCaptionRows` 8、`voicePendingMessageCard` 4、`voiceSegmentHonestState` 16、`voiceSegmentLostState` 9、`voiceSingleTranscriptRow` 4、`voiceStopVsExit` 8。另跑 `placeCaptions.test.ts` 10 / 0（`collectUndeliveredUtterances` 新增可选第三参，默认值保持旧行为）。
- AC6 `npm run typecheck` ⇒ 退出 0；`npm run lint` ⇒ 退出 0（0 error；输出仅为既有 warning）。`npx playwright test --list e2e/voice-realtime-intent-control.spec.ts` ⇒ 退出 0（Total: 7 tests in 1 file）。
- AC2/AC4 由 `src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx`（4 / 0）承载：AC2 三连 `pending` 帧 ⇒ 恰 1 卡片、文本为末帧、卡片内 button 数 0；`pending{text:''}` ⇒ 卡片消失；`refused` ⇒ 字幕行显示 `voice.realtime.queueFull`（en 文案逐字取自 `en/chat.json`）。AC4 走 `ChatInterface` 退出处理器所评估的同一表达式 `collectUndeliveredUtterances(captions, deliveries, pendingMessage)`：被扣住的两句不入草稿、从未送出的第三句入草稿（非空性对照）。
- AC3 `grep -rnE "useVoicePendingWithdraw|VoicePendingUtterance|cancelQueuedVoice|voice-pending-utterance" src e2e --include=*.ts --include=*.tsx` ⇒ 无输出，退出 1。