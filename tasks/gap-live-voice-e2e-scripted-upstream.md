---
id: gap-live-voice-e2e-scripted-upstream
title: Playwright Live Voice E2E：真实浏览器 + 共享 scripted fake
  upstream（复用服务端同一份事件词表）覆盖 queue/full、interrupt、stop-vs-exit、caption、session
  switching；默认严禁云 API（凭据置空 + 拨号与出网双读数）
status: ready
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

- [ ] AC1 取假形态（**排在 spec 最前**）：把 `VOICE_REALTIME_ENDPOINT` 从该 selection 撤掉（其余不动）⇒ 该 spec 必红（应用不再拨本地假上游）。这证明"指向本地假上游"是被断言的，不是被假设的；给出红/绿两次读数。
- [ ] AC2 云 API 默认严禁（隔离断言）：该 selection 下 e2e server 的 `DASHSCOPE_API_KEY` 为空（实现须给出证据，如 webServer.env 的显式置空 + 一条断言），且假上游 `dialed` 读数 ≥1（连接确实到了本地）；再给出"无出网"读数（如对非环回地址的请求计数为 0）。
- [ ] AC3 词表共用（不是第二套）：`e2e/voiceRealtimeScriptedUpstream.ts` 从 `server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` **import** 事件构造器；给出"重复定义计数为 0"的机械读数。
- [ ] AC4 队列满（拒绝与深度可见）：脚本在上限之上继续投递 ⇒ 浏览器出现 `refused` 帧且屏上深度读数可见。**不断言任何阈值**（上限轴由 `gap-live-voice-queue-byte-budget-and-visible-backlog` 决定），只读 UI 声明的读数。
- [ ] AC5 caption 分裂/合并（脚本化 interim+completed）⇒ transcript 单行原地定型、无空 final、无重复行（判据形态与 AC-326/AC-327 族一致）。
- [ ] AC6 会话切换：连接中切到另一会话 ⇒ 该连接结束且无重复投递（脚本化上游下复现既有 spec 的同形判据）。
- [ ] AC7 中断当前回合（**依赖前置任务落地**）：在共享 harness 上说停止 ⇒ 会话收到 abort；判据形态与 `gap-live-voice-voice-terminated-interrupt` 自有 e2e AC 一致。
- [ ] AC8 stop-vs-exit（**依赖前置任务落地**）：退出键不 abort 当前回合、running 行停止键 abort；判据形态与 `gap-live-voice-stop-vs-exit-affordances` 自有 e2e AC 一致。
- [ ] AC9 静态门（**自证；fan-in suite 不含 Playwright**）：`npx playwright test e2e/voice-realtime-scripted-scenarios.spec.ts` 退出 0；`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：**真实浏览器 + 真实应用 server + 真实 `/voice-realtime` 代理**，上游是**一个真的监听端口**的脚本化假服务（共享同一份事件词表），在这上面一次跑通队列满（可见拒绝）、caption 分裂/合并、会话切换、中断、stop-vs-exit 五类场景；并且**全程零云调用**——由"凭据被显式置空 + 假上游确已收到连接 + 无出网读数"三条共同证明。证据落在本任务 `## 验证记录`：每条场景的浏览器读数与截图、`dialed`/拒绝/深度读数、以及 AC1 的红/绿两次读数。⛔ fan-in suite 不跑 Playwright，本任务所有 e2e 判据均为自证。

## Touches

- e2e/voice-realtime-scripted-scenarios.spec.ts (new)（本任务判据文件）
- e2e/voiceRealtimeScriptedUpstream.ts (new)（e2e 侧共享假上游包壳；复用服务端事件词表）
- playwright.config.ts (only the `voiceRealtimeSelection` list and that selection's `webServer.env`)
- tasks/gap-live-voice-e2e-scripted-upstream.md (self)
