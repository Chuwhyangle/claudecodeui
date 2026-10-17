---
id: gap-live-voice-response-create-unanswered-commit
title: live-voice forced commit 后 committed 无 speech_stopped 时补发一次
  response.create 恢复丢句
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

2026-10-17 live voice 实测：uplink VAD 扣静音后 2s forced commit（`closeUplinkVadHeldTurn` 只发 commit 不发 response），端点回 `committed`+`transcription` 却无 `speech_stopped`，于是无 response，句子挂到下一句（实测延迟 22.5s / 49.6s，见 `experiments/livevoice-discussion-transcripts-20261017/DROPPED-INPUT-AUDIT-2026-10-17.md`）。

根因（`experiments/voice-realtime-feed-through-probe/RESULTS.md` 已证）：端点 server_vad 只在同一未提交缓冲里检测「语音→静音」才 fire；commit 冻结缓冲，之后补的音频进新缓冲（纯静音无转折）永不 fire。commit 后补真静音 0–6000ms 共 8 run 全不触发，故「补音频」证伪。

方案（状态驱动、无计时器）：`onUserAudioCommitted` 时若 `upstreamTalking === true`（这次 committed 之前无 speech_stopped，即端点不会自答）且非 segmented，补发一次 `response.create`。实验已验证判据在快速闭段（stop 先于 committed）、慢速闭段（stop 早 committed 1ms）、不闭段（无 stop）三情形都不误报，补发的 response.create 恰好产出一个干净 response 且模型 session_send 整句。

<!-- dedup-ref -->
机制不同、非重复：`gap-live-voice-span-guard-flag`（done，文本侧逐字补录）与 `gap-live-voice-one-text-per-segment-prefer-response`（done，删守卫裁定）走文本侧；本任务是协议侧 `response.create` 恢复。`gap-live-voice-function-call-output-rejected-after-speech-resume`（done）是 function_call_output 拒收，另一现象。

## AC

- [ ] AC1 不闭段发一次：脚本化上游 fixture「forced commit → committed 且无 speech_stopped」断言恰好发出一次 `response.create`（计数 == 1），随后产出 `session_send` 且携带该句文本；`grep -c "response.create" server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts` ≥ 1。
- [ ] AC2 快速闭段不发：fixture「speech_stopped 先于 committed」断言 `response.create` 计数 == 0。
- [ ] AC3 慢速闭段不发：fixture「speech_stopped 与 committed 同批（stop 先 1ms）」断言 `response.create` 计数 == 0。
- [ ] AC4 segmented 不发：判据只在 `!segmentedRelay` 生效，segmented 连接下同场景 `response.create` 计数 == 0。
- [ ] AC5 判别性（false form）：把判据短路（如 `if (false && upstreamTalking)`）后 AC1 的「发一次」断言**红**；假形态还原、`git status --porcelain` 干净。
- [ ] AC6 编译+单测退出 0：`npm run typecheck` 退出 0；`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts` 退出 0。

## DoD

`voice-realtime-ws-proxy.service.ts` 的 `onUserAudioCommitted` 里，`upstreamTalking === true` 且非 segmented 时补发一次 `response.create`；脚本化上游场景「forced commit 后 committed 无 speech_stopped」跑通并断言恰好一次 response.create、模型随后 `session_send` 携带该句。快速/慢速闭段与 segmented 场景断言不发。不引入计时器，不新增测试文件（并入 `voice-realtime-uplink-vad-seam.test.ts`）。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
- tasks/gap-live-voice-response-create-unanswered-commit.md