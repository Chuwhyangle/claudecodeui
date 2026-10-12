---
id: gap-live-voice-scripted-upstream-protocol-state-machine
title: 本地 scripted fake 上游协议状态机：可配置 turn_detection 与 append/commit/response
  状态，产生空缓冲错误、speech_started、按 itemId 晚到/乱序/缺失/失败转写、断连与 response.cancel；回放加变体
  R（VAD 重启自然导致空缓冲）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-replay-event-synced-waits
goal_ac: AC-359
---
## Proposal

### 问题

现有假上游（`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` 的 `createScriptedUpstream`，e2e 侧 `e2e/voiceRealtimeScriptedUpstream.ts` 的 `startScriptedUpstream`）只回 `session.update` 与 tool output，其余全靠用例逐帧 `emit`/`script`。它**不理会** `turn_detection`，所以 2026-10-12 的根因链（状态注入的 session.update 重开 server_vad → 手动 commit 撞空缓冲 → speech_started → response.create 被吞）在回放里只能把结果帧硬编码，缺陷腿 (a) 只能检查线上帧本身，无法证明修复切断了下游后果。错误帧也缺真实上游的 `type` 字段。

### 要做的事

- 在共享假上游加**可选**协议状态机（不配置时行为与现有 API 逐字不变）：
  - 会话状态：`turn_detection`（随 session.update / 局部 turn_detection 更新）。
  - 输入缓冲：append 累积；commit 在 manual 下产生 `input_audio_buffer.committed` + `conversation.item.created`（item_id 单调）；在 server_vad 下可配置为「与 append 同刻的 commit 撞空缓冲」：`{type:'error', error:{type:'invalid_request_error', message:'Error committing input audio buffer: buffer too small, or have no audio.'}}`，随后 `speech_started` 并自建条目。
  - 转写策略（按 itemId）：准时 / 延迟到第 N 次 commit 之后 / 乱序 / 永不 / `transcription.failed`。
  - response 策略：应答（可附 function_call 或模型文本）/ 扣住 / VAD 进行中被吞；`response.cancel` ⇒ `response.cancelled`；`response.done` 可带 usage。
  - 故障：段中途断开（close / terminate），拒绝重拨。
- 状态机自测 `server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts`（真 ws 客户端）。
- 回放 spec 加变体 R：不脚本化错误帧，由状态机 + 服务端真实的状态注入自然产生空缓冲与 speech_started；断言帧序与 2026-10-12 journal 同形。vad-off 修复已落地时，R 应读到「不再撞空缓冲」——若届时已修，则 R 为正向腿；未修则经 `expectKnownDefect`。

### SCOPE BOUNDARY

- ⛔ 不改产品代码；状态机为可选配置，兄弟 spec 与 `voice-realtime-scripted-scenarios` 的 BUILDERS 钉子不变。
- 与 `gap-live-voice-intent-control-browser-e2e`（todo）共享假上游文件：本任务先落地，后者在其上追加（该任务是本任务的后继，不是前置）。
- 新增服务端测试文件需同步 quay-test-script 计数钉子与 suite 基线。

## Plan

1. 状态机与自测（先红）；2. e2e 包装暴露配置；3. 回放变体 R；4. 计数钉子/基线；typecheck/lint。

## AC

- [ ] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts` 退出 0；首组用例在「忽略 session.update 的 turn_detection」假形态下红。
- [ ] AC2：自测覆盖 manual commit、server_vad 空缓冲（错误帧带 type）、speech_started 自建条目、转写准时/延迟/乱序/永不/failed、response 应答/扣住/被吞、response.cancel、段中途断开。
- [ ] AC3：回放变体 R 由状态机自然产生与 journal 同形的帧序；`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0。
- [ ] AC4：回归——`e2e/voice-realtime-scripted-scenarios.spec.ts`、`e2e/voice-realtime-live-session-send.spec.ts` 单跑结果与改前一致；`voice-realtime-scripted-scenarios.test.ts`、`server/shared/tests/quay-test-script.test.ts` 退出 0；`npm run typecheck`、`npm run lint` 退出 0。

## DoD

变体 R 录制的帧序与 journal ef9daacd…（07:47:36–07:48:23Z）逐类对照表写入 Notes；零云调用。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts (new)
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-scripted-upstream-protocol-state-machine.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-359，建议 (5)）。`gap-live-voice-caption-segment-attribution-by-item-id` 已追加依赖本任务，以便用晚到/乱序/空转写策略做判据。
