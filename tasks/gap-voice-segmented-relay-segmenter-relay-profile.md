---
id: gap-voice-segmented-relay-segmenter-relay-profile
title: P1a 切分器 relay 档：在既有 voiceLiveSegmenter
  上加「按停顿合并、静默达阈值才提交、最长段在低能量点强切」的档位（纯函数，不接线）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-319
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：`gap-voice-streaming-vad-endpointing`、`gap-voice-live-segmenter`、`gap-voice-segment-pipeline`（均 done）已交付流式 VAD、切段器与并发/重试/拼回，但**面向听写上传**：`voiceLiveSegmenter.ts` 的最小段长是 30 s、过滤超过 1.0 s 的长静音。实时中继需要的是另一档参数（句子级、短停顿合并、2 s 静默提交），**机制相同、参数不同**，所以在同一个纯模块里加档位，不另写一份 VAD；本任务不碰 `voiceFrameProcessor.ts`（worklet 已转发 PCM 与 VAD 事件）。

来源：SPEC「C1 浏览器端切分」。本任务**只交付纯函数档位**，不改任何运行时接线（接线归 P1c，且需等 Composer 双入口分支合入）。

### 方案

`createLiveSegmenter(options)` 增加 `profile: 'dictation' | 'relay'`（缺省 `'dictation'`，行为逐字节不变）。`relay` 档的默认：

| 参数 | 值 | 含义 |
|---|---|---|
| `minSegmentSec` | 0.25 | 短于此视为噪声，不产出段 |
| `mergeGapSec` | 1.5 | 间隔短于此合并为一段；间隙里的静音**保留**（不压缩） |
| `commitGapSec` | 2.0 | 静默达到此值才封口提交 |
| `maxSegmentSec` | 20 | 到期仍无停顿则在窗口内最安静的帧强切（强切才保留 0.4 s 重叠，沿用既有规则） |
| `preRollSec` | 0.3 | 段首向前回溯 |

输出的段携带 `reason: 'gap' | 'max' | 'end'`、`mergedPauses`（合并了几次停顿）、`durationSec`、`startSec/endSec`。`flush()` 必须把已缓冲未提交的语音作为最后一段发出（End/Mute 路径）。

## AC

- [x] `npx vitest run src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts` 退出码 0，既有 `dictation` 档的全部用例**不修改**仍通过
- [x] relay 档：句内停顿 ≤ 1.2 s 的时间线（≥ 100 条，固定种子）恰好产出 1 段，该段保留的真值语音占比 ≥ 0.99；停顿 ≥ 2.0 s 的时间线产出 2 段，切点落在该静音内（中途切率为 0）
- [x] relay 档：累计连续语音 ≥ 25 s 且无停顿的输入，每段 ≤ `maxSegmentSec`，强切点的帧能量 ≤ 其前 2 s 窗口内帧能量中位数，相邻两段重叠 0.4 s ± 1 帧
- [x] 噪声：短于 0.25 s 的脉冲不产出段；全零与 −50 dBFS 纯底噪不产出任何段、不抛异常
- [x] `flush()`：缓冲中的语音恰好作为最后一段发出，`reason: 'end'`；已经提交过的不重复发出
- [x] 分块不变：同一 PCM 按 1、160、320、4800 个样本分块喂入，段的起止与字节哈希逐个相同
- [x] 真实语料回归：`experiments/voice-trim/fixtures/` 的 8 条 WAV 经 relay 档切分后，各段拼回的样本数与原始语音样本一致（不吃字），`zh-d02`（含「嗯，不对」）的段数记录在测试的期望表里
- [x] 取假形态各自必须变红：删掉合并规则 → 句内停顿用例红；改成固定时刻切 → 「切点落在静音内」红；删掉 `flush` 冲刷 → 冲刷用例红
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：relay 档在**真人语音时间线**上被度量过——复用 `gap-voice-vad-truth-harness` 的 LibriSpeech 构造（带精确真值），读数含中途切率、过切率、段数、强切数，写进测试的期望表；样本缺失时必须指名缺失路径并失败，不得静默跳过。不要求任何识别读数。dictation 档不被改变。

## Touches

- src/modules/chat/utils/voiceLiveSegmenter.ts
- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts
- tasks/gap-voice-segmented-relay-segmenter-relay-profile.md

## Notes

- 2026-10-10 执行者：AC1–AC8 已实现并逐条验证——`npx vitest run src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts` → 22 passed（含 13 条既有 dictation 用例，未修改）；`npm run lint` → exit 0（仅既有别处 warning）。
- 2026-10-10 上一轮：AC9 曾因 `npm run typecheck` 退出码 2 未满足。唯一红点是 `scripts/voice-realtime-diagnose.mjs` 的 5 处 TS7006（隐式 any），该文件既不在本任务 Touches，也由一个兄弟任务 `gap-voice-segmented-relay-protocol-server-commit` 持有；该红点是 **develop 全局既有**（由 `78ed6fab` 引入），与本分支无关，故当轮按「develop 树上的既有红点」置 `needs-human`。
- 2026-10-10 续做轮：AC9 已满足。上游红点由 `f3d6858e fix(scripts): annotate voice-realtime-diagnose so the scripts typecheck passes` 修复并合入 develop；本工作树 `git merge develop` 带入该修复后重跑：`npm run lint` → exit 0；`npm run typecheck` → exit 0（client + server + scripts 三个 tsc 项目全绿）；`npx vitest run src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts` → 22 passed。AC9 勾选。
## Needs-Human

**执行 2026-10-10T02:55:55.356Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-resident-addressable.test.ts:   AssertionError [ERR_ASSERTION]: the projection must publish whatever the process registered, including a handed-over name (claude-resident-addressable-pzrhon-63)
- run_id：wk-prod-anchor
- session_id：a8f7e07b-4ad2-4b12-b8b5-a4c36705052b
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-segmented-relay-segmenter-relay-profile~wk-prod-anchor~1791600463399-5be2d0.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-segmented-relay-segmenter-relay-profile-wk-prod-anchor.log
