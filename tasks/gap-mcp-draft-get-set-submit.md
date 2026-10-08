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

- [x] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-draft.test.ts` 退出码 0，包含往返：set 后 get 逐字返回同一文本；submit 后会话转录出现该文本的用户轮次，runId 与 chat-run 注册表一致且 `source==='mcp'`；submit 后草稿被清空。
- [x] 同一测试断言：空草稿 submit 返回结构化错误且不启动运行（send 计数为 0）；缺少写 scope 的令牌调用 set/submit 返回 `INSUFFICIENT_SCOPE` 且写审计 `denied` 一行；get 仅需读 scope。
- [x] 同一测试断言 submit 经注入的共享 control 服务 `send`（spy 计数为 1），`grep -n "chat-control\|ChatControl" server/modules/mcp-gateway/mcp-draft.ts` 显示未自建发送路径。
- [x] 取假形态：让 submit 绕开 control 服务直接写转录，往返用例必须红；记录红行与恢复。
- [x] `grep -n "draft" server/modules/mcp-gateway/mcp-tool-annotations.ts server/modules/mcp-gateway/mcp-tool-error-codes.ts` 命中；`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-tool-annotations.test.ts` 逐文件运行退出码 0；`quay-test-script.test.ts` 文件数 pin 已同步并退出码 0；`npm run typecheck` 退出码 0。

## DoD

在真实运行的服务上：用 PAT 经 `/mcp` 对一个真实会话 set 草稿，浏览器中该会话的输入框能看到该文本（或重新打开后可见），再经 MCP submit，该轮出现在会话里与用户键入发送的轮次无异。仅有夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-draft.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/mcp-error-envelope.ts（新增 `DRAFT_EMPTY` 错误码）
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-draft.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/mcp-gateway/tests/mcp-tool-annotations.test.ts（覆盖表随新工具更新）
- server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts（覆盖表随新工具更新）
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-draft-get-set-submit.md

## Notes

### 三个工具，不是一个（Plan 第 1 步的结论）

传输层的 `audited()` 每次注册只接受**一个** `requiredScope`，带判别的单工具无法同时表达「get=读、set/submit=写」。拆成三个：`draft_get`（`cloudcli:read`，`readOnlyHint`）、`draft_set`/`draft_submit`（`cloudcli:session:send`）。与 `approvals_list`/`approval_answer` 的既有拆分同形。

### 复用的草稿存储

服务端已有 `sessionDraftsDb`（`server/modules/database/repositories/session-drafts.db.ts`，经 `@/modules/database/index.js` 导出）：`getDrafts(userId)`、`saveDraft(userId, scope, {text, queuedMessage})`（text 空且 queuedMessage 为 null 时自动删除）。scope 即会话 id；浏览器输入框从 `GET /api/user/drafts` 水合。MCP 三工具直接复用它，不另造存储。`server/index.ts` 的真实 `/mcp` 装配把 `draft: { drafts: sessionDraftsDb }` 同时加入 readTools 与 writeTools 依赖包。

### 注册条件化

`MCP_STAGE3_READ_TOOLS` / `MCP_STAGE4_WRITE_TOOLS` 未改动：三个工具在 read/write seam 上按可选的 `draft` 依赖成员条件注册（resident-tools 先例）。因此 `mcp-read-tools.test.ts`（pin 12）与 `mcp-write-notification.test.ts` 保持绿。但由于三个名字已声明进 `MCP_TOOL_ANNOTATIONS` / `MCP_TOOL_ERROR_CODES`（二者对 `McpGatewayToolName` 全量），凡把 `tools/list` 与该表对齐的挂载都必须注册它们，故 `mcp-tool-annotations.test.ts` 与 `mcp-error-vocabulary.test.ts` 的依赖包里也补上了 `draft`。

### AC4 取假形态：红行与恢复

把 `buildDraftSubmit` 中 `const result = await deps.control.send(...)` 换成伪造的 `{ok:true, runId:'fabricated-run', queued:false, queuedMessageUuid:null}`（并 `void caller;`），往返用例转红，红行逐字：

```
✖ (a)/(d) set→get is verbatim; submit goes through the one control send and lands a user turn
AssertionError [ERR_ASSERTION]: submit must go through the injected control service exactly once
ℹ pass 0
ℹ fail 1
```

恢复后原码重跑绿（`pass 3 / fail 0`）。红读数存 `/tmp/ac4-red.log`，恢复读数存 `/tmp/ac4-green.log`。

### AC5 的 pin 同步

新增两个 server 测试文件使 `quay-test-script.test.ts` 的 `unknown=` 计数从 251/253 变为 252/254（collected 共 255）；两处 pin 均已同步，该文件 11 pass。

### DoD 读数（真实运行的服务）

一次性探针（跑完即删，未进入交付树）用 `scripts/mcp-smoke.mjs` 的 boot/seed/api/mcpConnect/callTool 助手起了一个**真服务进程**（`server/index.ts`，`MCP_ENABLED=1`、`DEBUG_AGENT=on` + 临时 `DEBUG_AGENT_HOME`、临时 `DATABASE_PATH`、`HOST=127.0.0.1`、`listen(0)` 端口 ≠ 3001），经 `POST /api/debug-agent/scenarios` 武装两个**真实会话**，并用一个独立 tsx 子进程为**同一个用户**播种了一个 PAT（`cloudcli:read` + `cloudcli:session:send`）与一条同用户 JWT。读数：

1. PAT 经 `/mcp` 列表出 `draft_get, draft_set, draft_submit`。
2. `draft_set` 对真实会话返回逐字文本；`draft_get` 逐字返回同一文本。
3. **输入框的数据源** `GET /api/user/drafts`（浏览器重开会话即从此水合）返回 `{scope:<session>, text:<同一文本>, queuedMessage:null}` —— 「输入框能看到该文本」。
4. `draft_submit` 返回 `{runId, source:'mcp'}`。
5. 会话转录经 `GET /api/providers/sessions/:id/messages` 出现 `role:'user'` 且 content 即该文本的轮次。
6. 同端点再读，该会话草稿已清空（`null`）。
7. **与用户键入发送无异**：在**同一真服务**上经产品自己的 `chat.send` WebSocket 对第二个真实会话键入发送，两条 `role:'user'` 轮次逐字段相等（仅 id/uuid/时间戳这些逐行身份不同）——`shape(mcp-submitted) === shape(user-typed)`。

完整读数存 `/tmp/dod-draft-final.log`。
