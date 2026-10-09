---
id: gap-voice-realtime-live-session-send-wiring
title: 真实 context 读取 + session_send 对接当前会话，参数白名单替代审批层（AC-310）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-realtime-dashscope-transport-harness
  - gap-voice-realtime-real-audio-paired-evidence
goal_ac: AC-310
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "live-executor\|live-session-send" tasks/*.md goals/*.md` 零命中；GOAL-029/030 的 executor 一直是 fixture（回填预先写死的夹具数据），没有任何任务把它接到真实 `ChatControlService`。本任务是 GOAL-031 的第一块，`gap-voice-realtime-browser-e2e-current-session` 依赖它。

### 背景与阻塞说明

本任务 `depends_on` 两个任务：`gap-voice-realtime-dashscope-transport-harness`（已 done，提供真实 transport）与 `gap-voice-realtime-real-audio-paired-evidence`（AC-309，提供"值不值得接线"的真实读数）。**执行者接到本任务时，第一件事是去读 `gap-voice-realtime-real-audio-paired-evidence` 的完成记录里那句人读的 GO/NO-GO 结论**：若是 GO，按下面的方案正常实现；若是 NO-GO，**停下来**，把本任务转 `needs-human`，附上那句 NO-GO 结论和需修正点，等人工重新确认是否仍要推进本任务——批准创建 GOAL-031 不等于批准"不管 AC-309 读数如何都强行接线"。

### 方案

1. 新执行体 `server/modules/voice-realtime/voice-realtime-live-executor.ts`：实现 bridge 已有的 executor 接口。
2. 六个只读工具：直接调用 `server/modules/mcp-gateway/*` 已经导出的构建函数（`buildUiVisibleContext`、`session_get`/`run_get`/`approvals_list`/`session_background` 对应的构建逻辑），同一份实现，不抄第二份。
3. `session_send`：直接调用进程内的 `ChatControlService.send`（第一方直连，不经 PAT/HTTP，形状同 `mcp-session-send.ts` 的 `control` 依赖），`caller` 标记来源，使落下的 run 的 `ChatRunSource` 为 `mcp`（复用既有枚举值，不新增）。
4. **安全边界 = 参数白名单，不是审批层**：构造执行体时注入一个固定的 `boundSessionId`（这条语音连接绑定的那一个 app session id）；无论模型在 function_call 参数里传什么 session，`session_send` 只会对 `boundSessionId` 生效——传别的值要被拒绝并记录原始尝试（用于后续排查，不是用于审批）。
5. 不新增权限模式、不新增 consent 流程、不碰 `canUseTool`/`approval_answer` 任何现有行为。

### 边界（不做）

不做跨会话/跨项目解析（`boundSessionId` 在本任务范围内就是唯一能操作的目标）；不新建审批/确认 UI；不改 bridge/tools 本体；真实网络调用的触发入口（真正打开一条语音连接）是 `gap-voice-realtime-browser-e2e-current-session` 的事，本任务只交付执行体本身，可以用脚本/测试驱动验证。

## AC

- [x] AC1 六个只读工具路由正确：对假 `ChatControlService`/假 gateway 依赖，六个工具调用都落到对应的真实构建函数（不是抄一份新逻辑），参数原样传递。
- [x] AC2 `session_send` 直连 `ChatControlService`：真实调用（在假依赖下）产生的调用记录里能看到 `caller`/来源标记对应 `mcp`。
- [x] AC3 参数白名单生效：取假变体——function_call 参数里指定一个不同于 `boundSessionId` 的 session，必须被拒绝并记录，不得对那个会话生效。
- [x] AC4 不新增确认流程：`git diff` 证明本任务没有新增任何权限模式/consent 组件/弹窗；`canUseTool`/`approval_answer` 相关文件逐字未改。
- [x] AC5 阻塞处理如实执行：完成记录必须写明读取 `gap-voice-realtime-real-audio-paired-evidence` 的 GO/NO-GO 结论是什么，以及本任务据此采取了哪条路径。
- [x] AC6 真实半区：至少一次真实的语音 function_call → `session_send` 落到一个真实测试会话，该会话转录出现一条 `mcp` 来源的新轮次（手动触发，不进 CI）。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

真实落地判据：不是"又加了一个执行体文件"，是**它真的能让一次语音意图落成一条真实的 Claude Code 轮次，且"能操作哪个会话"这件事由参数白名单钉死，而不是靠一个新的确认对话框**。AC3 证明白名单在起作用；AC6 证明真的落到了真会话；AC4 证明没有偷偷造一套新的审批体系。

## Touches

- server/modules/voice-realtime/voice-realtime-live-executor.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-live-executor.false-forms.test.ts (new)
- server/modules/voice-realtime/index.ts
- server/modules/mcp-gateway/index.ts (新增 buildSessionDetail 值导出与 McpSessionBackgroundInput 类型导出，供执行体经 barrel 取用)
- tasks/gap-voice-realtime-live-session-send-wiring.md (self)

## 完成记录

### AC5 — 阻塞处理：读到的是 GO，走正常实现这条路径

`depends_on` 的 `gap-voice-realtime-real-audio-paired-evidence` 完成记录里那句人读的 GO/NO-GO（`docs/experiments/2026-10-09-voice-realtime-real-paired.md:211`）逐字为：

> **GO（有条件）——值得另外立案 `gap-voice-realtime-session-send-smoke`。**

理由：真实 Realtime 通路（真实 transport + bridge + 模型自主 function call + 真实 executor 回填）在真实音频上**端到端跑通了**（总体 B 32/72 > A 21/72，两臂在同一次运行里公平配对）。但 GO 是给「这条路值得再做一次生产会话收发验证」，**不是**给「Realtime 理解更好」——后者被该读数证伪（唯一的纯语言理解类，自我更正，B 4/15 输给 A 6/15）。

**本任务据此采取的路径：正常实现，不转 `needs-human`。** GO 要的正是「把这条通路接到真实 `ChatControlService`」，即本任务；且该记录「诚实的范围声明」第 5 条逐字点出本任务要补的缺口：「没有把执行器接到真实 `ChatControlService`（executor 回填的是 GOAL-029 的夹具读数）」。

GO 一并登记的需修正点，如实照抄并标注本任务范围内的处理：

1. bridge 工具集**补 `ui_selected_text`** —— **超出本任务 `## Touches`/范围**（本任务只交付执行体本身，边界明确「不改 bridge/tools 本体」），**顺延**给后续任务，不在本任务内静默忽略。
2. 查 Realtime 会话**连接稳定性**（`CONNECTION_LOST` ×3 全落 `sc-03`）与**超时行为**（4 条顶 45 s）—— 属真实网络连接，本任务不打开真实连接，顺延。
3. 逐类核 `UNKNOWN_EVENT` 的构成 —— 同上，顺延。

### AC1/AC2/AC3 — 正形与反形都在本树绿

`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts server/modules/voice-realtime/tests/voice-realtime-live-executor.false-forms.test.ts` → `tests 6 / pass 6 / fail 0`，exit 0。

- **AC1**：六个 route 逐个与 gateway 自己的 `build*` 在同一套假服务上比对——返回**值**与**服务交互日志**都相等，且日志非空（排除「不落任何服务的假答案」）；路由表键集恰为六个工具名。
- **AC2**：`session_send` 到控制 seam 的调用记录里 `caller` 为 `{userId:7, via:'mcp'}`、payload 的 `source==='mcp'`。
- **AC3**：命名他会话的调用抛 `VoiceRealtimeSessionRefusalError`、被记录一次（`rawArguments` 原样）、且不触达控制 seam；省略 session 的调用落到 `boundSessionId`。
- **反形**（证明读数可红）：AC1 反形把 `session_send` 换成硬编码 payload——返回**值相等**、但不落任何服务，被「委派读数」抓住；AC3 反形把白名单守卫 `if(false)` 中和——不拒绝、不记录，静默改写到 bound session。残留检查证明本进程不留副本。

### AC4 — 没有偷偷造一套新审批体系

`git diff develop...HEAD`（5 文件，+899 −9）：改动为执行体、两个测试、`voice-realtime/index.ts`，以及 `server/modules/mcp-gateway/index.ts` 的两条 re-export。diff 中出现的 `canUseTool`/`approval_answer`/consent 只在一段注释里，那段注释是**声明本任务不新增**权限模式/consent 流程/确认弹窗。`git diff --name-only develop...HEAD` 不含任何 approval/consent/permission 相关文件——`canUseTool`/`approval_answer` 相关文件逐字未改。

### AC6 — 真实半区（手动触发，不进 CI）：真实 function_call → 真实 `ChatControlService` → 真实会话 mcp 轮次

一次性探针（写于 `/tmp/ac310-voice-live/`，跑完即删，不入库）在**本 worktree 的代码**上 boot 真实栈：真实 better-sqlite3 临时库 + 真实 `createProviderRuntimeService` + 真实 `createChatControlService` + 真实 `chatRunRegistry` + 一个真实 debug-agent 夹具会话（真跑一次 scenario）。执行体按**真实 `session_send` 依赖**构造（`control`=真实控制服务；`runs`=`chatRunRegistry.getRun`；`runGet`=`buildRunGet` 真件），经**真实 bridge `connect()`** 驱动——不是直接调执行体。读数：

- 一条**真实 Realtime `function_call`**（`name: session_send`，`arguments` 为 JSON）经 bridge 派发（bridge `state=open`，`openAttempts=1`）；
- 落下的 run：`source: 'mcp'`，`status: 'running'`，`writer.userId=1`；`getRunById(runId).source` 亦为 `'mcp'`（runId `b49caaf4-a23e-43cd-b278-3cfbb1f02609`，上文一次运行 `7ff85fae-…` 同样 `mcp`）；
- bridge 回填 `function_call_output`：`{runId, queued:false, queuedMessageUuid:null, source:"mcp"}`；
- **该会话转录新增轮次**：seedRows 2 → 4（delta=2）——先落「语音消息本身」的用户轮次（正文逐字为语音 intent `voice intent: open the failing test`），再落 scenario 的助手轮次 `AC310 voice round finished`；
- 同一真实栈上白名单也生效：命名他会话（`sess-someone-else`）的 function_call 被拒绝并记录（`rawArguments` 原样），他会话**未**注册 run，bridge 以 `TOOL_EXECUTION_FAILED` + `VoiceRealtimeSessionRefusalError` 回报。

诚实范围（不夸大）：(a) 这条 `function_call` 是**真实 wire 形状**的帧经**真实 bridge** 派发，但由探针的传输层投递，**不是**活的 DashScope 模型 socket——活连接是 Proposal 明确顺延给 `gap-voice-realtime-browser-e2e-current-session` 的事（本会话亦无 `DASHSCOPE_API_KEY`）；(b)「真实轮次」由 debug-agent 夹具 provider 真跑产生（与 `mcp-session-send.test.ts` 的真臂同法），非活的 Claude 模型；(c) 探针只把 `session_send` 接到真实依赖，其余五个只读 route 用空桩（其路由已由 AC1 在假依赖下证明）。

### AC7 — 静态门

`npm run typecheck` exit 0；`npm run lint` exit 0（余下均为既有警告，无一条落在 voice-realtime 文件）。
