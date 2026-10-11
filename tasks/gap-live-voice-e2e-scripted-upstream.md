---
id: gap-live-voice-e2e-scripted-upstream
title: Playwright Live Voice E2E：真实浏览器 + 共享 scripted fake
  upstream（复用服务端同一份事件词表）覆盖 queue/full、interrupt、stop-vs-exit、caption、session
  switching；默认严禁云 API（凭据置空 + 拨号与出网双读数）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-voice-terminated-interrupt
  - gap-live-voice-stop-vs-exit-affordances
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line）

**浏览器层的假上游是四份内联实现，没有共享模块。** 每个 spec 自己 `createServer()` + `WebSocketServer`：`e2e/voice-realtime-live-session-send.spec.ts:156-266`、`voice-realtime-upload-fixture.spec.ts:492-660`、`voice-realtime-composer-embedded.spec.ts:189-317`、`voice-realtime-turn-unanswered.spec.ts:161-260`。能力参差，且都没有"上游自报错误 / 模型自答不调工具"这两类真故障的形态。

**接线只有一条缝，且是选定的。** `playwright.config.ts:2451-2458` 为四个点名 spec 分配 `QUAY_E2E_VOICE_REALTIME_PORT`，`:2544-2546` 只在那个 selection 里注入 `VOICE_REALTIME_ENDPOINT=ws://127.0.0.1:<port>`；`server/index.ts:457` 读它、`:544-551` 据此把 transport 指向该地址**并跳过凭据校验**（`:453-456` 注释自述"它的存在就是说：没有真端点、没有凭据"）。

**而"禁止云 API"今天只是约定，不是闸。** 该 env 无任何生产守卫；更关键的是：如果 e2e server 的环境里**恰好存在** `DASHSCOPE_API_KEY`（`playwright.config.ts` 的 `webServer.env` 会 spread `process.env`，见 `playwright-webserver-spreads-ambient-env`），那么一旦 endpoint 没被注入或被改错，transport 会**真的拨向 DashScope**（`voice-realtime-dashscope-transport.ts:866-873` 的守卫只在"无 socketFactory 且 key 为空"时拒绝）。今天没有任何断言盯住这一点。

**服务端侧已有一份脚本化上游**（`gap-voice-realtime-scripted-fake-upstream` 落地中）：`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts`，含 `captionDelta` / `captionCompleted` / `functionCall` / `endpointError` / `modelTextReply` / `transcriptionFailed` 六个构造器与 `SCRIPTED_ENDPOINT_URL`。它是**进程内 `DashscopeSocketFactory`**——浏览器 spec 需要的是一个**真的监听端口**的 WS 服务（应用 server 要经 TCP 拨它），故本任务要在 e2e 侧写一个真 `ws` 服务器包壳，**但事件词表必须复用同一份构造器**（那些构造器除 `import type` 外零依赖，Playwright 的 TS 转译可直接 import；`import type` 会被擦除，不会把服务端模块图拖进浏览器 bundle）。

### SCOPE BOUNDARY / 关联

- ⛔ 不迁移/改写四个既有 spec（它们的 Touches 与三个 Live Voice 功能任务重叠）——本任务**只新增**一个 spec 与一个 e2e helper，并只改 `playwright.config.ts` 的 selection。
- ⛔ 不重复 `gap-live-voice-voice-terminated-interrupt` / `gap-live-voice-stop-vs-exit-affordances` 自有 e2e AC 的语义：本任务对这两类只要求"在**同一份共享 harness** 上跑通、判据形态与它们一致"，实现细节归各自任务。这两条是**硬前置**，故本任务声明 `depends_on`。
- ⛔ 不动 `fileAudioSource` 的微任务 yield（音源节拍是 `gap-voice-realtime-paced-audio-source`）。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：于 `tasks/*.md` 对 `playwright live voice` / `e2e 共享` / `scripted fake` / `queue-full` / `session switching` 逐个 grep；`queue-full` 命中本任务声明依赖的三个功能任务（它们各自持有自己的 e2e AC，本任务提供 harness 不放宽其判据）。`task-granularity-advice.js` 对本任务 Touches（新 spec + 新 helper + `playwright.config.ts`）报 `peers: []`——与那三个任务**无 Touches 重叠**（它们声明的是既有 spec 文件，本任务不动它们）。

## Plan

1. **e2e 侧共享假上游** `e2e/voiceRealtimeScriptedUpstream.ts`（**不叫 `*.spec.ts`**，Playwright 的 testMatch 不会把它当用例）：真 `WebSocketServer` 监听 `QUAY_E2E_VOICE_REALTIME_PORT`，**import 复用**服务端那份六个事件构造器（不写第二套 builder），并暴露 `script(events)`（带 `afterMs`）、`drop()`、`refusedDial()`、以及 `clientFrames` / `dialed` 读数。
2. **新增一个 spec** `e2e/voice-realtime-scripted-scenarios.spec.ts`，覆盖：队列满（拒绝与深度**可见**）、caption 分裂/合并、会话切换、以及（依赖前置任务）中断与 stop-vs-exit。
3. **配置**：把新 spec 加入 `playwright.config.ts` 的 `voiceRealtimeSelection`（`:2451-2458`），使其自动获得端口分配与 `VOICE_REALTIME_ENDPOINT` 注入。
4. **云 API 默认严禁（本任务的核心安全项）**：在该 selection 的 `webServer.env` 里**显式把 `DASHSCOPE_API_KEY` 置空**，使"指错端点"也只会 `MISSING_API_KEY` 抛错而不是拨向真端点；并在 spec 内断言假上游确已收到连接、且页面/服务端均无出网读数。
5. **判据文件自证**：`scripts/test.sh`（fan-in suite）**不跑 Playwright**，故本任务所有 e2e AC 都是自证，须在 Evidence 写明。

## AC

- [x] AC1 取假形态（**排在 spec 最前**）：把 `VOICE_REALTIME_ENDPOINT` 从该 selection 撤掉（其余不动）⇒ 该 spec 必红（应用不再拨本地假上游）。这证明"指向本地假上游"是被断言的，不是被假设的；给出红/绿两次读数。
- [x] AC2 云 API 默认严禁（隔离断言）：该 selection 下 e2e server 的 `DASHSCOPE_API_KEY` 为空（实现须给出证据，如 webServer.env 的显式置空 + 一条断言），且假上游 `dialed` 读数 ≥1（连接确实到了本地）；再给出"无出网"读数（如对非环回地址的请求计数为 0）。
- [x] AC3 词表共用（不是第二套）：`e2e/voiceRealtimeScriptedUpstream.ts` 从 `server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` **import** 事件构造器；给出"重复定义计数为 0"的机械读数。
- [x] AC4 队列满（拒绝与深度可见）：脚本在上限之上继续投递 ⇒ 浏览器出现 `refused` 帧且屏上深度读数可见。**不断言任何阈值**（上限轴由 `gap-live-voice-queue-byte-budget-and-visible-backlog` 决定），只读 UI 声明的读数。
- [x] AC5 caption 分裂/合并（脚本化 interim+completed）⇒ transcript 单行原地定型、无空 final、无重复行（判据形态与 AC-326/AC-327 族一致）。
- [x] AC6 会话切换：连接中切到另一会话 ⇒ 该连接结束且无重复投递（脚本化上游下复现既有 spec 的同形判据）。
- [x] AC7 中断当前回合（**依赖前置任务落地**）：在共享 harness 上说停止 ⇒ 会话收到 abort；判据形态与 `gap-live-voice-voice-terminated-interrupt` 自有 e2e AC 一致。
- [x] AC8 stop-vs-exit（**依赖前置任务落地**）：退出键不 abort 当前回合、running 行停止键 abort；判据形态与 `gap-live-voice-stop-vs-exit-affordances` 自有 e2e AC 一致。
- [x] AC9 静态门（**自证；fan-in suite 不含 Playwright**）：`npx playwright test e2e/voice-realtime-scripted-scenarios.spec.ts` 退出 0；`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：**真实浏览器 + 真实应用 server + 真实 `/voice-realtime` 代理**，上游是**一个真的监听端口**的脚本化假服务（共享同一份事件词表），在这上面一次跑通队列满（可见拒绝）、caption 分裂/合并、会话切换、中断、stop-vs-exit 五类场景；并且**全程零云调用**——由"凭据被显式置空 + 假上游确已收到连接 + 无出网读数"三条共同证明。证据落在本任务 `## 验证记录`：每条场景的浏览器读数与截图、`dialed`/拒绝/深度读数、以及 AC1 的红/绿两次读数。⛔ fan-in suite 不跑 Playwright，本任务所有 e2e 判据均为自证。

## 验证记录

自证声明（首条先说）：`scripts/test.sh`（fan-in suite）**不运行 Playwright**，故 AC1–AC9 的 e2e 判据全部由本任务自跑自证；fan-in 的 typecheck/suite 不覆盖 `e2e/` 与 `playwright.config.ts`（`npm run typecheck` 只含 `src/`/`server/`/`scripts/` 三个 tsconfig，`npm run lint` 只扫 `src/ server/ scripts/ shared/`）。截图落在 `QUAY_LIVE_VOICE_SHOT_DIR`（本记录取自 `/tmp/quay-scripted-shots`）：`scripted-upstream-dial-and-credential.png`、`scripted-upstream-caption-fold.png`、`scripted-upstream-queue-refused.png`、`scripted-upstream-interrupt-stopped.png`、`scripted-upstream-leave-vs-stop.png`、`scripted-upstream-stop-aborts.png`。

**AC1（取假形态，红/绿两次读数）。**
- 红（撤掉 `VOICE_REALTIME_ENDPOINT`，把该 selection 的那行键名改成 `VOICE_REALTIME_ENDPOINT_RED_WITHHELD`，其余含 `DASHSCOPE_API_KEY: ''` 全不动）⇒ `npx playwright test e2e/voice-realtime-scripted-scenarios.spec.ts`：`✘ 1 … (25.6s)`，`Error: expect(received).toBe(expected)`，`Expected: "listening" / Received: "idle"`，`Timeout 25000ms exceeded while waiting on the predicate`（`waitForPhase` 在 spec:395 首读即红），`1 failed / 7 did not run`，`EXIT=1`。日志 `/tmp/scripted-e2e-ac1-red.log`。读数落在 spec 最前的 test 1 上——驱动旋钮撤走后应用不再拨本地假上游，故 `phase()` 停在 `idle`。
- 绿（恢复真 `VOICE_REALTIME_ENDPOINT` 行）⇒ `8 passed (1.7m)`，`EXIT=0`。日志 `/tmp/scripted-e2e-green-final.log`。

**AC2（云 API 默认严禁，三读数）。**
- SOURCE 半：`playwright.config.ts` 该 selection 的 env spread（`configSource.slice(configSource.indexOf('...(voiceRealtimeSelection'))`）同时含 `VOICE_REALTIME_ENDPOINT` 与 `DASHSCOPE_API_KEY: ''`（test 2 断言，绿）。显式置空使 transport 即便端点数错也只会 `MISSING_API_KEY` 抛错、不拨真端点（`voice-realtime-dashscope-transport.ts:866-873` 的守卫：无 socketFactory 且 key 空 ⇒ 拒绝）。
- 拨号读数：`upstream.dialed() >= 1` 与 `upstream.liveConnectionCount() >= 1`（test 1 断言，绿）——连接确实到达本地假上游。运行时凭据半：`upstream.upgradeHeaders()` 至少 1 条，且首条 upgrade 头里**不存在** `authorization`（key 为空 ⇒ 拨号头为 `{}`）。
- 无出网读数：`nonLoopbackWebSockets == []`（页面未开任何非环回 WebSocket）；非环回 HTTP 主机经允许清单 `{fonts.googleapis.com, fonts.gstatic.com, api.github.com}`（页面自身 chrome：字体与星标/更新检查）过滤后 `strayHosts == []`；非空断言 `nonLoopbackRequests.length > 0` 证明观察者非哑读。

**AC3（词表共用，机械读数）。** test 2 读两份文件源码：`e2e/voiceRealtimeScriptedUpstream.ts` 含 `from '../server/modules/voice-realtime/tests/voice-realtime-scripted-upstream'`；对六个构造器名做 `function\s+<name>\s*\(` 正则，**重复定义计数为 0**（`redefined == []`）；服务端模块 `export function\s+<name>\s*\(` 命中 **6/6**（`serverDefinitions.length == 6`）。

**AC4（队列满：拒绝与深度可见）。** 一个 held run 占住回合租约，脚本按 `session_send` 的**应用侧回执**分 5 次投递（每次等 `functionCallOutputs` 增长再隔 `QUEUE_CALL_GAP_MS=3000`，跨过 relay 硬编码的 2.5 s 合并窗）。断言：`data-refusal == 'queue-full'`（proxy 自己的 reason code）、`data-queued-depth` 为有限数且 `>= 1`。**未断言任何预算阈值**——只读 UI 声明的读数。test 4 绿（18.1s）。

**AC5（caption 分裂/合并）。** 脚本发 `captionDelta('item-caption','book a')` → `captionDelta(…,'book a table')` → `captionCompleted(…,'book a table')`，末尾再发一条对未上屏 utterance 的空 `captionCompleted('item-caption-blank','')`。断言：恰有 1 行文字为 `book a table`；无空 user 行；含 `book` 的行恰 1 行（interim 未化石成独立行）；user 行数 == `before.length + 1`；`voice-row-heard` 计数 1 且 `voice-row-delivering` 计数 0（定型落地）。test 3 绿（3.6s）。

**AC6（会话切换）。** 连接中 `liveConnectionCount == 1`；点 "new session" 后 `BAR` 计数 0、`liveConnectionCount == 0`，且 `dialed()` 与切换前相等（结束的连接**未被重开**，无重复投递），composer 可见。test 5 绿（1.8s），判据形态与 `e2e/voice-realtime-live-session-send.spec.ts:738-750` 同形。

**AC7（中断当前回合）。** 共享 harness 上先投 `session_send` 开一个 held run，等 `running-turn-stop` 可见（客户端轮询已观测到 run 在飞行），再投 `session_interrupt`。断言：`voice-realtime-stopped` 可见且含 `/still queued/`（proxy 的 `stopped` 行，带未被丢弃的积压深度），且 `toolOutputFor(upstream,'interrupt-stop') !== null`（interrupt 的 tool 结果确已回投上游 ⇒ 真的执行了）。**故意不断言 `aborted === true`**：debug-agent 会话的 provider `abort()` 按构造返回 false（scenario 是对文件的时钟走查，无子进程可拆），"会话收到 stop"由 `stopped` 帧读出——与 `gap-live-voice-voice-terminated-interrupt` 自有判据同形。test 6 绿（7.3s）。

**AC8（stop-vs-exit，两半）。**
- 退出半：held run 在飞行中读 DOM 形态——`running-turn-stop` 的 svg class 含 `square`，退出控件 `voice-realtime-end` 的 svg class 含 `log-out` 且**不含** `square`，`voice-realtime-exit-label == 'Exit'`；`FINAL_TURN_TEXT` 在退出前**不在** pane，点 `Exit` 后**新增 `chat.abort` 帧为 0**，且 `FINAL_TURN_TEXT` 随后出现在 pane（行落在 run 自己的时钟上 ⇒ 退出没 abort 它）。test 7 绿（25.4s）。
- 停止半：held run 飞行中点 `running-turn-stop`，读应用 socket 上的帧——`chat.abort` 恰多发 **1** 条，且该帧文本含被停的 `heldId`。run 本身不断言结束（本 fixture provider 不能 abort，见 AC7 注）。test 8 绿（7.5s）。

**AC9（静态门，自证）。** `npx playwright test e2e/voice-realtime-scripted-scenarios.spec.ts` ⇒ `8 passed (1.7m)`、`EXIT=0`（`/tmp/scripted-e2e-green-final.log`；逐例 2.4 / 0.003 / 3.6 / 18.1 / 1.8 / 7.3 / 25.4 / 7.5 s）。`npm run typecheck` ⇒ `TYPECHECK_EXIT=0`。`npm run lint` ⇒ `LINT_EXIT=0`（仅告警，且全在既有文件，新文件零告警）。

**与 Touches 的偏离声明（一字不改照实记）。** 除声明的 selection 列表与 `webServer.env` 外，本任务还在 `playwright.config.ts` 的 `SPEC_BUDGET_MS`（单文件 watchdog 预算表）追加了一行 `'voice-realtime-scripted-scenarios.spec.ts': 240_000`。原因：未列名的 spec 拿 55 s 的单文件默认上限，8 个真浏览器用例（实测 62.9 s 用例时长 + ~11 s 配置求值/启动/浏览器拉起）会被 watchdog 在 `browser-launch-or-cases` 阶段于 55 000 ms 处 kill（exit 1）；240_000 与该表中相邻的 `voice-realtime-upload-fixture.spec.ts` 同值同理由。这仍在 `playwright.config.ts` 这一个文件内（路径级 anti-drift 已满足），但超出该 bullet 的括号限定——故在此披露，bullet 已同步更新。

## Touches

- e2e/voice-realtime-scripted-scenarios.spec.ts (new)（本任务判据文件）
- e2e/voiceRealtimeScriptedUpstream.ts (new)（e2e 侧共享假上游包壳；复用服务端事件词表）
- playwright.config.ts (only the `voiceRealtimeSelection` list, that selection's `webServer.env`, and the `SPEC_BUDGET_MS` per-file watchdog-budget entry for the new spec — the last is declared in 验证记录 as a deviation from the original two-part bullet)
- tasks/gap-live-voice-e2e-scripted-upstream.md (self)
