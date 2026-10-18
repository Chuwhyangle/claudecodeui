---
id: gap-live-voice-mic-prewarm-connecting-window
title: Live Voice 初始 Connecting 窗口的语音丢失：预热麦克风采集，连接前说的话 catch 下来待 open 后重放
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

### 现象（操作者 2026-10-18 实测 + 前一轮讨论已确认）

打开 Live Voice 模式的最初几秒，页面处于 `Connecting voice…` / `Starting microphone…` 状态；这段时间里说的话「有可能」丢掉，且不稳定——取决于说话起点相对采集就绪的时间。期望：这段时间输入的语音被 catch 下来，等连接建立后再发出去。

### 成因（读代码，逐层）

丢话根因不在连接，而在**麦克风还没开始采集**，而前端已有的一套「先 catch、连上再发」只覆盖了更晚的一段：

1. 已有缓冲只盖「采集已开始、上游未 open」的窗口：`useVoiceRealtimeSession.ts` 里帧到达时若 socket 未 `open` 就推 `pendingFramesRef`（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:1341-1344`），`state: open` 一到按序重放（同文件 `:1510-1524`）。但这只对 worklet 已经吐出的帧有效——采集还没开始的那段，页面根本没有任何帧可缓冲。
2. 采集是异步的慢腿：`microphoneAudioSource().start()` 依次 `getUserMedia`（首次授权会弹浏览器授权框）→ `new AudioContext()` → `audioWorklet.addModule(url)`（`?worker&url` 独立 bundle，冷缓存是一次网络加载）→ 建 `AudioWorkletNode`、接 graph，**之后** worklet 才回调 `onFrame`（`src/modules/chat/voice-realtime/audioSource.ts:77-86`）。这段就是「Starting microphone」的主体。
3. 入口还叠了 session 分配：无 session 的新对话点 Live Voice，`enterVoiceMode` 先 `createChatSession`（resident 模式再 `setSessionLifecycleMode` 一次）**之后** `composerMode` 才变 `'voice'` 触发 `startVoiceCapture()`（`src/modules/chat/ChatInterface.tsx:418-490` + `:554-567`）——麦克风请求要等分配完才发起。

于是完整「Connecting」= session 分配（仅新对话）+ socket 拨号 + getUserMedia + worklet 加载，后两项每次都在，且是丢话主因。

### 修法（仅前端，预热 + 复用既有缓冲）

1. 把 `microphoneAudioSource()` 拆成 acquire 与 start：acquire 做 `getUserMedia` + `AudioContext` + `addModule` + 建 node，并把结果（流/context/worklet）缓存；新增一个预热入口（如 `warmMicrophoneSource()`），预热后 `start()` 复用已采集的流，只接 graph、开始吐帧，**不再重复授权/加载**。
2. `ChatInterface.enterVoiceMode` 在**点击按钮的当下**（session 分配之前）就发起预热，与分配并行；已有 session 时同样在点按钮当下预热，而不是等 `startVoiceCapture()`。
3. `useVoiceRealtimeSession` 复用预热好的 source；连接前产出的帧继续走既有 `pendingFramesRef`，`state: open` 后按序重放——这条机制不变，只是让它真正有帧可缓冲。

### 诚实边界

首次授权时，浏览器在用户点 Allow 之前无法捕获任何音频，这是硬下限，本任务不能补回授权框弹出前说的话。本任务把「授权之后的 context/worklet 加载」与「session 分配」两段重叠掉，使后续进入近即时、且连接前产出的帧全部进缓冲。

### 相关但不同机制（不合并）

- `gap-live-voice-listening-before-capture-ready`（已 done）只把状态改成「未就绪不显示 Listening」，其 Proposal 明写「这个窗口内说的话根本不会进入 WAV/上行」——本条正是把那句话接住，机制不同。
- 服务端次级嫌疑（不并入本条，待实测另立）：客户端被告知 `open` 的时机是桥的裸 socket open（`server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:1297-1301`、`voice-realtime-bridge.service.ts:1656-1659`），而非 ASR `session.created`/`session.updated`；flush 的音频理论上可能早于 ASR session 就绪。因麦克风通常比 socket 慢，判定为非主因，本条不改服务端。

## AC

- [x] `npx vitest run src/modules/chat/voice-realtime/tests/audioSource.warm.test.ts` 退出码 0；该文件断言 (a) 预热完成 `getUserMedia` + `addModule` + 建 node 各一次；(b) 预热后再 `start()` 不重复 `getUserMedia`/`addModule`，且首个采集帧直接经 `onFrame` 交付；(c) 未预热直接 `start()` 仍走原路径（复用 `audioSource.microphoneSuspend.test.ts` 的 FakeAudioContext harness，只 stub `?worker&url`）。
- [x] `npx vitest run src/modules/chat/tests/liveVoiceMicPrewarmEntry.test.tsx` 退出码 0；断言：无 session 时点击 live-voice 按钮，预热入口在 `createChatSession` resolve 之前已被调用（spy 调用顺序）；已有 session 时点击按钮同样先发起预热。
- [x] `npx vitest run src/modules/chat/voice-realtime/tests/voiceCaptureReadyState.test.tsx src/modules/chat/voice-realtime/tests/audioSource.microphoneSuspend.test.ts src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出码 0（既有相位/挂起/缓冲行为不回退）。
- [x] `npx tsc --noEmit -p tsconfig.json` 退出码 0。

## DoD

真机（授权已给）点击 Live Voice 后立刻说话，Connecting 窗口内的话进入上行 WAV/转写，不再丢：机械前提是 AC1/AC2 单测证明「预热后只做一次授权/加载、点按钮当下即预热」，AC3 证明连接前产出的帧仍经 `pendingFramesRef` 在 `state: open` 后按序重放。真机 smoke 由人完成并记录读数（connectionId / `getUserMedia` 完成时刻 / 首帧时刻 / 上行帧数）；组件单测通过只是必要不充分。

## Touches

- src/modules/chat/voice-realtime/audioSource.ts
- src/modules/chat/voice-realtime/index.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/voice-realtime/tests/audioSource.warm.test.ts
- src/modules/chat/tests/liveVoiceMicPrewarmEntry.test.tsx
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx
- tasks/gap-live-voice-mic-prewarm-connecting-window.md
