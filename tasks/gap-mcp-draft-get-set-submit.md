---
id: gap-mcp-draft-get-set-submit
title: MCP 工具 draft 读/写/提交：读取、替换并经 UI 同一发送路径提交会话的未发送输入框草稿
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 去重（按机制）：`task_list search` 对 `composer draft`、`mcp-draft` 均为空；`draft` 仅命中无关项（重试不可达发送、quay 目标生命周期字符串）。无同机制任务。

缺口：外部 MCP 客户端无法读取某会话未发送的输入框草稿、替换它、或像用户点击发送那样提交，只能伪造键盘流程。已知线索（实施第一步必须核实）：草稿已按会话持久化——`src/modules/chat/hooks/useChatComposerState.ts` 与 `src/shared/tests/chatDrafts.test.ts`（草稿「同步可读并上送服务器」）说明存在一个已有的草稿存储及服务端同步，应复用，不另造。

要交付：先读 `server/index.ts` 中 `uiOpenSession`、`residentTools`、`writeNotifications` 依赖组的装配方式，以及 `session_host_control`、`approvals_list`/`approval_answer` 的多动词拆分方式，据此在 Plan 里定「一个带 get/set/submit 判别的工具」还是「三个工具」，并写入 Notes。提交必须走与 UI 输入框相同的发送服务（与 `session_send` 同用共享的 chat-control 服务），不重写第二条发送路径。set 为写操作，submit 与 session_send 同级，需对应写 scope；get 为只读。

## Plan

1. 核实现有草稿存储（客户端 key、服务端表/路由），记录于 Notes；缺失才新增最小存储。
2. 新建 `mcp-draft.ts`（遵守 `$backend-module-standards`），注入依赖切片，不整服务搬入。
3. 同步工具表、annotations、error-codes、barrel、`server/index.ts` 装配与 registry 驱动覆盖表（english-only、error-envelope、读/写工具计数、invalid-argument 参数表）。
4. 前端若需在草稿被 MCP 改写时刷新输入框，复用既有草稿同步通道。

## AC

- [ ] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-draft.test.ts` 退出码 0，包含往返：set 后 get 逐字返回同一文本；submit 后会话转录出现该文本的用户轮次，runId 与 chat-run 注册表一致且 `source==='mcp'`；submit 后草稿被清空。
- [ ] 同一测试断言：空草稿 submit 返回结构化错误且不启动运行（send 计数为 0）；缺少写 scope 的令牌调用 set/submit 返回 `INSUFFICIENT_SCOPE` 且写审计 `denied` 一行；get 仅需读 scope。
- [ ] 同一测试断言 submit 经注入的共享 control 服务 `send`（spy 计数为 1），`grep -n "chat-control\|ChatControl" server/modules/mcp-gateway/mcp-draft.ts` 显示未自建发送路径。
- [ ] 取假形态：让 submit 绕开 control 服务直接写转录，往返用例必须红；记录红行与恢复。
- [ ] `grep -n "draft" server/modules/mcp-gateway/mcp-tool-annotations.ts server/modules/mcp-gateway/mcp-tool-error-codes.ts` 命中；`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-tool-annotations.test.ts` 逐文件运行退出码 0；`quay-test-script.test.ts` 文件数 pin 已同步并退出码 0；`npm run typecheck` 退出码 0。

## DoD

在真实运行的服务上：用 PAT 经 `/mcp` 对一个真实会话 set 草稿，浏览器中该会话的输入框能看到该文本（或重新打开后可见），再经 MCP submit，该轮出现在会话里与用户键入发送的轮次无异。仅有夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-draft.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-draft.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-draft-get-set-submit.md
