---
id: gap-live-voice-queue-byte-budget-and-visible-backlog
title: Live Voice 忙时准入改「字节预算」：待投递文本按 UTF-8 字节计（默认 1000），预算内不再拒收；忙状态/待投递/未投递话语在屏上逐条可读
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

### 现状（2026-10-11 逐文件复核，带 file:line）

- **上限轴是「条数」**：`VOICE_QUEUE_MAX_DELIVERIES = 3`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:179`），判定点在 `proceedRelay`（同文件 `:1011-1030`），深度由 `queuedDepth()` 三项合成（`:899-900`：合并窗口计 1 + `waitingExtraMessages.length` + `cliQueuedDeliveries`）。
- **实测影响**（2026-10-11 19:22–19:30 CST，会话 `9db75ad5`，journal `~/.cloudcli/voice-realtime-log/faeb9c61-7af6-4fe3-8064-74ce421e68ed.jsonl`）：Claude 的回合跑了约 4 分钟，操作者随后说的 **8 句全部被拒**（`session_send refused: VOICE_QUEUE_FULL depth=3 max=3`），从未进入会话。这 8 句合计约 150 个汉字（**不足 500 字节**）——按字节算远在预算之内，按条数算却早已越界。被拒的话只留在 journal 里，操作者在屏上再也看不到。
- **被拒后模型转为自答**：同一 journal 里 3 次 `MODEL_TEXT_REPLY (recoverable): The voice model answered itself instead of passing your words to Claude`（11:26:14 / 11:26:18 / 11:26:26）。操作者明确要求模型**持续积极处理**，不接受它转成闲聊。
- **可见性缺口**：bar 只有一行截断 caption（`src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx:243-249`）；`queuedDepth` 只进 `data-queued-depth` 属性、**从不作为文本出现**（`:228-241`）；refusal 只驱动状态格一句文案（`:175-177`）。操作者因此把「排队等回合」误读成「语音识别很慢」。
- **传输层本来就支持排队**：忙时 `session_send` 返回 `{queued:true, queuedMessageUuid}` 并立刻返回（本次 journal `delivered in 29 ms`），消息落进 CLI 自己的队列（`server/modules/providers/list/claude/claude-sessions.provider.ts:1216` 注释）。**3 条上限是中继自己加的产品闸，不是传输限制**——抬高它就能真正「缓存这几分钟内的输入」。

### 人的裁定（2026-10-11，本会话）

- 上限的**形态 = 字数（如 1000 字节）**。不是条数，不是时间窗。
- 模型必须**持续积极处理**，不得自答。

### SCOPE BOUNDARY（有意划下）

- ⛔ 不做「退出 Live Voice 时把 backlog 转入 composer」——那是 `gap-live-voice-stop-vs-exit-affordances`。
- ⛔ 不做「用语音终止当前回合」——那是 `gap-live-voice-voice-terminated-interrupt`。
- ⛔ 不去让投递文本忠实于所言（中继模型合法改写，操作者已接受）。
- ✅ 本任务只做两件：**准入轴换成字节**，以及**在语音模式内把这些读数与话语弄可见**。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：于 `tasks/*.md` 对 `字节` / `byte` / `budget` / `预算` / `VOICE_QUEUE_MAX_DELIVERIES` / `queuedDepth` / `backlog` 逐个 grep，在 open 任务（`status: todo|ready`）中 **0 命中**。相关但机制不同：`gap-live-voice-bounded-queue-refusal-visible`（**done**，本任务修订它的准入轴：条数 3 → 字节预算 1000；其「有界 + 可见」的叙事保留）；`gap-live-voice-caption-removal-on-shown`（**done**，移除键从 `sent` 改为 `shown`）；`gap-live-voice-delivery-state-visible`（**done**，AC-327 的 `queued`/`delivering` 帧）——本任务复用它们的观测面，不重建。`task-granularity-advice.js` 对本任务 Touches 报 `peers: []`。

## Plan

1. **准入轴换成字节**：`voice-realtime-ws-proxy.service.ts` 里把「同时等待的投递条数」判定改为「待投递文本的 UTF-8 字节数」判定（`Buffer.byteLength(text, 'utf8')` 或等价）。预算经新 seam 注入（如 `seams.maxQueuedVoiceBytes`），默认命名常量 **1000**。`queuedDepth()` 的条数读数**保留**（它是已交付的观测面），并**另加**字节读数——两者不混成一个数。
2. **拒收降级为最后手段**：预算之内一律接受（并入合并窗口或 `waitingExtraMessages`）。超预算仍走既有 `refused` 帧 + `VOICE_QUEUE_FULL` 结果码路径（语义不变），但 reason 文案须说清「按字节超预算」并给出当前字节读数。
3. **被拒后模型仍持续投递**：`proceedRelay` 返回给模型的 instruction 必须明文要求「继续把后续话语投递过来，不要改成自己回答」；补断言证明被拒之后的下一次 `session_send` 仍到达 executor。**不给模型任何「hold 台词」。**
4. **在屏可见（仅语音模式内）**：
   - bar 的状态格把忙状态与待投递读数渲染为**文本**：「Claude 正在处理 · mm:ss · 待投递 N 字」。busy 读数由 `ChatInterface` 已有的 `isProcessing` / `sessionActivity` 经新 prop 传入（`VoiceRealtimeBar` 现在只收 `voice`/`onExit`/`modelMenu`/`banner`）。
   - 未投递/被拒的说话在 transcript 里**逐条成行**，而不是挤在 bar 的一格里：`placeCaptions.ts` 的 `voiceRowState` 增加「未投递」态（今天只有 `delivering` / `heard`），`ChatInterface.tsx` 的行装配随之扩展。**复用**已交付的 `voice-row-delivering` / `voice-closed-unshown-utterance` 观测面，不新增第二套状态机；新增 testid 仅**一个**（未投递行），在 AC 里点名。
5. **镜像同步**：若拒绝结果给模型加了字节字段，必须**同任务内**同步 `voice-realtime-tools.ts` 里 `session_send` 的 `outputSchema`（逐字段），保 `voice-realtime-bridge.test.ts` 的 AC-2 绿。
6. **不变式文本**：`server/modules/mcp-gateway/mcp-session-send.ts` 的「never rejects」段已由上一任务改写为有界规则，本任务只把其中「按条数」的措辞改为「按字节预算」。
7. **静态门**：`npm run typecheck`、`npm run lint`；若新增服务端测试文件，同步 `scripts/suite-duration-baseline.tsv` 与 `server/shared/tests/quay-test-script.test.ts`。

## AC

- [ ] AC1 字节边界（**取假形态，排在判据文件最前**）：预算 999 字节接受、1000 字节接受、1001 字节拒收。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-bounded-queue.test.ts` 退出 0，且该文件**首条断言**即 1001 字节那条被拒（拒绝那一轮 `base.session_send` 调用计数不增）。
- [ ] AC2 负控（预算之下逐位不变）：预算内行为与今天一致——接受、`sent` 帧、`base.session_send` 调用序列与改动前相等。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 退出 0。
- [ ] AC3 真实 incident 形态回归：把 journal `faeb9c61` 里那 8 句被拒的原文（合计 < 500 字节）作为输入，**全部接受、0 拒收**。判据同 AC1 文件退出 0，并给出「接受 8 / 拒收 0」的读数。
- [ ] AC4 被拒后仍持续投递：被拒之后的下一次 `session_send` 仍到达 executor（executor 调用计数 +1），模型未转自答。判据同 AC1 文件退出 0 并给出该计数读数。
- [ ] AC5 忙状态与待投递读数在屏上可读：`npm run test:client -- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出 0，含「忙时状态格文本含 `mm:ss` 与待投递字节数」与「无等待时读数为 0」两条断言。
- [ ] AC6 未投递话语逐条成行：`npm run test:client -- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx` 退出 0，含「2 句未投递 ⇒ 2 行、各带未投递标记」与**负控**「全部投递后该标记计数 0」。
- [ ] AC7 e2e 证据（**自证；`scripts/test.sh` 的 fan-in 套件不跑 Playwright**）：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 退出 0，含一条「held 会话上按字节预算接受 8 句」的浏览器读数用例。
- [ ] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；若新增服务端测试文件，`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：一次真实 Live Voice 会话，其 turn 在途 ≥2 分钟时连续说满 8 句以上（≈500 字节），操作者**在屏上**读到「Claude 正在处理 · mm:ss · 待投递 N 字」，且这些句子全部被接受、逐条可见；再把字节数推过 1000，读到一条**显式、可见**的拒收。证据落在本任务 Evidence（bar 文本读数、transcript 行计数、`base.session_send` 调用计数、`server.log` 中等待与拒收的相邻行）。单元测试必要但不充分。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-tools.ts (six-tool mirror; only if the refusal result gains a byte field)
- server/modules/mcp-gateway/mcp-session-send.ts (only the "by count" wording becomes "by byte budget")
- server/modules/voice-realtime/tests/voice-realtime-bounded-queue.test.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/ChatInterface.tsx
- src/shared/types.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx
- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-live-voice-queue-byte-budget-and-visible-backlog.md (self)
