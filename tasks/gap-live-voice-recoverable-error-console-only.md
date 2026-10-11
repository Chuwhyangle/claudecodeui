---
id: gap-live-voice-recoverable-error-console-only
title: Live Voice 可恢复错误（recoverable:true）只写 browser console（console.warn 带
  code+message），不在页面渲染；非可恢复错误保持可见
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

### 现象（2026-10-11 操作者实测）

同一条 voice journal（`/data/home/yale/.cloudcli/voice-realtime-log/57279cc1-f597-428f-8f39-7e1d53804510.jsonl`）里有两条**可恢复**错误：
- 15:38:00.360Z `to-browser error TRANSCRIPTION_FAILED (recoverable): A spoken segment could not be transcribed: grpc error: statusCode=500, message=Receive batching backend response failed!`（第 13 行）
- 15:41:27.746Z `to-browser error MALFORMED_FUNCTION_CALL (recoverable): … arguments are not JSON: SyntaxError: Unterminated string in JSON …`（第 311 行）

两次都自行恢复、没有丢内容，但页面把错误文字红字显示给了操作者，打扰且无可操作性。

### 现状（2026-10-11 逐文件复核，带 file:line）

- 服务端：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:548-564` 的 `RECOVERABLE_ERROR_CODES`（TOOL_ARGUMENT_SCHEMA_VIOLATION / UNDECLARED_TOOL / UNKNOWN_TOOL / MALFORMED_FUNCTION_CALL / TOOL_EXECUTION_FAILED / TRANSCRIPTION_FAILED / MODEL_TEXT_REPLY / TOOL_LOOP_GUARD / UPSTREAM_ERROR），`:566-567` `errorFrame` 据此打 `recoverable: true`；`:1361` 对 `CONNECTION_LOST` 按 `willRetry` 定；`:911-916` 会话忙时发 `SESSION_BUSY`（recoverable）。错误文案由 `describeBridgeError`（`:512-544`）生成；bridge 侧故障源见 `server/modules/voice-realtime/voice-realtime-bridge.service.ts:199`、`:727`、`:760-798`。**服务端不需要改**：它已正确标注 recoverable，且 journal 里已有完整记录。
- 客户端：`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:944` 对**所有** `error` 帧无条件 `setError(frame.message)`，`:947-949` 仅在非 recoverable 时 `setPhase('failed')`；`src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx:301` 只要 `error` 非空就渲染 `data-testid="voice-realtime-error"` 的红字，并**顶掉**最后一条 caption。
- 既有断言钉着旧行为（须随裁定改写，照实记录）：
  - `src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx:270-277`「a recoverable error is shown but the session keeps listening and capturing」断言 `result.current.error === 'Claude is still working'`；`:315-322` 也先灌一个 recoverable `SESSION_BUSY` 再断言 `sent` 清空 error。
  - `e2e/voice-realtime-live-session-send.spec.ts:715-735`「a malformed model call is reported on the bar…」在 `:725` 断言 `voice-realtime-error` 含 `/schema/i`。该 spec 是 AC-323 的判据文件之一（AC-331 的「一字不改」守卫只限定于 `ec621a2b` / `8be9df6b` 两个实现提交自身的 diff，不覆盖本任务）；本任务对它的改动仅限这一个用例的「错误是否上屏」断言，`phase` 仍为 `listening`、麦克风与连接保持存活的断言保留。

### 人的裁定（2026-10-11，操作者）

- `recoverable: true` 的错误**只报到浏览器 console**（`console.warn`，带 code 与 message），**不在页面 UI 渲染**。
- 非 recoverable 错误**保持可见**（照旧 `setError` + `phase = 'failed'` + 栏上红字）。

### 实施要点

1. `useVoiceRealtimeSession.ts:944-949`：`frame.recoverable === true` ⇒ `console.warn('[voice-realtime] recoverable error', frame.code, frame.message)`（形式由实施者定，但必须带 code 与 message），**不** `setError`、不改 phase；否则维持现状。`voiceLog` 若已有同类调试日志可并存。
2. 不改 `VoiceRealtimeBar.tsx:301` 的渲染条件即可达成（error 不再被 recoverable 帧置值）；只有当实现选择在 bar 层过滤时才动 bar。
3. ⚠️ 覆盖面说明：`SESSION_BUSY`（「Claude is still working…will be sent as soon as it finishes」）也是 recoverable，按裁定一并转 console。忙态在栏上另有独立读数（`VoiceRealtimeBar.tsx:229-234` 的 busy 标签、`data-queued-depth` / `data-queued-bytes`），不依赖 error 槽，所以用户仍能看到「正在忙、有多少在排队」。
4. `CONNECTION_LOST` 在 `willRetry === true` 时是 recoverable，同样转 console；重试耗尽后的那一帧非 recoverable，仍上屏。

### 关联 / 粒度

<!-- dedup-ref --> 与 `gap-live-voice-status-aggregate-and-inject`（ready，服务端向上游注入忙态以减少 `MODEL_TEXT_REPLY`）机制不同：那是减少可恢复错误的**发生**，本任务只改它们在浏览器里的**呈现**；Touches 无交集。`task-granularity-advice` 无 open 同文件 peer：none found。kept separate：操作者要求三条独立立案。

## AC

- [x] AC1 可恢复错误不上屏（**取假形态，排在判据文件该组最前**）：`src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 新增/改写用例——收到 `{ type:'error', code:'MALFORMED_FUNCTION_CALL', message:'bad args', recoverable:true }` 后：`result.current.error` 为 `null`、`phase` 仍为 `listening`、渲染出的栏里**不存在** `[data-testid="voice-realtime-error"]`，且 `console.warn` 被调用恰一次、参数中包含 `'MALFORMED_FUNCTION_CALL'` 与 `'bad args'`（`vi.spyOn(console,'warn')`）。在未修复的树上该用例必红（实施者记一次红读数）。判据 `npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出 0。
- [x] AC2 非可恢复错误仍可见（负控）：同一文件中，收到无 `recoverable` 的 `error` 帧后 `phase === 'failed'`、`result.current.error` 等于该 message，且渲染出的栏里 `[data-testid="voice-realtime-error"]` 存在并含该 message。判据同 AC1 命令退出 0。
- [x] AC3 旧断言按裁定改写而非删除：`useVoiceRealtimeSession.test.tsx:270-277` 改为断言 recoverable 帧 `error === null` 且仍 listening / 仍采集音频；`:315-322` 的「`sent` 清空 notice」用例改用一个仍会置 error 的前置状态（或改为断言 recoverable 帧本就不置 error），不得整条删除。判据同 AC1 命令退出 0。
- [x] AC4 e2e（**自证；fan-in suite 不跑 Playwright**）：`e2e/voice-realtime-live-session-send.spec.ts` 的 malformed-call 用例改为断言 `voice-realtime-error` 计数为 0、浏览器 console 收到一条含 `MALFORMED_FUNCTION_CALL` 的 warning（`page.on('console')`），其余「仍 listening、mute 可用、继续说话上游收到音频」断言保留；`VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-live-session-send.spec.ts` 退出 0。
- [x] AC5 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：真实浏览器里的真实 Live Voice 会话，遇到一次可恢复错误（真实上游自然出现的，或用 scripted fake upstream 的 `emitMalformedCall()` / `transcriptionFailed` 触发）——栏上**不出现**红字错误、最后一条 caption 照常显示、会话继续 listening；同时浏览器 DevTools console 里有一条带 code 与 message 的 warning。再触发一次非 recoverable 错误（如上游断开且不再重试），栏上**仍显示**错误、phase 进入 failed。证据落在本任务 `## 验证记录`：两种情形的截图、console 读数、以及对应 voice journal 里 `to-browser error … (recoverable)` 行的时刻。仅有单元测试不算 done。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx (only if the filter is placed in the bar instead of the hook)
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- e2e/voice-realtime-live-session-send.spec.ts (only the malformed-call case near :715-735)
- tasks/gap-live-voice-recoverable-error-console-only.md (self)

## 验证记录

工作树：`/data/home/yale/work/claudecodeui-worktrees/gap-live-voice-recoverable-error-console-only`（分支 `task/gap-live-voice-recoverable-error-console-only`）。实现提交：`6518f8b2 fix(voice-realtime): recoverable errors go to the console, not the bar`。

### 改动

- `useVoiceRealtimeSession.ts`：`error` 帧处理拆成两支——`frame.recoverable === true` ⇒ `console.warn('[voice-realtime] recoverable error', frame.code, frame.message)` 后 `return`（不 `setError`、不改 phase）；否则维持原状 `setError(frame.message)` + `setPhase('failed')`。另给导出的 `VoiceRealtimeSession.error` 字段补了文档注释，说明只有非可恢复失败会到达它。
- `tests/useVoiceRealtimeSession.test.tsx`：新增 AC1/AC2 用例；原 `:270-277`、`:315-322` 两条旧断言按裁定改写为 recoverable 语义（未删除，第二条改用非可恢复前置状态来继续覆盖「`sent` 清空 notice」）。
- `e2e/voice-realtime-live-session-send.spec.ts`：malformed-call 用例改断 error 计数为 0 + console warning 含 `MALFORMED_FUNCTION_CALL`，保留 listening / mute 可用 / 继续说话上游收帧的断言。
- `VoiceRealtimeBar.tsx`：**未改**。`error` 槽只在非空时渲染（`:302`），recoverable 帧不再置值即达成 AC1；在 bar 层过滤是 plan 备选（Touches 括注），未采用。

### AC 逐条判据

- **AC1 / AC2 / AC3**：`npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` ⇒ 退出 0，**38 passed**。
  - 红读数（取假形态的自证）：`git stash` 掉 hook 改动、同命令重跑 ⇒ `× a recoverable error goes to the console, not the bar, and the session stays listening → expected 'bad args' to be null`，以及 `× a recoverable error leaves the reading clear, and the session keeps listening and capturing → expected 'Claude is still working' to be null`；非可恢复负控 AC2 该轮**保持绿**（真假形态，非恒红）。恢复改动后复跑 38 passed。
- **AC4**：`VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-live-session-send.spec.ts` ⇒ 退出 0（4 passed）。
- **AC5**：`npm run typecheck` 退出 0；`npm run lint` 退出 0（改动三文件单独 `npx oxlint` 亦 0 告警）。

### DoD（真实浏览器 + 真实 server/proxy；Realtime 上游为 spec 自带的 scripted fake，即 DoD 允许的 `emitMalformedCall()` 触发）

- 可恢复错误（`emitMalformedCall()`，对应 journal 15:41:27.746Z `to-browser error MALFORMED_FUNCTION_CALL (recoverable)`）：
  - 页面读数：`voice-realtime-error` 计数 **0**；`voice-realtime-phase` 仍 `listening`；`voice-realtime-mute` 可用；继续说话上游 `audioFrameCount` 增长；末条 caption 照常显示。截图 `live-recoverable-error-1280.png`（栏上「Listening…」+ 波形，无红字）。
  - 浏览器 console 读数（`page.on('console')`，type `warning`，一条）：
    `[voice-realtime] recoverable error MALFORMED_FUNCTION_CALL A function call from the upstream was malformed: arguments are not JSON: SyntaxError: Unterminated string in JSON at position 25 (line 1 column 26).`
- 非可恢复错误（**一次性未提交探针**，verification-only，跑毕 `git checkout --` 已 revert，工作树 CLEAN）：让 fake upstream 发一个本 build 不认识的 event 类型 ⇒ `UNKNOWN_EVENT`，不在 `RECOVERABLE_ERROR_CODES` 内 ⇒ 栏上**显示**红字 `The upstream sent an event this build does not handle: dod.temporary.unknown.event.`，状态行 `Voice control stopped`、出现重试按钮（phase `failed`）。截图 `live-fatal-error-1280.png`。该探针不作为提交内容（Touches 只允许 malformed-call 用例）。
- 证据文件：`/data/home/yale/voice-rec-evidence/gap-live-voice-recoverable-error-console-only/`（两张截图 + 两次 playwright 运行日志 + README）。

### 照实记录：AC4 字面 code 的一处澄清

AC4 要求 warning 含 `MALFORMED_FUNCTION_CALL`。fixture 原实现发 `{ message: 42 }`——那是**合法 JSON、只是类型不合 schema**，服务端产出的 code 是 `TOOL_ARGUMENT_SCHEMA_VIOLATION`（同样 recoverable，但不是 AC4 点名的字面）。为满足 AC4 的字面，`emitMalformedCall()` 改为发**非 JSON** 参数（`{"message": "unterminated`），这正是原始事故那一帧的形态（`… arguments are not JSON: … Unterminated string in JSON`）。此改动在 Touches 声明的同一文件内，但位于其括注「only the malformed-call case near :715-735」给出的行区间**之外**（fixture 定义处），故在此披露。schema-violation 那条 code 的路径仍由服务端自带测试覆盖，未被本任务削弱。
