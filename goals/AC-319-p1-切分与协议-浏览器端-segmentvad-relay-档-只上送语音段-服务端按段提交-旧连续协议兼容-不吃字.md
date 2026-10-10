---
id: AC-319
title: P1 切分与协议：浏览器端 SegmentVAD（relay 档）只上送语音段，服务端按段提交；旧连续协议兼容；不吃字、合并正确、重放幂等
status: active
kind: criterion
goal: GOAL-034
criterion: npx vitest run
  src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts
  src/modules/chat/voice-realtime && npx tsx --tsconfig server/tsconfig.json
  --test
  server/modules/voice-realtime/tests/voice-realtime-segmented-protocol.test.ts
  && npx playwright test e2e/voice-realtime-upload-fixture.spec.ts
  e2e/voice-realtime-live-session-send.spec.ts --workers=1
expect: >-
  三条命令均 exit 0。


  SPEC 验收 AC-1/2/3/9 的可自动部分：

  - **只发语音**：一段 200 秒、含 4 句话的录音经 `segment_*` 帧协议送往假上游，上游收到的音频 ≤ 25 秒；HTTP 诊断报告含
  `audioSecondsUpstream`、`segments`（序号、时长、合并原因）。

  - **不吃字**：`experiments/voice-trim/fixtures/` 的 8
  条语料，切分后拼回的转写（同一模型输出的录像）与不切分基线相比，字错率增量 ≤ 绝对 +1.0%。

  - **合并**：句内停顿 ≤ 1.2 s 合成一段；≥ 2.0 s 分成两段；`zh-d02`（含「嗯，不对」）段数按停顿长度可预测；End/Mute
  时已缓冲未提交的段先提交。

  - **幂等**：上游在段提交后断开，重放后会话里只出现该段一条消息。

  - **兼容**：旧的连续 `audio` 帧协议路径行为不变（既有 protocol-simulation 与两个 e2e spec 全绿）。

  - 取假形态各自必须变红：去掉合并 → 合并用例红；去掉 `seq` 去重 → 幂等用例红；去掉 End 冲刷 → 冲刷用例红。


  手动提交若 P0-S1 判为 `unsupported`，本 AC 的「提交方式」按 SPEC 回退方案（服务端 VAD +
  段间只送短静音）验收，不得绕过。
origin: 2026-10-10 人 yale 批准 SPEC；依据：F5（只有约 4–8% 的送出音频被当作语音）、F9（上游 VAD 把一句话切碎，13
  条消息 → 5 条）、既有 `gap-voice-streaming-vad-endpointing` 与
  `gap-voice-live-segmenter`（done，针对听写，最小段长 30 s，relay 档需要不同参数，复用同一实现而不是另写一份）。
activatedAt: 2026-10-10T01:35:44.827Z
statusLog:
  - at: 2026-10-10T01:35:44.827Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-10T01:35:44.827Z
---
