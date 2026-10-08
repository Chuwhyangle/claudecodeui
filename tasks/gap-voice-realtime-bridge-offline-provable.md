---
id: gap-voice-realtime-bridge-offline-provable
title: Realtime bridge + 工具调用在假 WS 服务端上离线可证（AC-305）
status: todo
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

- [ ] AC1 连接状态机：假 WS 服务端上可驱动 `connecting → open → closing → closed` 全流程，含断连后的有限次重连，退出码 0；全程零真实网络（真实 `fetch`/WS 连接目标非 localhost/假实现即判红）。
- [ ] AC2 工具 schema 逐字段一致：对 `ui_visible_context`/`session_send`/`session_get`/`run_get`/`approvals_list`/`session_background` 六个工具，`voice-realtime-tools.ts` 导出的 schema 与 `server/modules/mcp-gateway/*` 对应 Zod 定义逐字段相等。取假变体：改动任一工具的任一字段 ⇒ 对比断言必须红并指名字段。
- [ ] AC3 function-call 路由正确：六个工具各自的调用被路由到对应 executor，参数原样传递（不改写、不丢字段、不换顺序）。取假变体：把路由改成固定分派到某一个工具 ⇒ 必须红。
- [ ] AC4 异常路径不崩溃：连接中断 / executor 抛错 / 未知事件类型三种情形，进程不崩溃，`onError` 被调用且带可辨识的错误信息。取假变体：去掉异常捕获 ⇒ 任一情形下进程抛出未捕获异常，必须红。
- [ ] AC5 离线：全程注入假 WS 服务端，零真实网络；真实网络调用即红。
- [ ] AC6 false-forms 自成一类：`node --test server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts` 退出 0；AC2/AC3/AC4 的三条取假变体各是其中一条独立用例，先证未变异为绿、再证变异为红。
- [ ] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。
- [ ] AC8 模块规范：`server/modules/voice-realtime/` 下的新文件按 `$backend-module-standards`（跨模块只经 `index.ts`，类型/目录归置规则）落地。

## DoD

真实落地判据：不是"模块存在"，是**六个工具的协议形状真的和现有 MCP 定义对得上、且这件事是可红的**——AC2 的逐字段比较必须能在改动任一字段时变红，否则这条"镜像既有协议"的声明没有实际约束力。本任务不证明真实 Qwen Realtime 的协议细节（那是另一个 GOAL 阶段 0 式的实验，不在本任务范围），只证明"假设这套 function-calling 协议成立，桥接层的行为是对的"。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts (new)
- server/modules/voice-realtime/voice-realtime-tools.ts (new)
- server/modules/voice-realtime/index.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-bridge.false-forms.test.ts (new)
- tasks/gap-voice-realtime-bridge-offline-provable.md (self)