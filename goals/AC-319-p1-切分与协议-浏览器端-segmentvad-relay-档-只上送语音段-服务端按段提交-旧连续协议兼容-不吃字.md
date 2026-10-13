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


  【2026-10-13 口径变更／拆分，照人 yale 2026-10-11 对 AC-331 的裁定同形处理】原 criterion 是一条三命令
  `&&` 串行链，实测绿灯 floor 131s（CMD1 34.4s + CMD2 10.9s + CMD3 85.8s，2026-10-13 clean task worktree
  @ develop `6ee4b5b5`，`scripts/with-memory-cap.sh` 包住），恒高于 goal driver 的 `CRITERION_TIMEOUT_MS
  = 120000`（`plugin/scripts/goal-driver.ts` 用它 spawn `quay goal gate`，到 120000ms 对 spawn 发 SIGKILL，
  记录上的 `timeoutMs` 管不到那一刀）；本记录原无 `timeoutMs`，闸用默认 `DEFAULT_ACCEPTANCE_TIMEOUT_MS
  = 60000` ⇒ `floor < timeoutMs < 120000` 的可行区间为空，单条记录无论怎么写都结构性写不出 `pass`
  （账本指纹 `.quay/goal-round.jsonl` rounds 75/76：`not-evaluated (timeout): acceptance timed out after
  60000ms`）。故按闸把链切成两段、并集与原链**逐条相同**：本记录保留 CMD1（`voiceLiveSegmenter.test.ts`
  + 目录 glob `src/modules/chat/voice-realtime`）与 CMD2（`voice-realtime-segmented-protocol.test.ts`），
  并声明 `timeoutMs: 118000`（> 本段实测串行 45.3s，余量 61% = 1 − 45.3/118.0，即声明值是
  实测 floor 的 2.6 倍；取 118000 是区间 `floor < timeoutMs < 120000` 内的最大安全值）；
  CMD3（`e2e/voice-realtime-upload-fixture.spec.ts`
  + `e2e/voice-realtime-live-session-send.spec.ts --workers=1`，实测 85.8s）拆到新记录 **AC-376**（同
  `goal: GOAL-034`），其 `timeoutMs: 115000`。上面「三条命令均 exit 0」现应读作 AC-319 ∪ AC-376 的并集。
  ⛔ 未删／未弱化／未合并成更短命令。
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
timeoutMs: 118000
---
