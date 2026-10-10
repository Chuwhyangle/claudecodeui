---
id: gap-voice-realtime-e2e-specs-red-under-default-segmented-mode
title: 默认 segmented 后 e2e/voice-realtime-live-session-send 红：假麦克风的平直 0.3
  方波被切分器当静音、上游收不到帧；规格须在默认与 continuous 回退两种模式下都绿，并真正覆盖默认路径
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

**现象与证据（2026-10-11，develop 5ae71f4f 起，本机复现）**：`quay goal gate AC-319` 红（exit 1，不再是超时）。AC-319 判据的第三条命令 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-live-session-send.spec.ts --workers=1` 在 `voice-realtime-live-session-send.spec.ts:455` 的用例失败：解除静音后 `expect.poll(() => upstream.audioFrameCount()).toBeGreaterThan(framesBeforeMute)` 超过 20 s，读数 0；`3 did not run`，7 条里 3 passed 1 failed。判据的前两条命令独立运行均绿（vitest 6 文件 90 例；`voice-realtime-segmented-protocol.test.ts` 21 例）。同一命令加 `VOICE_REALTIME_MODE=continuous` 重跑 **7 passed (42.5s)**。

**机制（非症状）**：P4（`15a30dcf`）让真实服务端对 `hello` 默认回 `ready{protocol:'segmented-v1'}`，浏览器因此默认走分段上行，只在段内发 `audio{seq}`。该 spec 的假麦克风（`speak()`）每次 `samples.fill(0.3)` 发一个**平直常数样本块**，而浏览器的 `StreamingVad` 对平直信号判静音（见 memory `streaming-vad-flat-tone-is-silence`）——于是整个突发被当成静音，不开段、不上行，上游一帧也收不到。产品行为按设计正确（静音不上行）；坏的是这条 e2e 的夹具，以及「默认路径从未被真实页面端到端覆盖」：P4 的默认用例只在协议模块与假上游层验证，fan-in 套件又不跑 e2e，所以直到 goal gate 才暴露。

<!-- dedup-ref -->相关但机制不同：`gap-voice-realtime-live-session-send-wiring`（已落地，建立了这条 spec）、P4 `gap-voice-segmented-relay-rollout-and-reconcile`（done，改默认）。本任务不改产品代码，只让 e2e 规格在默认与回退两种模式下都真实通过。

**提案**：①`voice-realtime-live-session-send.spec.ts` 的假麦克风改为发**类语音的非平直信号**（有包络变化的正弦或带能量起伏的噪声，足以让切分器开段），并在突发之后补足静音样本或在解除静音/结束时依赖「结束冲刷」使段被提交；②用例断言默认路径确实走了分段协议：上游收到至少一次 `input_audio_buffer.commit`，且上行音频总时长不超过喂入时长；③保留对 `continuous` 回退的覆盖：同一对 spec 在 `VOICE_REALTIME_MODE=continuous` 下也要全绿（只经环境变量，无需改产品代码）。

## AC

- [ ] 默认配置（不设 `VOICE_REALTIME_MODE`）：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-live-session-send.spec.ts --workers=1` 退出码 0，且无 `did not run`
- [ ] 回退配置：`VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-live-session-send.spec.ts --workers=1` 退出码 0
- [ ] 默认路径断言非空转：live-session-send 用例读到假上游收到 `input_audio_buffer.commit` 次数 ≥ 1 且 `audioFrameCount() > 0`；回退配置下同一用例读到 commit 次数为 0（证明两种路径各走各的，而不是都没发）
- [ ] 取假形态必须变红：把假麦克风改回 `samples.fill(0.3)` 平直块 ⇒ 默认配置下该用例红；服务端改回不回 `ready`（默认不声明）⇒ 「commit 次数 ≥ 1」断言红
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0
- [ ] `quay goal gate AC-319` 在合并后的树上退出码 0（该行在合入 develop 之后才能读到（待外部））

## DoD

真实落地标准：在合并后的 develop 树上，用真实 Chromium 驱动真实服务（上游为 spec 自带的假 Realtime 上游，不调用真实 DashScope、不产生费用），分别在默认与 `continuous` 两种配置下跑完上述两个 spec，贴出两次运行的 pass/fail 计数与耗时原始输出；并贴出默认配置下假上游观察到的 commit 次数与上行帧数读数。未验证项如实写明（例如 goal gate 的合入后读数）。

## Touches

- e2e/voice-realtime-live-session-send.spec.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-voice-realtime-e2e-specs-red-under-default-segmented-mode.md