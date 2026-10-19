---
id: gap-narrator-announce-phrase-cache
title: Live Voice 高频固定播报句预合成：announce 仍由模型自由造句、每句付一次 TTS 往返；改为固定短语表并在连接建立时预热缓存
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现象（2026-10-19 20:14–20:15 live 实测，journal `56278c8d-d0f0-444b-ad6e-8d7b2154275b.jsonl`）

同一条连接里 5 条 announce 全部是 8–9 字的高频短句，语义高度重复：「好的，测试已记录。」「正在处理你的反馈。」「正在处理延迟反馈。」「接近十秒。」。每一条都是模型当场生成、再当场走一次 TTS：

- `narrator speak announce-0` 20:14:53.436 → `tts_done` 20:14:54.619（1.18s）
- `announce-1` 20:15:04.633 → 20:15:05.739（1.11s）
- `announce-2` 20:15:13.211 → 20:15:16.746（3.53s）

内容是高频且相对固定的，却每次都要付一次网络往返和一次合成。合成耗时还会随服务排队抖动（0.66–3.53s），直接表现为播报延迟。

### 机制

- `voice-realtime-ws-proxy.service.ts` 的 `onFollowUpText`（约 5890 行）把模型自由生成的 follow-up 文本 `enqueue` 进 narrator 队列；`announce` 模式的 prompt 只约束「一句短句」，不约束具体措辞。
- `server/index.ts` 的 `narratorTts.speak` 每次都调用 `speakVoiceRealtimeText()` → `synthesizeVoiceRealtimeSpeech()`，没有任何缓存。
- 因此同一句话在一次连接里说两次，就要合成两次。

### 方案：固定短语表 + 连接级预热缓存

1. 新增 `voice-realtime-announce-phrases.ts`：`ANNOUNCE_PHRASES`（3–5 条短句，保持现有「我开始了」语义），`pickAnnouncePhrase(seq)` 确定性轮换。
2. `onFollowUpText` 仍作为触发时机，但**忽略模型文本**，改为 `enqueue({ utteranceId: 'announce-N', text: pickAnnouncePhrase(N) })`。模型侧措辞契约先不动，避免同时改 prompt 与测试。
3. 新增 `voice-realtime-tts-cache.ts`：
   - `createVoiceRealtimeTtsCache({ options, phrases, maxEntries = 64, log })`；
   - `warm()`：连接建立、凭据可用后并发预热全部短语，失败静默跳过，不阻塞连接；
   - `speak(input, downlink)`：命中直接发帧；未命中现合成并写入缓存；
   - 同一 `text` 的并发请求用 in-flight Map 去重；缓存 key 为 `model + voice + text`；超过上限按最旧淘汰；
   - 发帧逻辑与现合成路径共用 `voice-realtime-tts.ts` 抽出的 `emitVoiceRealtimeSynthesisFrames()`，保证帧顺序与 `tts_done` 读数一致。
4. `server/index.ts`：`narratorTts.speak` 改走缓存实例；在 `buildVoiceRealtimeSeams` 拿到凭据后 `void cache.warm()`（按连接一份即可，约 5 条 × 100KB）。日志增加 `tts cache hit/miss text=… chars=…`。

缓存未命中或预热失败时完全回退到现有现合成路径，不新增失败模式。

<!-- dedup-ref -->相关但不同机制：`voice-output-announce-start-confirmation`（已 done，announce 模式本身）定义了「说一句进度话」的行为；本任务只改这句话的来源与合成方式，不改触发时机。`voice-output-tts-downlink-wiring`（已 done）定义下行帧契约，本任务复用同一发帧函数。

### 粒度

separate：`task-granularity-advice` 对 Touches 返回 `peers: []`；本任务与本地门接线、首帧即播是三个独立验收的机制。固定短语表与缓存是一个机制的两半（没有短语表就没有可预热集合），放在同一任务内。

## Touches

- server/modules/voice-realtime/voice-realtime-announce-phrases.ts
- server/modules/voice-realtime/voice-realtime-tts-cache.ts
- server/modules/voice-realtime/voice-realtime-tts.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-tts-cache.test.ts
- server/modules/voice-realtime/tests/voice-realtime-announce-phrases.test.ts
- server/modules/voice-realtime/tests/voice-realtime-announce-narrator.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- e2e/voice-output-e2e-harness.spec.ts
- experiments/voice-e2e-harness/run.mjs
- tasks/gap-narrator-announce-phrase-cache.md

## AC

- [x] 新增 `voice-realtime-tts-cache.test.ts` 的命中腿：先 `warm()`，再 `speak()` 同一短语，注入的 `fetch` 调用数为 0，且发出的帧序列与直接 `speakVoiceRealtimeText()` 合成同一字节时逐帧相等。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-tts-cache.test.ts` exit 0。
- [x] 同文件的未命中/去重/失败腿（各自独立 `test()` 块）：未命中恰好 1 次 `fetch`；两个并发同文本请求合计 1 次 `fetch`；合成失败不写缓存；超过 `maxEntries` 按最旧淘汰。同一命令 exit 0。
- [x] 新增 `voice-realtime-announce-phrases.test.ts`：`pickAnnouncePhrase()` 对连续 seq 的返回值全部属于 `ANNOUNCE_PHRASES` 且确定性；proxy 集成腿断言 `announce` 下每条 `narrator_speak.text` 都属于固定集合，模型 follow-up 文本不会出现在出站帧里。同一命令 exit 0。
- [x] 预热判据：`warm()` 完成后，逐个 `speak()` 固定短语，`fetch` 调用数仍为 0，且每个短语都产出 `tts_audio` + `tts_done`；任一短语预热失败时该短语回退现合成且仍能出声。同一命令 exit 0。
- [x] 既有 announce 判据按固定短语表更新后仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-announce-narrator.test.ts` exit 0。
- [x] 新增 server 测试文件后重测并更新 `server/shared/tests/quay-test-script.test.ts` 的两处 known/unknown pin（按 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 的实测值），并在注释里点名本任务的两个文件；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` exit 0。
- [x] `npm run typecheck` 与 `npm run lint` 均 exit 0。

## DoD

用真实的 `buildVoiceRealtimeSeams` 装配（`VOICE_REALTIME_TTS_ENDPOINT` 指向一个记录请求的 loopback stand-in），打开一条连接，等 `warm()` 完成后投递一次 `session_send`，在 Notes 贴出：stand-in 收到的请求总数（应等于短语表大小，即预热请求数；announce 本身不再新增请求）、`narrator_speak.text` 的实际值、以及 `tts cache hit` 日志行。只有单测、没有这张「预热后 announce 零新增请求」的真实装配读数不算落地。

## Notes

### DoD：真实 `buildVoiceRealtimeSeams` 装配读数

命令：`node experiments/voice-e2e-harness/run.mjs`（scripted DashScope upstream + 真实 app server + 真实 Chromium 页面；`VOICE_REALTIME_TTS_ENDPOINT` 指向 loopback TTS stand-in，后者记录每个请求 body 并回一段 1.0s WAV）。结果 `9 passed`，`RESULT: PASS`。

- stand-in 收到的 TTS 请求总数：**5**
  - 4 条为连接建立时 `warm()` 的预热请求（= `ANNOUNCE_PHRASES.length`）：`好的，我开始了。` / `收到，马上开始。` / `明白，这就开始。` / `好的，正在处理。`
  - 第 5 条为 run-end summary 的现合成（缓存未命中，符合预期）
  - 4 条 announce 播报（announce-0..3）本身新增请求数：**0**
- 页面实际收到的 `narrator_speak.text`（按到达顺序）：
  - `announce-0` → `好的，我开始了。`
  - `run-end-summary-0` → `本轮任务已结束，全部检查通过。`
  - `announce-1` → `收到，马上开始。`
  - `announce-2` → `明白，这就开始。`
  - `announce-3` → `好的，正在处理。`
  - 模型 follow-up 触发文本 `好的，我来查一下。` 未出现在出站帧，也未出现在合成请求里。
- journal（`voice-realtime-log/868c56b7-1716-4b0e-b0ac-941176bdc3ec.jsonl`）中的缓存日志行：
  - `tts cache hit text=好的，我开始了。 chars=8`
  - `tts cache miss text=本轮任务已结束，全部检查通过。 chars=15`
  - `tts cache hit text=收到，马上开始。 chars=8`
  - `tts cache hit text=明白，这就开始。 chars=8`
  - `tts cache hit text=好的，正在处理。 chars=8`
- 首帧时序（e2e 读数）：speechEnd→firstStart = 10 ms；firstStart 早于 tts_done（13:19:11.803 < 13:19:11.804）。

### AC 执行读数

- `voice-realtime-tts-cache.test.ts`：7/7 pass（hit / miss / dedupe / failure / eviction / warm / warm-failure fallback）
- `voice-realtime-announce-phrases.test.ts`：2/2 pass
- `voice-realtime-announce-narrator.test.ts`：2/2 pass
- `voice-realtime-tts.test.ts`（AC-405）：8/8 pass；`voice-realtime-tts-stream.test.ts`：3/3 pass（共享抽出 `emitVoiceRealtimeSynthesisFrames()` 后未回归）
- `quay-test-script.test.ts`：14/14 pass；server 测试文件实测 379（377 + 2），两处 pin 更新为 unknown=376 / unknown=378
- `npm run typecheck` / `npm run lint`：exit 0
- `node experiments/voice-e2e-harness/run.mjs`：9 passed / RESULT: PASS

### 范围补充（Touches）

- `scripts/suite-duration-baseline.tsv`：新增两个测试文件后覆盖率从 340/377 降到 340/379（<90%），必须把两条新文件追加进 baseline（AC6 依赖的 AC7 覆盖率地板）。
- `e2e/voice-output-e2e-harness.spec.ts`、`experiments/voice-e2e-harness/run.mjs`：真实装配 harness 原先断言 announce 文本来自模型 follow-up、且按流式帧数计帧；固定短语 + 缓存整块发帧后这两处必须同步，否则 DoD 的真实装配腿会红。
- `server/modules/voice-realtime/tests/voice-realtime-announce-narrator.test.ts`：AC5 明确要求按固定短语表更新该既有判据。
