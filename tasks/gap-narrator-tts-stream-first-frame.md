---
id: gap-narrator-tts-stream-first-frame
title: Live Voice narrator 首帧即播：TTS leaf 等完整 SSE 合成后才发帧、页面等 tts_done 才起播，9
  字播报也要约 2.1s 才出声
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

### 现象（2026-10-19 20:14–20:15 live 实测，journal `56278c8d-d0f0-444b-ad6e-8d7b2154275b.jsonl`）

单条 9–16 字播报从「用户说完」到「页面起播」约 2.1s：

- announce-0：`function_call session_send` 20:14:52.927 → `narrator speak` 20:14:53.436（TTS 请求发出）→ `narrator tts done` 20:14:54.619（1.18s 后）→ 页面在这一刻才开始播放；
- 用户语音在 20:14:52.405 结束，announce-0 的 `tts_done` 在 20:14:54.619，即 2.2s；
- announce-2 的合成耗时更长：`narrator speak` 20:15:13.211 → `tts_done` 20:15:16.746（3.5s）。

### 机制：两段串行等待

1. **服务端** `speakVoiceRealtimeText()` 先 `await synthesizeVoiceRealtimeSpeech()`，把整条 SSE 流读完并聚合成完整 WAV，之后才按 `frameBytes` 切帧下发。合成期间浏览器收不到任何 `tts_audio`。
2. **页面** `playNarratorTts()` 只在 `tts_done` 到达时被调用：把已收帧拼成 Blob，再 `new Audio().play()`。即使首帧早就到了，也要等最后一个字节。

两端叠加，短句也至少付一次完整合成往返 + 一次全量传输。

### 方案：帧随 SSE 走，页面收到 PCM 就调度

- 服务端新增 `streamVoiceRealtimeSpeech()`：边读 SSE 边发帧。增量解析 RIFF 头；头完整后先发一帧 `seq: 0` 的完整头部字节，随后发 PCM 数据切片（沿用 `frameBytes = 16 KiB`），最后发 `tts_done`。
- **不新增帧类型，保持向后兼容**：`seq: 0` 是合法 RIFF 头 + 后续 PCM，旧页面把全部帧拼起来仍是一个可播放的 WAV；新页面识别 `seq: 0` 后改用 `AudioContext` 流式调度。
- 页面 `tts_audio`：首帧解析头，后续帧 base64 → PCM16 → Float32 → `AudioBuffer`，按 `nextStartTime` 连续 `start()`；首帧到达即出声。`tts_done` 只表示「不会再有数据」，`narrator_done` 在最后一个已调度 source 的 `ended` 后发出，保持队列 pacing。
- `narrator_stop`：停止所有已调度 source、清空队列、不 ack。
- 回退路径：`format !== 'wav'`、没有 `AudioContext`、或 `resume()` 被自动播放策略拒绝时，退回现有「攒到 `tts_done` 播 Blob」路径。
- 失败语义不变：任何失败仍只发一个 `tts_error`；已发过音频时页面停止播放。

<!-- dedup-ref -->相关但不同机制：`voice-output-tts-downlink-wiring`（已 done，把 TTS 音频接到下行帧并播放）定义了「有音频可播」的契约；本任务只改「何时开始发帧/起播」，不改帧的语义与错误码。

### 粒度

separate：`task-granularity-advice` 对 Touches 返回 `peers: []`；本任务与本地门接线、固定句缓存是三个独立验收的机制。服务端与页面必须同版发布，因此放在同一任务内。

## Plan

1. `voice-realtime-tts.ts`：抽出共享的 `emitVoiceRealtimeSynthesisFrames()`；新增 `streamVoiceRealtimeSpeech(input, options, downlink)`：
   - 增量 RIFF 解析（复用现有 `wavDurationMs` 的 chunk walk 逻辑，改为可喂入切片）；
   - 头确定后发 `seq: 0`（头部字节）；
   - 每个 SSE 事件解出的 PCM 追加到待发缓冲，按 `frameBytes` 切帧、`seq` 递增；
   - 流结束发 `tts_done`（`bytes` 为 PCM 数据字节数，`durationMs` 由头/data 长度计算）；
   - 失败只发一个 `tts_error`；已发音频后的失败同样以 `tts_error` 终止。
2. `server/index.ts`：`narratorTts.speak` 改调 `streamVoiceRealtimeSpeech`；`speakVoiceRealtimeText` 保留给需要完整字节的调用方（缓存预热仍用 `synthesizeVoiceRealtimeSpeech`）。
3. `useVoiceRealtimeSession.ts`：按上面的页面方案实现流式调度；保留现有 Blob 路径作为回退。
4. 判据：服务端 `voice-realtime-tts-stream.test.ts`；页面 `voiceRealtimeNarratorStream.test.tsx`；确认既有 AC-405 判据仍绿。

## Touches

- server/modules/voice-realtime/voice-realtime-tts.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-tts-stream.test.ts
- server/modules/voice-realtime/tests/voice-realtime-tts.test.ts
- server/shared/tests/quay-test-script.test.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/tests/voiceRealtimeNarratorStream.test.tsx
- e2e/voice-output-e2e-harness.spec.ts
- experiments/voice-e2e-harness/wavMic.ts
- tasks/gap-narrator-tts-stream-first-frame.md

## AC

- [x] 新增服务端判据 `voice-realtime-tts-stream.test.ts`：stand-in 把 WAV 拆成多个 SSE 事件并在关闭时置一个 `closed` 标志；断言第一个 `tts_audio` 帧在 `closed` 之前到达 downlink，`seq: 0` 解码后以 `RIFF` 开头，全部帧重组后等于 stand-in 的完整 WAV，`tts_done` 是最后一帧。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-tts-stream.test.ts` exit 0。
- [x] 同文件的错误腿（独立 `test()` 块，名字含 `error-leg`）：SSE 在音频开始前报错时只发一个 `tts_error`、不发 `tts_audio`/`tts_done`。同一命令 exit 0。
- [x] 新增页面判据 `voiceRealtimeNarratorStream.test.tsx`：用记录 `start()` 时刻的 fake `AudioContext`，断言首个 source 的 `start()` 发生在 `tts_done` 之前；`tts_done` 与最后一个 source 的 `ended` 之后恰好一次 `narrator_done`。`npx vitest run src/modules/chat/voice-realtime/tests/voiceRealtimeNarratorStream.test.tsx` exit 0。
- [x] 同文件的回退腿（独立 `test()` 块，名字含 `fallback`）：没有 `AudioContext` 时仍走 Blob 路径并在播放结束后 ack；`narrator_stop` 对所有已调度 source 调 `stop()` 且不发 `narrator_done`。同一命令 exit 0。
- [x] 既有 AC-405 判据仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-tts.test.ts` exit 0。
- [x] 新增 server 测试文件后重测并更新 `server/shared/tests/quay-test-script.test.ts` 的两处 known/unknown pin（按 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 的实测值），并在注释里点名本任务文件；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` exit 0。
- [x] `npm run typecheck`、`npm run lint`、`npm run build:client` 均 exit 0。

## DoD

用仓库的 live-voice 回环 harness（`VOICE_REALTIME_TTS_ENDPOINT` 指向 loopback stand-in）+ 真实浏览器页面播放一条 9 字 announce，在 Notes 贴出两个时刻：首个 `tts_audio` 到达并被 `start()` 的时刻，以及 `tts_done` 的时刻。首个 source 必须早于 `tts_done` 起播，且「用户语音结束 → 首个 source 起播」< 1.2s（修复前实测 2.1–2.2s）。只跑单测、没有这张真实页面播放的时序表不算落地。

## Notes

### DoD：真实浏览器 + loopback harness 的时序表

命令：`node experiments/voice-e2e-harness/run.mjs`（scripted DashScope upstream + 真实 app server + 真实 Chromium 页面；`VOICE_REALTIME_TTS_ENDPOINT` 指向 loopback TTS stand-in，后者用 3 个 SSE 事件发一段 1.0s WAV）。结果 `9 passed`，`RESULT: PASS`。announce 文本 `好的，我来查一下。`（9 字）。

| 读数 | 时刻 |
| --- | --- |
| 该 announce 所回应的用户语音结束（页面收到的最后一条 `caption final`） | 2026-10-19T13:03:43.334Z |
| 首个 `tts_audio` 帧到达页面 | 2026-10-19T13:03:43.354Z |
| 首个 `AudioBufferSourceNode.start()`（开始播放） | 2026-10-19T13:03:43.356Z |
| `tts_done` 到达页面 | 2026-10-19T13:03:43.358Z |

- 首个 source 起播 − 用户语音结束 = **22 ms**（预算 < 1200 ms；修复前 live 实测 2.1–2.2 s）
- 首个 source 起播 − 首个 `tts_audio` 到达 = **2 ms**
- 首个 source 起播早于 `tts_done`：**是**（早 2 ms）

e2e 判据 `the first narrator audio started BEFORE tts_done, and within the speech-end budget` 已把这两条读数钉进 spec。

### 判据执行读数

- `voice-realtime-tts-stream.test.ts`：3/3 pass（含首帧在 `closed=false` 时到达、header 跨事件、`error-leg`）
- `voice-realtime-tts.test.ts`（AC-405）：8/8 pass
- `quay-test-script.test.ts`：14/14 pass；server 测试文件实测 377（376 + 1）
- `voiceRealtimeNarratorStream.test.tsx`：2/2 pass；既有 `useVoiceRealtimeSession.test.tsx` 55/55 pass
- `npm run typecheck` / `npm run lint` / `npm run build:client`：exit 0

### harness 侧的必要修正

`experiments/voice-e2e-harness/wavMic.ts` 的 capture `AudioContext` 原本是只实现采集接口的 stub；页面的流式播放会向它要 `createBuffer`/`createBufferSource`，于是静默走 Blob 回退，真实浏览器从未走到流式腿。现在该 fake 把播放面委托给一个真实 `AudioContext`；e2e spec 同时按新帧形态计数（`1 + ceil(pcm/frameBytes)`）并 tap `AudioBufferSourceNode.start` 记录起播时刻。
