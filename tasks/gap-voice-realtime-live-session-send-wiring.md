---
id: gap-voice-realtime-live-session-send-wiring
title: 真实 context 读取 + session_send 对接当前会话，参数白名单替代审批层（AC-310）
status: todo
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

- [ ] AC1 六个只读工具路由正确：对假 `ChatControlService`/假 gateway 依赖，六个工具调用都落到对应的真实构建函数（不是抄一份新逻辑），参数原样传递。
- [ ] AC2 `session_send` 直连 `ChatControlService`：真实调用（在假依赖下）产生的调用记录里能看到 `caller`/来源标记对应 `mcp`。
- [ ] AC3 参数白名单生效：取假变体——function_call 参数里指定一个不同于 `boundSessionId` 的 session，必须被拒绝并记录，不得对那个会话生效。
- [ ] AC4 不新增确认流程：`git diff` 证明本任务没有新增任何权限模式/consent 组件/弹窗；`canUseTool`/`approval_answer` 相关文件逐字未改。
- [ ] AC5 阻塞处理如实执行：完成记录必须写明读取 `gap-voice-realtime-real-audio-paired-evidence` 的 GO/NO-GO 结论是什么，以及本任务据此采取了哪条路径。
- [ ] AC6 真实半区：至少一次真实的语音 function_call → `session_send` 落到一个真实测试会话，该会话转录出现一条 `mcp` 来源的新轮次（手动触发，不进 CI）。
- [ ] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

真实落地判据：不是"又加了一个执行体文件"，是**它真的能让一次语音意图落成一条真实的 Claude Code 轮次，且"能操作哪个会话"这件事由参数白名单钉死，而不是靠一个新的确认对话框**。AC3 证明白名单在起作用；AC6 证明真的落到了真会话；AC4 证明没有偷偷造一套新的审批体系。

## Touches

- server/modules/voice-realtime/voice-realtime-live-executor.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-live-executor.false-forms.test.ts (new)
- server/modules/voice-realtime/index.ts
- tasks/gap-voice-realtime-live-session-send-wiring.md (self)