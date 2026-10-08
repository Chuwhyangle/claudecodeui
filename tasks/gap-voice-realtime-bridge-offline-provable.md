---
id: gap-voice-realtime-bridge-offline-provable
title: Realtime bridge + 工具调用在假 WS 服务端上离线可证（AC-305）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-305
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "voice-realtime|qwen.*realtime" tasks/*.md goals/*.md` 零命中；全仓无任何任务/goal 以同一机制声明过 `server/modules/voice-realtime/` 或这条 Realtime bridge。本任务是 GOAL-029 的第一块：落地一个可离线验证的 Realtime bridge 模块与一组镜像既有 MCP 工具形状的 schema，是整条 prototype 链路（Task 2 预注册、Task 3 对比取数）的前提。

### 背景

`docs/proposals/voice-native-control-plane.md` §2 已经指出：`server/modules/mcp-gateway/*` 已经把"驱动 Claude Code"收窄成几个高层动词（`session_send`/`session_interrupt`/`session_cancel_queued`/`approval_answer`/`session_reconfigure`，以及只读的 `ui_visible_context`/`ui_selected_text`/`session_get`/`run_get`/`approvals_list`/`session_background`）。本任务不碰 MCP gateway 本身，只是让一个新的 Realtime bridge 模块能够"说同一套语言"：对假 WS 服务端建连，发 `session.update`（系统指令 + 工具 schema），转发音频帧占位（本任务不要求真实音频编解码，只要求帧级的 pass-through 接口存在），收 function-call 事件，把调用路由到一个**注入的** tool executor（真实执行留给以后，本任务的 executor 永远是测试/实验注入的假实现）。

### 方案

1. `server/modules/voice-realtime/voice-realtime-tools.ts`：导出六个工具的 schema 常量，字段直接从 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts`（`ui_visible_context`/`session_get`/`run_get`/`approvals_list`）、`mcp-gateway.write-tools.ts`（`session_send`）、`mcp-session-background.ts`（`session_background`）对应的 Zod `inputSchema`/`outputSchema` 派生或镜像（同一份字段来源，不手写第二份）。
2. `server/modules/voice-realtime/voice-realtime-bridge.service.ts`：`connect(transport, tools, executor)` 形态的纯函数式服务；`transport` 是注入的 WS 客户端接口（测试用假实现，生产将来用真实 WS 客户端，本任务不实现生产那一端）；状态机覆盖 `connecting → open → closing → closed`，支持有限次重连；收到 function-call 事件后，按工具名查表调用 `executor[toolName](args)`，把返回值包成 function-call-output 事件写回 `transport`；未知事件类型与 executor 抛出的错误都被捕获并转成一次性的 `onError` 回调，不让进程崩溃。
3. `server/modules/voice-realtime/index.ts`：模块 barrel，只导出 bridge 与工具 schema 的公开类型/函数。
4. 测试：`tests/voice-realtime-bridge.test.ts`（正常路径：建连、发送 `session.update`、六个工具各自的路由与参数透传、断连重连）+ `tests/voice-realtime-bridge.false-forms.test.ts`（AC 的三条取假形态各一条独立可红用例，先证未变异为绿）。

### 边界（不做）

不实现真实 WS 客户端连到 DashScope/Qwen（`transport` 全程是测试注入的假实现）；不实现音频编解码；不接 `ChatControlService`，六个工具的 executor 全程是注入的假函数；不做前端任何改动；不做 `session.update` 的上下文推送策略（Task 3 如果需要会在 runner 里自己构造，不进本模块）。

## AC

- [x] AC1 连接状态机：假 WS 服务端上可驱动 `connecting → open → closing → closed` 全流程，含断连后的有限次重连，退出码 0；全程零真实网络（真实 `fetch`/WS 连接目标非 localhost/假实现即判红）。
- [x] AC2 工具 schema 逐字段一致：对 `ui_visible_context`/`session_send`/`session_get`/`run_get`/`approvals_list`/`session_background` 六个工具，`voice-realtime-tools.ts` 导出的 schema 与 `server/modules/mcp-gateway/*` 对应 Zod 定义逐字段相等。取假变体：改动任一工具的任一字段 ⇒ 对比断言必须红并指名字段。
- [x] AC3 function-call 路由正确：六个工具各自的调用被路由到对应 executor，参数原样传递（不改写、不丢字段、不换顺序）。取假变体：把路由改成固定分派到某一个工具 ⇒ 必须红。
- [x] AC4 异常路径不崩溃：连接中断 / executor 抛错 / 未知事件类型三种情形，进程不崩溃，`onError` 被调用且带可辨识的错误信息。取假变体：去掉异常捕获 ⇒ 任一情形下进程抛出未捕获异常，必须红。
- [x] AC5 离线：全程注入假 WS 服务端，零真实网络；真实网络调用即红。
- [x] AC6 false-forms 自成一类：`node --test server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts` 退出 0；AC2/AC3/AC4 的三条取假变体各是其中一条独立用例，先证未变异为绿、再证变异为红。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。
- [x] AC8 模块规范：`server/modules/voice-realtime/` 下的新文件按 `$backend-module-standards`（跨模块只经 `index.ts`，类型/目录归置规则）落地。

## DoD

真实落地判据：不是"模块存在"，是**六个工具的协议形状真的和现有 MCP 定义对得上、且这件事是可红的**——AC2 的逐字段比较必须能在改动任一字段时变红，否则这条"镜像既有协议"的声明没有实际约束力。本任务不证明真实 Qwen Realtime 的协议细节（那是另一个 GOAL 阶段 0 式的实验，不在本任务范围），只证明"假设这套 function-calling 协议成立，桥接层的行为是对的"。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts (new)
- server/modules/voice-realtime/voice-realtime-tools.ts (new)
- server/modules/voice-realtime/index.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts (new)
- server/modules/voice-realtime/tests/realtime-bridge-harness.ts (new, test-only fake-WS + gateway-schema oracle shared by both criteria)
- server/shared/tests/quay-test-script.test.ts (edited: known/unknown count pins bumped +2 for the two new test files)
- tasks/gap-voice-realtime-bridge-offline-provable.md (self)

## 完成记录

实现全部落在新模块 `server/modules/voice-realtime/`（唯一跨模块入口是 `index.ts`）。

- **AC1 / AC4 / AC5** — `connect(transport, tools, executor, options?)` 纯注入缝：状态机 `connecting → open → closing → closed`，`maxConnectAttempts` 限次重连（默认 3），意外断连触发一次 `CONNECTION_LOST{willRetry}` 后自重连；未知事件类型 / executor 抛错 / 未知工具名 / 发送失败均被两个守卫（`guardSync` / `guardAsync`）转成一次性 `onError`，进程不崩。运行期零网络导入（仅 `import type`）；`voice-realtime-bridge.test.ts` 用抛错探针替换 `globalThis.fetch` / `WebSocket` 驱动整场会话（含断连重连），断言 `networkCalls === 0`。
- **AC2（DoD 的"可红"）** — `voice-realtime-tools.ts` 镜像六工具的 `inputSchema`/`outputSchema`；`tests/realtime-bridge-harness.ts` 经 gateway barrel 的四个 registration 函数用 recording seam 抓到 gateway **自己声明的** schema 作 oracle，`diffToolDescriptors` 逐字段比较，六工具全 `[]`。取假形态证明可红：改类型 ⇒ `shape`、删字段 ⇒ `missing`、加字段 ⇒ `unexpected`，每例 red 都报出字段名。
- **AC3** — function-call 按 `call.name` 查 `executor`，参数原样传（值 + 键序都相等），返回值包成 `function_call_output` 带 `callId` 写回；取假形态把路由写死成 `session_send`，同一调用落到错误 executor，判红。
- **AC6（命令替换，已记录）** — 取假形态文件自成一类。AC6 字面写的 `node --test <file>` 在本仓不可执行：Node v24 的 TS 类型擦除不对 TS-ESM 的 `.js` 说明符做 `.ts` 重映射，实测 `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/modules/voice-realtime/index.js'`，exit 1。忠实 runner 是本仓通用的 `tsx --tsconfig server/tsconfig.json --test <file>`（node:test API 不变），exit 0，4/4 通过——AC2/AC3/AC4 三条取假各一条独立用例，先证未变异为绿、再证变异为红；末条证明本进程自己的 `__criterion-falsify-*-<pid>.ts` 副本清零。
- **AC7** — `npm run typecheck` exit 0；`npm run lint` exit 0（仅无关文件既有 warning）。
- **AC8** — 跨模块只经 `index.ts`：harness 走 `@/modules/mcp-gateway/index.js`（type-only），criterion 走 `../index.js`。

新增两个 `*.test.ts` 使 server 测试文件总数 254 → 256，已同步 `server/shared/tests/quay-test-script.test.ts` 两处 known/unknown 计数 pin（+2）；预退出合并 `develop` 后复测 pin 11/11 仍绿、`find` 计数仍 256，`npm run typecheck` 仍 exit 0。

判据文件：`server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts`（6/6）、`server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts`（4/4）。本模块被移除或字段漂移时，AC2 的逐字段比较即变红。