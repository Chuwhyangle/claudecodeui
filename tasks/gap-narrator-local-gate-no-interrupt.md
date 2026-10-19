---
id: gap-narrator-local-gate-no-interrupt
title: Live Voice 本地语音门单独打断 narrator：环境噪声（RMS 300–470）在播报期间开出 started
  边界，announce 在 tts_done 前被 narrator_stop 清空 ⇒ 整条播报静音
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

### 现象（2026-10-19 20:14:46–20:15:38 live 实测，journal `56278c8d-d0f0-444b-ad6e-8d7b2154275b.jsonl`）

同一条连接里 narrator 的 5 条 announce 没有一条完整播出：

| utterance | narrator speak | narrator_stop | tts_done | 结果 |
|---|---|---|---|---|
| announce-0 | 20:14:53.436 | 20:14:54.162 | 20:14:54.619 | stop 早 457ms，页面清空缓冲，整条静音 |
| announce-1 | 20:15:04.633 | 20:15:06.838 | 20:15:05.739 | 播约 1.1s / 1.52s |
| announce-2 | 20:15:13.211 | 20:15:13.538 | 20:15:16.746 | stop 早 3.2s，整条静音 |
| announce-3 | 20:15:14.534 | 20:15:16.215 | 20:15:15.260 | 播约 0.95s / 1.84s |
| announce-4 | 20:15:37.943 | 20:15:38.798 | 20:15:38.607 | 播约 0.19s / 1.60s |

这是现场「我并没有听到任何语音输出」的直接原因：`narrator_stop` 在 `tts_done` 之前到达时，页面 `stopNarratorAudio()` 清空尚未播放的字节，随后 `tts_done` 找不到缓冲，按 `tts done without bytes` 路径丢弃。

### 触发源

五次 `narrator_stop` 的时刻上游都没有 `input_audio_buffer.speech_started`（本连接上游首次 speech_started 是 20:15:01.289）；连接是 continuous 模式，页面不会发 `segment_start`。唯一剩下的触发源是服务端本地语音门 `voice-realtime-local-speech.ts`：`reportLocalSpeechBoundary('started')` 调用 `noteUserSpokeForNarrator()`。

把该连接的 uplink capture（`~/.cloudcli/voice-realtime-capture/56278c8d-d0f0-444b-ad6e-8d7b2154275b.wav`）逐 20ms 帧回放进同一个 `createLocalSpeechGate()`，每个 `narrator_stop` 都能对应到一个 `started` 边界（capture 时基约差 0.8s）。触发时 RMS 为 300–470、持续约 0.5s；同一连接里人声 RMS 为 1000–10000。被当成「用户开口」的是环境噪声。

### 机制

`voice-realtime-local-speech.ts` 的注释自己写明这条门「is not a VAD and must not become one」「deliberately coarse」；它回答的是 watchdog 需要的「是否出现过话语边界」，不是「这段能量是不是言语」。把它接到 narrator 的打断上，等于用最粗的信号决定是否丢弃一条已经合成好的播报：噪声过线 → `interrupt('user-spoke')` → `narrator_stop` → 页面清空缓冲 → 整条静音。

### 方案

1. `voice-realtime-ws-proxy.service.ts` 的 `reportLocalSpeechBoundary('started')`：删除 `noteUserSpokeForNarrator()`，保留 `bridge.noteLocalUtteranceStart()`（watchdog 仍需要本地边界）。
2. narrator 的打断只保留两个精确边界：上游 `onUpstreamTurn(true)`（部署的 `server_vad` 总会发）与 segmented 路径的 `segment_start`（浏览器自己的分段边界）。
3. 新增 seam `narratorInterruptsOnLocalSpeech?: boolean`，默认 false；置 true 可回滚到当前行为，也作为判据的假形态开关。
4. 更新 `noteUserSpokeForNarrator` 与 `reportLocalSpeechBoundary` 的块注释，明确本地门只服务 watchdog。

<!-- dedup-ref -->相关但不同机制：`voice-output-narrator-interrupt`（已 done，双工打断本身的契约）只定义「用户开口即停」，没有规定「开口」由哪条信号读取；本任务改的是本地门的接线，不重写双工规则。

### 粒度

separate：`task-granularity-advice` 对 Touches 返回 `peers: []`；本任务与流式播放、固定句缓存是三个独立验收的机制。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-narrator-local-gate.test.ts
- server/modules/voice-realtime/tests/voice-realtime-narrator-interrupt.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-narrator-local-gate-no-interrupt.md

## AC

- [x] 新增判据 `voice-realtime-narrator-local-gate.test.ts` 的噪声腿：narrator 正在播报时，经 fake browser socket 送入 25 帧（20ms/帧、16kHz PCM16）RMS 300–470 的环境噪声，断言出站帧中没有 `narrator_stop`，且该 utterance 的 pacing 仍可完成。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-narrator-local-gate.test.ts` exit 0。
- [x] 同文件的真实言语腿：噪声之后送入上游 `input_audio_buffer.speech_started`，断言恰好一条 `narrator_stop`（`reason: 'user-spoke'`）且排在后面的 narration 被清除。同一命令 exit 0。
- [x] 假形态腿（独立 `test()` 块，名字含 `false-form`）：把 seam `narratorInterruptsOnLocalSpeech` 置 true，同一份噪声必须产生 `narrator_stop`，证明删除的那一行是承重的。`npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern false-form server/modules/voice-realtime/tests/voice-realtime-narrator-local-gate.test.ts` exit 0。
- [x] 既有双工判据仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-narrator-interrupt.test.ts` exit 0。
- [x] 新增 server 测试文件后重测并更新 `server/shared/tests/quay-test-script.test.ts` 的两处 known/unknown pin（按 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` 的实测值），并在注释里点名本任务文件；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` exit 0。
- [x] `npm run typecheck` 与 `npm run lint` 均 exit 0。

## DoD

把 `~/.cloudcli/voice-realtime-capture/56278c8d-d0f0-444b-ad6e-8d7b2154275b.wav` 冻结到仓库外目录，按 20ms 帧通过 fake browser socket 喂给真实的 `handleVoiceRealtimeConnection`（fake transport），在 Notes 贴一张修复前与修复后的对照表：修复前 5 次 `narrator_stop`（announce-0/2 在 `tts_done` 前、announce-1/3/4 被截断）；修复后同一份 capture 在无上游 `speech_started` 的窗口内 0 次 `narrator_stop`；capture 里真实的 speech_started 窗口仍各产生一次 `narrator_stop`。只跑合成噪声用例、没有这张真实 capture 回放表不算落地。

## Notes

### 落地内容

- `reportLocalSpeechBoundary('started')` 不再调用 `noteUserSpokeForNarrator()`；`bridge.noteLocalUtteranceStart()` 保留（watchdog 仍需要本地边界）。
- 新增 seam `narratorInterruptsOnLocalSpeech?: boolean`，默认 false；置 true 恢复旧接线，仅作判据的假形态开关。
- `noteUserSpokeForNarrator` / `reportLocalSpeechBoundary` / `onUpstreamTurn` 的块注释更新：本地门只服务 watchdog，narrator 只认上游 `speech_started` 与 `segment_start` 两条精确边界。

### 真实 capture 回放（DoD）

capture 冻结在仓库外：`/data/home/yale/work/quay-scratch/gap-narrator-local-gate-capture/frozen/56278c8d-d0f0-444b-ad6e-8d7b2154275b.wav`
（sha256 `d1a5ad97ce80c29989ee5b70daf0d6f6ceb97cc737abda903d127779c38680b6`，54220 ms / 867520 samples / 16 kHz mono PCM16 = 2711 帧 × 20 ms）。
回放探针：`/data/home/yale/work/quay-scratch/gap-narrator-local-gate-capture/replay.mts`（`.mts`；以 worktree 的 `server/tsconfig.json`、cwd=worktree 运行），按 20 ms 帧把 WAV 喂给真实的 `handleVoiceRealtimeConnection`（fake browser socket + fake transport）。
时间轴取自 journal 的 `narrator_speak` / `narrator tts done` 与 `timeline.jsonl` 的 `speech_started`；capture 音频比 timeline 滞后 900 ms（用五次 stop 与本地门边界对齐测得：7536→8440、20212→21120、26912→27800、29589→30480），故全部事件整体 +900 ms。
page 模型：该 utterance 的 `tts done` 起播，`durationMs` 后回 `narrator_done`（队列排队的条目从它真正被发出时起算，取 `max(到达, tts_done)`）。

Pass 1（journal-faithful：announce-0..4 按 journal 时刻入队，page 按上述模型 ack）：

| utterance | speak (file ms) | 修复前 `narrator_stop` | 修复后 | 结论 |
|---|---|---|---|---|
| announce-0 | 7720 | 8440（tts_done 8893 之前） | 无 | 整条静音 → 正常播完 |
| announce-1 | 18920 | 21120 | 无 | 播 1.1s/1.52s → 播完 |
| announce-2 | 27500 | 27800（tts_done 31020 之前） | 无 | 整条静音 → 播完 |
| announce-3 | 28820 | 30480 | 无 | 播 0.95s/1.84s → 播完 |
| announce-4 | 52220 | 52860（tts_done 52881 之前） | 无 | 播 0.19s/1.60s → 播完 |

修复前合计 **5 次** `narrator_stop`（8440 / 21120 / 27800 / 30480 / 52860），与 live journal 的 5 次一一对应（live 7536 / 20212 / 26912 / 29589 / 52172 + 900 ms 位移；前四条偏差 ≤ 9 ms，announce-4 回放到 52860，比按 +900 ms 换算的 53072 早 212 ms，对应 capture 中最近的 `started` 边界）。修复后同一份 capture 在无上游 `speech_started` 的窗口内 **0 次** `narrator_stop`。

Pass 2（continuous：narrator 始终有内容在播，每次 stop 后立即补一条）：修复后 5 次真实上游 `speech_started` 窗口各产生**恰好一次** `narrator_stop`（2100 / 15580 / 23680 / 26660 / 50260 ms）——修复没有把双工规则一起关掉。

### 判据执行记录

- `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-narrator-local-gate.test.ts` → 3 pass / 0 fail。
- `... --test-name-pattern false-form ...` → 1 pass（假形态腿单独绿）。
- `... voice-realtime-narrator-interrupt.test.ts` → 3 pass。
- `... server/shared/tests/quay-test-script.test.ts` → 14 pass（实测 376 个 server 测试文件，pin 375→376 / unknown 372→373、374→375）。
- `npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning）。
