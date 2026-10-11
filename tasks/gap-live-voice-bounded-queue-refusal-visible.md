---
id: gap-live-voice-bounded-queue-refusal-visible
title: Live Voice 忙时有界排队：投递不再无声堆进 CLI 队列——设上限、超出即拒并告知、队列深度可见（不使用不可用的撤单能力）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line；写前逐条重读，仍成立）

- **忙时投递无声堆进 CLI 队列**：会话处于 mid-turn 时，中继的 `session_send` 把话语交给 Claude Code CLI，落进 **CLI 自己的队列**——`server/modules/providers/list/claude/claude-sessions.provider.ts:1216` 的注释自述「Where one queued user message is in the CLI's own queue」。中继立刻回 `sent`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:669-675`），既无上限、无拒绝，也无可见深度。
- **记录的发送语义今天就是「永不拒绝」**：`server/modules/mcp-gateway/mcp-session-send.ts:40-41` 逐字写着 "The send SEMANTICS are unchanged: this tool still only queues (never rejects, never auto-answers), and a `queued: false` send is never blocked"；`queued: true` + `blockedBy` 记录在 `:33-35`，结果类型在 `:88`（`{ ok: true; runId: string; queued: boolean; queuedMessageUuid: string | null }`）。本任务引入上限，故必须显式写下新规则，并同步更新该处不变式文本与任何断言「never rejects」的测试。
- **不得建在撤单能力上**：`cancelQueuedInput` 只是能力槽位（`server/modules/providers/services/provider-runtime.service.ts:377`、`:740`），而 claude provider 该槽为 `false`（`server/modules/providers/services/provider-capabilities.service.ts:150`，注释 "not covered by E1–E8"）。排队消息无法撤回，故上限必须在入队**之前**强制，而不是靠撤销一条队列项。
- **中继侧落点**：`voice-realtime-ws-proxy.service.ts` 的 `deliverSessionSend`（`:639-705`）在 `sending` 忙时，若会话仍在忙（`waitingForBusySession`）就把后续消息塞进**无界数组** `waitingExtraMessages`（`:641-652`）并立刻回 `{accepted:true, instruction:...}`；`sessionSend`（`:755-798`）在合并窗口打开时给浏览器发 `queued` 帧（`:784-790`），`flushCoalesced`（`:725-746`）到点才真正 `base.session_send`。浏览器把这些帧读进 `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:676-682`（`queued` ⇒ `delivering`）。
- **实测影响**（2026-10-11 01:54–01:57 CST，tag `d88c6722`）：操作者连说 >2 分钟；4 条投递被接受，其中 3 条堆在 CLI 队列里；屏幕只显示 1 条消息。没有任何东西告诉操作者还有三句话在等。

### 本任务实现的决定（操作者选择，选项 (b)）

**有界 + 可见**：给同时等待的语音投递数设上限；超上限的投递被**显式、用户可见的理由**拒绝（而不再无声并入无界队列）；等待深度 /「还没轮到你」的状态对操作者可见。操作者明确在「忙即拒」（选项 a）与「继续无声排队」（选项 c）之间选了 (b)，因为它既不丢话也不藏等待。

### 要建什么

1. 语音投递排队数的上限，在 **CloudCLI 边界**（中继 `sessionSend`/`deliverSessionSend`）于消息到达 CLI 队列**之前**强制。
2. 一条显式、可见的拒绝路径（操作者能分辨「这条被拒」与「这条在等」），带一个稳定、写明的 reason code。
3. 等待状态与深度的可见性，与已落地的 AC-327 交付状态工作同属**一个**叙事，使操作者读到的是一段故事而不是两段。
4. 把新规则写在旧不变式所在处，使后人不会再读 `mcp-session-send.ts` 而以为发送永不被拒。

<!-- dedup-ref --> 机制去重（立案时实测）：`task_list({search:"Live Voice 忙时有界排队"})`、`{search:"voice queue bound"})`、`{search:"queued delivery cap"})`、`{search:"队列深度"})`、`{search:"VOICE_QUEUE_FULL"})`、`{search:"queue depth"})`、`{search:"waitingExtraMessages"})`、`{search:"busy refuse"})`、`{search:"拒绝"})` 均 0 命中。相关但机制不同、判定 **separate**：`gap-live-voice-delivery-state-visible`（AC-327，已 done）落的是「已听到 / 整理中」的 outbound 帧与前端行状态，本任务在其之上加「被拒」这一新状态与排队上限；`gap-voice-realtime-empty-transcript-delivery-guard`（ready）在投递点拦「空转写」、`gap-voice-realtime-uplink-audio-capture`（ready）做上行音频旁路采集，两者 Touches 都含 `voice-realtime-ws-proxy.service.ts`，调度器据此串行，但机制与验收相互独立。三者无一同机制，不构成重复立案；合并候选按 Touches 文件核亦判定 **separate**。

## Plan

1. **有界账本（中继，`voice-realtime-ws-proxy.service.ts`）**：把无界的 `waitingExtraMessages` 与合并窗口里的 `pendingParts` 收进一个带容量的账本；容量由新 seam（如 `seams.maxQueuedVoiceDeliveries`）注入，默认取一个命名常量（建议 3——与实测里「3 条堆在 CLI 队列」同量级）。账本暴露 `queuedDepth()` 读数。上限在 `await base.session_send(...)`（真正到达 CLI/transport）**之前**判定：已达上限时不再入队。
2. **拒绝路径**：超出上限的投递不再入队，而是 (a) 对模型返回一个显式的非接受结果（稳定 reason code，建议 `VOICE_QUEUE_FULL`，附当前深度，措辞明文制止它重试刷屏）；(b) 对浏览器发一个**新的 outbound 帧**（建议 `{type:'refused', reason:'queue-full', depth}`，名称以实现为准、语义不可换）。词不被无声丢弃——在帧/结果里按 reason 明说其去向（保留为未显示的 caption 行，或明确丢弃），二者选一并在本任务写清。
3. **深度可见（前端，`useVoiceRealtimeSession.ts`）**：`ServerFrame` 联合与 `onmessage` 增加该帧分支，导出 `refusal`（或等价的「最近一次被拒」）与 `queuedDepth` 读数；与 AC-327 的 `delivering` 落在同一状态机/同一行，不是第二个故事。`VoiceRealtimeSession` 类型加字段、hook 返回之。
4. **镜像同步**：若拒绝需要给 gateway `session_send` 的结果加字段（`mcp-session-send.ts` 的 `SessionSendPayload` 与 `SESSION_SEND_BLOCKED_BY_SCHEMA` 一带），必须**同任务内**同步 `server/modules/voice-realtime/voice-realtime-tools.ts` 里 `session_send` 的 `outputSchema` 镜像（field-for-field），并让 `server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 的 AC-2 对比保持绿；`tests/realtime-bridge-harness.ts` 若捕获路径需要，一并更新。
5. **不变式文本与测试**：把 `mcp-session-send.ts:40-41` 的「never rejects」改为新规则（写明「有界、超限即拒、拒绝可见」），并更新任何断言「never rejects」的测试；`voice-realtime-live-executor.ts` 若承担 `session_send` 的组装/路由，同步其类型与注释。
6. **能力槽文档**：仅在需要时，于 `server/modules/providers/services/provider-capabilities.service.ts:150` 附近标注 claude 的 `cancelQueuedInput:false` 槽位在本机制下**不可用**（本机制不建在撤单上）；**不改其值**。
7. **静态门**：新增 server 测试文件会牵动 `server/shared/tests/quay-test-script.test.ts` 的文件数钉子与 `scripts/suite-duration-baseline.tsv`，同步之；跑 `npm run typecheck` 与 `npm run lint`。

## AC

- [ ] AC1 满额即拒且可见：达上限后再来一条语音投递被拒——`session_send` 对模型返回稳定 reason code（`VOICE_QUEUE_FULL`），浏览器收到拒绝帧；「这条被拒」可与「这条在等」在测试读数上区分；拒绝**不无声丢词**——按 reason 明说词的去向。判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-bounded-queue.test.ts` 退出 0，且该文件**第一条**断言即「满额后 `base.session_send` 调用计数不增加」（取假形态时它最先变红）。
- [ ] AC2 负控（上限之下逐位不变）：未达上限时行为与今天一致——接受、`sent` 帧、中继路径不变。判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 退出 0，且新增断言在未满额时 `base.session_send` 的调用序列与改动前相等。
- [ ] AC3 上限在 CLI 队列之前强制：新测试证明被拒的消息**从未到达** `session_send` 的 transport/executor 路径——拒绝那一轮 `base.session_send`/executor 替身的调用计数为 0。判据：同 AC1 文件退出 0 并给出该计数读数。
- [ ] AC4 深度可观测且零负控：等待深度在一个**可命名的**观察面可读（浏览器 `queuedDepth` / 拒绝帧携带的 `depth`，或 `session_get` 的 `queuedMessages`——以实现为准并写明）；无等待时该读数为 0。判据：`npm run test:client -- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出 0，含 depth=0 负控断言。
- [ ] AC5 不变式与镜像一致：`mcp-session-send.ts:40-41` 的「never rejects」文本已改为新规则，断言「never rejects」的测试已更新；若给 `session_send` 结果加了字段，则 `voice-realtime-tools.ts` 的镜像已同步、`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 退出 0。⚠️ 已知陷阱：给 send 结果加字段会因 voice plane 逐字段镜像而让该测试变红，必须同任务内同步。
- [ ] AC6 真实忙会话下的拒绝路径：拒绝路径在**真的忙**的会话上被走到（真或 harness，不是只有单测替身）。判据：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 退出 0，含一条把交付延后到产生真实排队的用例，读到拒绝帧与可见的等待状态。

## DoD

一个**真实对象**被这套机制操作过：真实 Live Voice 会话其 turn 在途时，连说**超过上限**的话 ⇒ 在上限处读到一条**显式、可见的拒绝**（浏览器上可见、模型侧可读到 reason），而上限**之下**读到可见的等待状态；等待深度读得到、无等待时为 0。单元测试是必要但不充分的。证据落在本任务 Evidence（帧读数、`base.session_send` 计数、`server.log` 中拒绝与等待的相邻行、e2e 读数/截图）。

## Touches

- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-live-executor.ts
- server/modules/voice-realtime/voice-realtime-tools.ts (six-tool mirror; only if the send result gains a field)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- server/modules/providers/services/provider-capabilities.service.ts (only if the false cancelQueuedInput slot must be documented unusable)
- server/modules/voice-realtime/tests/voice-realtime-bounded-queue.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
- server/modules/voice-realtime/tests/realtime-bridge-harness.ts (only if the mirror capture path needs it)
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- e2e/voice-realtime-upload-fixture.spec.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-live-voice-bounded-queue-refusal-visible.md (self)