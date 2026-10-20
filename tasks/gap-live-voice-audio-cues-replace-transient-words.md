---
id: gap-live-voice-audio-cues-replace-transient-words
title: Live Voice 降认知负担：去掉 Connecting/Listening/Starting 瞬态文案，加进入/退出/断开三种非语音音效
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

Live Voice 目前把连接相位直接写成文字：`Connecting voice…` / `Starting microphone…` / `Listening…`（`VoiceRealtimeBar.tsx` 的 `phaseLabel`，覆盖 `idle`/`connecting`/`arming`/`listening` 四态）。这些词是瞬态噪音：进入时语音不丢（`useVoiceRealtimeSession.ts` 在 `state: open` 前把采集帧压进 `pendingFramesRef`，open 后按序重放，已有测试钉住），用户无需为「正在连接/正在听」盯屏幕。原则是降低认知负担，让 Live Voice 操作尽量不用看屏幕：只有「需要你行动或该知道」的状态才出字——`Muted`（你的话会被丢）、`Voice disconnected`、失败句保留；三个瞬态词去掉，改用**非语音音效**告知进入/退出/断开。

音效方案（用户已拍板）：
- 进入：上行双音（短促、软音量），在**采集就绪**时响——即会话首次真正进入 `listening` 的时刻（旧 `Listening…` 出现的位置），不是点击瞬间。
- 退出：下行双音。
- 断开/失败：第三种「注意」音（与进出明显区分），连接断开或失败时响一次。
- 音源是 WebAudio `OscillatorNode` 合成（纯代码、零资源文件、零网络），**绝不**复用 narrator/TTS 的合成语音路径，也不引入任何音频资产文件。

<!-- dedup-ref -->
本任务与已落地任务机制不同：`gap-live-voice-mic-prewarm-connecting-window`（缓冲重放，连接前不丢话）、`gap-live-voice-listening-before-capture-ready`（引入 arming 相位，让 Listening 不早于首帧）、`gap-continuous-experience-arming-phase-before-first-frame`（据此重锚 e2e 读数）、`gap-voice-ui-strip-to-caption-and-connection-state`（状态格只留相位五词）都只是把「瞬态词」当作连接相位的文字去修或去钉；本任务反过来把这三个词从文字里去掉并换成音效，是新的产品语义变更，独立验收。

实现要点：
- `phaseLabel`：`idle`/`connecting`/`arming`/`listening` 返回空串；`muted`/`disconnected`/`failed` 文案不动。视觉不退化：`Loader2` 转圈（connecting/arming）与 `AudioLines`（listening）图标保留，`mm:ss`、波形、caption 行照常；`data-testid="voice-realtime-phase"` 与 `data-capture="starting|live"` 属性保留，测试/探针读属性不读文案。
- 新文件 `soundCue.ts`（模块私有，`.ts` 非 JSX）：懒建一个模块级 `AudioContext`，暴露 `primeVoiceCues()`（在用户手势内 create+resume，解决 autoplay）与 `playVoiceEnterCue()` / `playVoiceExitCue()` / `playVoiceAttentionCue()`。AudioContext 缺失时静默降级（jsdom/无 WebAudio 不抛）。
- 触发点都在 hook 内，不进 barrel 的业务路径、ChatInterface 除 prime 外不改：
  - 进入 cue：每次**非 reconnect** 的 `start()` 后，会话第一次进入 `listening` 时响一次（`beginCapture` 首帧 / `state:open` 已就绪 / unmute 三处合流到一个 guard 位）；reconnect 不重置该 guard，故重连不再响。
  - 退出 cue：`end()` 里响一次，且仅当会话确实开启过（guard 位）。
  - 断开/失败 cue：每个连接（含重连）开始时 guard 复位，该连接首次进入 `disconnected` 或 `failed` 时响一次（`state: closed`、socket onclose、`fail()` 三处合流），不与退出 cue 混响。
- `ChatInterface.tsx`：在 `enterVoiceMode` 点击手势内调 `primeVoiceCues()`（紧邻 `warmMicrophoneSource()`），经 `voice-realtime/index.ts` barrel 暴露。

## AC

- [x] `grep -nE "voice\.realtime\.(connecting|listening)|Starting microphone" src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx` 退出码 1（三个瞬态词不再出现在 bar 的渲染路径），且 `grep -nE "Voice disconnected|voice\.realtime\.(muted|failed)" src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx` 仍有命中（保留态文案未被一起删光）。
- [x] `bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/voice-realtime/tests/voiceCaptureReadyState.test.tsx src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出码 0 —— 这两处已重锚：arming/listening 相位下 `[data-testid="voice-realtime-status"]` 的 `textContent` 为空串，`data-capture` 仍读 `starting`/`live`，`data-testid="voice-realtime-phase"` 仍读相位；`muted`/`disconnected`/`failed` 文案断言不变。
- [x] `bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/voice-realtime/tests/soundCue.test.ts` 退出码 0 —— 新增用例断言：enter cue 在会话首次进入 `listening` 时恰好被调一次、reconnect 再次 `listening` 不重调；exit cue 在 `end()` 恰好一次、未开启过则不调；attention cue 在进入 `disconnected`/`failed` 时恰好一次、正常 `end()` 不调；`soundCue.ts` 经 `createOscillator` 合成而非 `new Audio(` / narrator / TTS 路径。
- [x] `grep -rnE "playVoice(Enter|Exit|Attention)Cue|primeVoiceCues" src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts src/modules/chat/ChatInterface.tsx src/modules/chat/voice-realtime/index.ts` 命中分布与上文触发点/barrel 声明一致（cue 只经这三处合流，无散落调用点）。
- [x] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。
- [x] `grep -nE "'(Connecting voice|Listening|Starting microphone)'" e2e/voice-realtime-capture-ready-status.spec.ts` 退出码 1（spec 改为读 `data-capture` 与空文案），且 `bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-capture-ready-status.spec.ts` 退出码 0。
- [x] `grep -n "every sample of the state line must carry words" e2e/voice-realtime-continuous-experience.spec.ts` 仍有命中，但其断言体已改为「仅非瞬态相位要求非空」（X-6 不再在 transient 相位要求文字，改读 `data-capture`/相位）。

## DoD

- [x] `bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-capture-ready-status.spec.ts e2e/voice-realtime-continuous-experience.spec.ts` 退出码 0：脚本化上游下，bar 在 transient 相位无瞬态文案、`data-capture` 读数正确、X-6 重锚后全绿。
- [ ] 真机实听（桌面浏览器 + 真实麦克风 + 真实上游）：进入上行双音、退出下行双音、断开/失败第三种音各响一次且与 TTS 旁白无混响；「正在连接/正在听/正在启动麦克风」文案不再出现。机器证据（单测断言 cue 恰被调一次 + e2e 无瞬态文案）齐备后，音频的「听得见、不刺耳」由 yale 实听确认（待外部）

## Touches

- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/soundCue.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/index.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/voice-realtime/tests/soundCue.test.ts
- src/modules/chat/voice-realtime/tests/voiceCaptureReadyState.test.tsx
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- e2e/voice-realtime-capture-ready-status.spec.ts
- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-audio-cues-replace-transient-words.md
