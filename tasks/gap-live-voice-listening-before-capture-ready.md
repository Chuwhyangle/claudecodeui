---
id: gap-live-voice-listening-before-capture-ready
title: Live Voice 在麦克风首帧到达前就显示 Listening：加「正在启动麦克风」相位，采集就绪后才算 listening
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

今天 Live Voice 实测（连接 `0256124a`，2026-10-18 09:58）暴露：麦克风还没开始采集时，底部状态已经显示 `Listening…`。

逐项读数：
- relay 在 `01:58:26.774Z` 发出 `state: open`（此时上游 `session.update` 尚未 ack，`session.updated` 在 `01:58:26.915Z`）；
- 浏览器在收到该帧时就把相位切成 `listening`（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:1485`）；
- 而 `beginCapture(source)`（同文件 `:1935`）里的 `source.start()` 是异步的：`getUserMedia` → `new AudioContext()` → `audioWorklet.addModule` → 建 `AudioWorkletNode`；
- 本次第一条采集帧到 `01:58:27.063Z`，比 `state: open` 晚 **289ms**；首次麦克风授权时这个窗口会显著更长。

这个窗口内说的话根本不会进入 WAV/上行（采集还没产出任何帧），但页面已经宣称在听。操作者要求：没准备好时显示表示「还没准备好」的状态，不要显示 Listening。

方案（仅前端）：
- 在 `VoiceRealtimePhase` 中增加一个显式相位（建议 `arming`）：收到 `state: open` 后若未静音进入 `arming`；**第一帧采集音频到达后**才进入 `listening`。首帧判定必须放在 `beginCapture` 的 `onFrame` 最前（在 muted 早退之前），因为静音时帧仍会到达。
- `muted`、重连、断线、退出都要正确处理该相位：静音期间到达的首帧仍记为采集已就绪，取消静音后直接回 `listening`；重连后重新进入 `arming`。
- `src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx` 的 `phaseLabel` 为 `arming` 增加文案（`voice.realtime.startingMic`，`defaultValue: 'Starting microphone…'`）；该相位波形保持不活动，图标沿用 connecting 的 spinner；`canToggleMute` 仍允许 Mute。
- 在 `voice-realtime-status` 上暴露稳定读数 `data-capture="starting" | "live"`，让 e2e 不依赖文案。

相关但不同机制（不合并）：`gap-live-voice-mic-audiocontext-suspend-resume` 处理 AudioContext 挂起后的断流恢复；`gap-voice-ui-strip-to-caption-and-connection-state` 是状态栏文案减法。本条是「相位在采集就绪前就宣称 listening」。

## AC

- [x] `npx vitest run src/modules/chat/voice-realtime/tests/voiceCaptureReadyState.test.tsx` 退出码 0；该文件含两条用例：(a) 收到 `state: open` 且尚未收到任何音频帧时，`voice-realtime-status` 的文案不是 `Listening…` 而是未就绪文案，且 `data-capture="starting"`；(b) 第一帧到达后变为 `Listening…` 且 `data-capture="live"`。
- [x] `npx vitest run src/modules/chat/voice-realtime/tests/voiceMicSuspendedWaveform.test.tsx src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出码 0（既有相位行为不回退）。
- [x] `npx tsc --noEmit -p tsconfig.json` 退出码 0。
- [x] `bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-capture-ready-status.spec.ts` 退出码 0；该 spec 用 init script 让 `getUserMedia` 延迟至少 800ms、上游立刻发 `state: open`，在第一个采集帧之前读到未就绪状态，首帧后读到 `Listening…`。

## DoD

真实浏览器 + 真实 app server + 脚本化上游下跑通 `e2e/voice-realtime-capture-ready-status.spec.ts`：在 `getUserMedia` 尚未返回、上游已 `state: open` 的窗口里，页面显示未就绪文案而不是 `Listening…`（`data-capture="starting"`），波形不活动；第一个采集帧到达后同一个 `voice-realtime-status` 变为 `Listening…`（`data-capture="live"`）。读数取自 Playwright 的 DOM 读取；组件单测通过只是必要条件，不算落地。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/tests/voiceCaptureReadyState.test.tsx
- e2e/voice-realtime-capture-ready-status.spec.ts
- tasks/gap-live-voice-listening-before-capture-ready.md
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- playwright.config.ts

## Notes

两条 Touches 是在执行中按实际改动补登的：
- `tests/useVoiceRealtimeSession.test.tsx`：相位契约本身变了，9 条断言「open 后立即 listening」的既有用例改为「open 后 arming，首帧后 listening」（另在需要 listening 的用例里先推首帧）。这是 AC2「既有相位行为不回退」的落地改法，不是无关改写。
- `playwright.config.ts`：新 e2e spec 必须在 `voiceRealtimeSelection` 里（否则 server 不会指向脚本化上游）并在 `DEBUG_AGENT_SPEC_FILES` 里（否则没有可绑定的 session/fixture home）。
