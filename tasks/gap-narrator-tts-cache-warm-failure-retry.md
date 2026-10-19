---
id: gap-narrator-tts-cache-warm-failure-retry
title: Live Voice TTS 缓存预热失败不可观测且不重试：一条短语 warm 失败后首次播报仍走 803ms 现合成，日志只有 miss
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

### 现象（2026-10-19 21:36:25–21:38:21 live 实测，journal `091be1b1-13fe-49d8-b201-bb3beffbe102.jsonl`）

连接建立后 4 条固定短语并发预热，但第一次使用 `明白，这就开始。` 时仍然是 miss：

- 13:36:53.086 `narrator speak announce-2` → `tts cache miss text=明白，这就开始。 chars=8`
- 13:36:53.889 `narrator tts done announce-2 frames=6 bytes=88364 durationMs=1840`（speak→done **803ms**，即现合成）
- 13:38:03.681 同一句再次播报 → `tts cache hit`（此时才在缓存里）

其余 3 条短语都是 hit（speak→done 1–2ms）。说明该短语的 warm 请求失败或未完成，但日志里没有任何 warm 失败行，操作者无法从 journal 区分「预热失败」「预热未完成」和「预热未触发」。

### 机制

`server/modules/voice-realtime/voice-realtime-tts-cache.ts`：

- `warm()` 对每条短语调用 `syntheses()`；
- `syntheses()` 把 leaf 抛出的错误映射成 `{ ok: false, code: 'TTS_UNREACHABLE', … }`，`store()` 对 `ok: false` 直接返回；
- `warm()` 从不拒绝，也**不记日志、不重试**；
- `speak()` 的 on-demand 回退是正确的，因此失败不会造成静音，只会在首次播报时多付一次合成（本轮 803ms；旧实测 0.66–3.53s）。

### 方案

1. **失败可观测**：`warm()` 每次失败写一行 `tts cache warm failed text=… attempt=1|2 code=… upstream=… chars=…`（沿用 `logText` 的空白折叠）。
2. **有界重试一次**：每条失败的短语在短暂延迟（建议 250ms）后重试一次；成功写 `tts cache warm recovered text=… attempt=2`；第二次仍失败则写 `tts cache warm failed … attempt=2` 并停止，不无限重试。
3. **不改变回退语义**：失败仍不写缓存；`warm()` 仍不阻塞连接、不抛异常；`speak()` 的 on-demand 路径不变；`tts cache hit`/`tts cache miss` 的词汇不变。
4. **并发去重保持**：`speak()` 与 warm/重试撞到同一 key 时，仍通过现有 `inFlight` map 共享一个请求，不额外发请求。

### 非目标

- 不重试 on-demand 合成的失败（只处理 warm）。
- 不改变短语表、缓存 key、帧契约或播放路径。

<!-- dedup-ref -->相关但不同机制：`gap-narrator-announce-phrase-cache`（已 done）建立缓存与预热本身；本任务只补预热的失败可观测性与一次重试，不改缓存命中/回退的语义。

### 粒度

separate：`task-granularity-advice` 对 Touches 返回 `peers: []`；本任务只改缓存实现与其既有判据，不新增测试文件。

## Touches

- server/modules/voice-realtime/voice-realtime-tts-cache.ts
- server/modules/voice-realtime/tests/voice-realtime-tts-cache.test.ts
- tasks/gap-narrator-tts-cache-warm-failure-retry.md

## AC

- [x] 瞬时失败腿（独立 `test()` 块，名字含 `transient`）：注入的 `fetch` 对某条短语第一次失败、第二次成功；`warm()` 完成后，日志汇中该短语恰有 1 行 `tts cache warm failed`（`attempt=1`）和 1 行 `tts cache warm recovered`（`attempt=2`），该短语的 `fetch` 调用数为 2；随后 `speak()` 该短语是 `tts cache hit` 且 `fetch` 调用数不再增加。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-tts-cache.test.ts` exit 0。
- [x] 永久失败腿（独立 `test()` 块，名字含 `permanent`）：`fetch` 对该短语始终失败；该短语恰有 2 次 `fetch`、2 行 `tts cache warm failed`（`attempt=1` 与 `attempt=2`），缓存中无该条目；随后 `speak()` 回退现合成（再 1 次 `fetch`）并仍产出 `tts_audio` + `tts_done`，不抛异常。同一命令 exit 0。
- [x] 成功腿保持：全部短语 warm 时每条恰 1 次 `fetch`，日志汇中 `tts cache warm failed` 行数为 0；既有的 warm 用例断言不变。同一命令 exit 0。
- [x] 既有 7 条缓存判据（hit / miss / dedupe / failure / eviction / warm / warm-failure fallback）全部保持绿。同一命令 exit 0。
- [x] `npm run typecheck` 与 `npm run lint` 均 exit 0。

## DoD

在仓库外写一个 `.mts` 探针（用 worktree 的 `server/tsconfig.json` 运行），直接驱动真实的 `createVoiceRealtimeTtsCache`：注入的 `fetch` 对某条短语第一次返回 500、第二次返回合法 WAV；在 Notes 贴出日志汇原文（`tts cache warm failed … attempt=1` 与 `tts cache warm recovered … attempt=2`）和该短语的请求计数（2），再贴一次 `speak()` 的 `tts cache hit` 行与请求计数（仍为 2）。只跑单测、没有这张真实缓存对象的日志与计数表不算落地。

## Notes

实现（worktree，commit `1985ee5c0`）：`voice-realtime-tts-cache.ts` 新增 `WARM_RETRY_DELAY_MS = 250`、`warmAttempt()`/`warmPhrase()`；每次失败写一行，失败后延迟 250ms 重试恰一次；第二次失败即止；等待期间若有并发 `speak()` 已存入则不再发请求并记 recovered。`speak()` 的 on-demand 路径与 hit/miss 词汇未变。

DoD 探针：`/data/home/yale/work/quay-scratch/gap-narrator-tts-cache-warm-dod/probe.mts`（仓库外，`npx tsx --tsconfig=server/tsconfig.json` 于 worktree 运行，直接驱动真实 `createVoiceRealtimeTtsCache`；注入 fetch 第一次 500、第二次合法 WAV）原文输出：

```
PROBE_AFTER_WARM_REQUESTS 2
PROBE_LOG tts cache warm failed text=明白，这就开始。 attempt=1 code=TTS_UPSTREAM_ERROR upstream=InternalError chars=8
PROBE_LOG tts cache warm recovered text=明白，这就开始。 attempt=2
PROBE_SPEAK_RESULT {"ok":true,"frames":3,"bytes":36044,"durationMs":750,"characters":8}
PROBE_AFTER_SPEAK_REQUESTS 2
PROBE_SPEAK_FRAME_TYPES ["tts_audio","tts_audio","tts_audio","tts_done"]
PROBE_LOG tts cache hit text=明白，这就开始。 chars=8
```

测试：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-tts-cache.test.ts` → 9/9 pass。`npm run typecheck` exit 0；`npm run lint` exit 0。既有的 warm-failure 用例把注入 fetch 从「首次失败」改为「前两次失败」（重试会吃掉第一次失败），其「预热失败 → 回退现合成」语义不变。
