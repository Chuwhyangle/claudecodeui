---
id: gap-live-voice-manual-mode-session-update-keeps-vad-off
title: 分段手动模式下完整 session.update（状态注入）不得重开上游 server_vad：每次都带
  turn_detection:null，journal 记录取值
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-segmented-replay-20261012
goal_ac: AC-353
---
## Proposal

### 问题（代码已核对，2026-10-12）

- `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:409-417`：`DEFAULT_SESSION_DEFAULTS.turn_detection = DEFAULT_TURN_DETECTION`（server_vad）；`server/index.ts` 装配时传入解析后的 `turn_detection`。
- 同文件 `:483-492` `toDashscopeFrames` 的 `session.update` 分支以 `{...sessionDefaults, instructions, tools}` 组装 ⇒ 每条完整 session.update 都带 `turn_detection: server_vad`。
- `voice-realtime-bridge.service.ts:600-608` `ensureManualVadOff` 每个 socket 只发一次 `session.turn_detection: null`（`vadDisabledOnSocket`），之后的 `sendSessionUpdate`（状态注入 `voice-realtime-ws-proxy.service.ts` `advertiseInstructions`）不再关。
- 后果（journal ef9daacd…）：seq0 送达后 07:47:39 第一次状态注入（`session.update voice=Tina tools=3`）把上游 VAD 重新打开；此后每次手动提交后 ~100ms 都有 `speech_started`、从无 `speech_stopped`；seq1/seq6 提交报 `buffer too small, or have no audio`；seq2~seq4 的 `response.create` 无 `response.created`。`voice-realtime-diagnose.service.ts:213` 的 journal 行只记 voice 与工具数，看不到 turn_detection。

### 要做的事

- 手动分段模式（segments 已开始）下，完整 session.update 必须携带 `turn_detection: null`——由 transport 按连接模式组装，或 bridge 在每次 `sendSessionUpdate` 后补发 VAD-off；择一并在注释写明依据。连续模式行为不变。
- journal 的 session.update 行增加 turn_detection 取值。
- 回放 spec 中缺陷腿 (a) 去掉 `test.fail()` 转绿。

### SCOPE BOUNDARY

- ⛔ 不实现转写自动补发 Claude（人 yale 2026-10-12 裁定）；不改提示词。
- ⛔ 不改 `voice-realtime-ws-proxy.service.ts`（GOAL-041 A+ 任务在改）；不重启 :3001。

## Plan

1. 写判据测试（先红）；2. 修 transport/bridge；3. journal 字段；4. 回放腿翻绿；5. quay-test-script 计数钉子与 suite 基线；typecheck/lint。

## AC

- [ ] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-manual-vad-session-update.test.ts` 退出 0；首组用例在「恢复 {...sessionDefaults} 整份展开」的假形态下断言 segments 开始后的 session.update 带 server_vad（证明会红）。
- [ ] AC2：真 bridge + scripted fake 上游：segments 开始后由状态注入触发的每条完整 session.update 的 `session.turn_detection === null`；重连后仍先发 VAD-off。
- [ ] AC3：`VOICE_REALTIME_MODE=continuous` 下 session.update 仍携带解析出的 server_vad 配置（行为不变）。
- [ ] AC4：journal session.update 行含 turn_detection 取值。
- [ ] AC5：回放 `e2e/voice-realtime-segmented-replay-20261012.spec.ts` 的缺陷腿 (a) 去掉 `test.fail()` 后通过，整份单文件运行退出 0。
- [ ] AC6：回归——`voice-realtime-bridge.test.ts`、`voice-realtime-segmented-protocol.test.ts`、`voice-realtime-streaming-stages.test.ts`、`server/shared/tests/quay-test-script.test.ts` 退出 0；`npm run typecheck`、`npm run lint` 退出 0。

## DoD

真 bridge + scripted fake 上游下复现「seq0 送达 → 状态注入 → 下一段提交」，修复前后各读一次假上游收到的 session.update 原文（turn_detection 字段）写入 Notes；零云调用。上线需人工 build/restart，真实复测（五句话同形）不出现手动提交后的 speech_started 由人确认，不在本任务内宣称。

## Touches

- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-diagnose.service.ts（journal 行字段）
- server/index.ts（仅当装配需传模式）
- server/modules/voice-realtime/tests/voice-realtime-manual-vad-session-update.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts（仅当既有断言受影响）
- e2e/voice-realtime-segmented-replay-20261012.spec.ts（翻转缺陷腿 a）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-manual-mode-session-update-keeps-vad-off.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-353）。依赖回放任务（红先行，缺陷腿 a 由本任务翻绿）。Touches 与 GOAL-041 在途任务不相交（它们改 ws-proxy，本任务改 transport/bridge）。
