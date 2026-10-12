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

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-manual-vad-session-update.test.ts` 退出 0；首组用例在「恢复 {...sessionDefaults} 整份展开」的假形态下断言 segments 开始后的 session.update 带 server_vad（证明会红）。
- [x] AC2：真 bridge + scripted fake 上游：segments 开始后由状态注入触发的每条完整 session.update 的 `session.turn_detection === null`；重连后仍先发 VAD-off。
- [x] AC3：`VOICE_REALTIME_MODE=continuous` 下 session.update 仍携带解析出的 server_vad 配置（行为不变）。
- [x] AC4：journal session.update 行含 turn_detection 取值。
- [x] AC5：回放 `e2e/voice-realtime-segmented-replay-20261012.spec.ts` 的缺陷腿 (a) 去掉 `test.fail()` 后通过，整份单文件运行退出 0。
- [x] AC6：回归——`voice-realtime-bridge.test.ts`、`voice-realtime-segmented-protocol.test.ts`、`voice-realtime-streaming-stages.test.ts`、`server/shared/tests/quay-test-script.test.ts` 退出 0；`npm run typecheck`、`npm run lint` 退出 0。

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

### 实现取法（择一，依据写在各处注释里）

选「由 transport 按连接模式组装」，不是「bridge 每次 sendSessionUpdate 后补发」：AC2 的判据断言的是**那条完整 session.update 自己**就带 `turn_detection: null`，补发只能让「最终状态对」，判据读的那一帧仍带 server_vad。transport 记住本逻辑会话收到过的开关值（`switchedTurnDetection`，`session.turn_detection` 是唯一写入点），并在每条完整 `session.update` 组装时用 `{...sessionDefaults, ...(switch), instructions}` 压过 `sessionDefaults.turn_detection`。该状态**故意不随 socket 关闭清零**：重连时 `readvertiseSession()` 走的是同一条组装路径、且发生在 bridge 补发 `session.turn_detection` 之前，清零就会让「重建会话的那一帧」正好带 server_vad。`server/index.ts` 无需改动（装配不必传模式）。

### DoD 读数（真 proxy + scripted fake 上游，`apiKey: ''`，零云调用）

复现「seq0 送达 → 状态注入 → 下一段提交」：`handleVoiceRealtimeConnection` + `createDashscopeTransport` + `createScriptedUpstream`，`sessionDefaults` 用**解析值** `{type:'server_vad',threshold:0.7,silence_duration_ms:900}`（非出厂默认 0.5/400，好让「解析值」与「出厂字面量」可区分）。下面是假上游实收的 `session.update` 原文（只列 tools 与 turn_detection 字段）：

修复后（shipping transport）：

- `#1 tools=3 turn_detection={"type":"server_vad","threshold":0.7,"silence_duration_ms":900}` ← 开关之前的诚实 session
- `#2 tools=0 turn_detection=null` ← 分段路径自己的开关（唯一入口）
- `#3 tools=3 turn_detection=null` ← **第一次状态注入**（重述整份 body），仍为 null

修复前（删掉 `...(switchedTurnDetection === undefined ? {} : { turn_detection: switchedTurnDetection })` 这一行）：

- `#1 tools=3 turn_detection={"type":"server_vad","threshold":0.7,"silence_duration_ms":900}`
- `#2 tools=0 turn_detection=null`
- `#3 tools=3 turn_detection={"type":"server_vad","threshold":0.7,"silence_duration_ms":900}` ← **状态注入把上游 VAD 重新打开** = journal `ef9daacd` 的缺陷，逐字复现

### 实测（本条在 worktree 内逐条跑）

- `server/modules/voice-realtime/tests/voice-realtime-manual-vad-session-update.test.ts`：6/6 pass，`duration_ms 2042`（AC1 假形态为文件首组用例）。
- 回放 spec 单文件：`14 passed (1.3m)`，`EXIT=0`——腿 (a) 已非 `test.fail`；兄弟任务的 8 条 `test.fail` 腿仍按预期红（Playwright 计为 passed）。
- AC6 回归：bridge 9/9、segmented-protocol 21/21、streaming-stages 20/20、quay-test-script 11/11（含 AC7 覆盖率 280/308）。
- 另跑的相关文件：diagnose 12/12、dashscope-transport.false-forms 7/7、connection-resilience 5/5、turn-detection+segmented-default+bridge.false-forms+live-executor.false-forms+status-injection+replay 共 36/36。
- `npm run typecheck`、`npm run lint` 退出 0。

### 计数钉子（新增测试文件带来的 +1）

`server/shared/tests/quay-test-script.test.ts` 有两处硬计数：`known=3 unknown=305→306`、`known=1 unknown=307→308`；`scripts/suite-duration-baseline.tsv` 头部覆盖数 `279/307→280/308`，并新增数据行 `2042 server/modules/voice-realtime/tests/voice-realtime-manual-vad-session-update.test.ts`。**本任务收尾要 merge develop，若 develop 同时新增了 server 测试文件，这两个计数还要再加 1**。

### 未宣称

上线需人工 build/restart；真实复测（五句话同形、手动提交后不再出现 `speech_started`、两句话都被送达）由人确认，不在本任务内宣称。`voice-realtime-ws-proxy.service.ts` 未改。
