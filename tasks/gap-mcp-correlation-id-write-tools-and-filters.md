---
id: gap-mcp-correlation-id-write-tools-and-filters
title: AC-337：写工具可选 correlationId 关联标签，记入 run
  元数据与审计，sessions_list/mcp_usage_stats 可按它过滤（无新实体/无调度）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-usage-stats-tool-and-audit-telemetry-columns
goal_ac: AC-337
---
## Proposal

**契约（AC-337，已在上一轮定稿并激活，本任务是其实现）：** 关联标签只做可选字段，不做实体。

**⚠️ 前置依赖（技术性，非仅排序偏好）：** 本任务的 (c) 读数要求 `mcp_usage_stats` 接受 `correlationId` 过滤——这个工具由 `gap-mcp-usage-stats-tool-and-audit-telemetry-columns`（AC-334）新增，且 `mcp_audit_log.correlation_id` 列也是那个任务开的。本任务必须在它之后落地，`depends_on` 已经这样声明。

**现状（代码核实）：**
- `server/modules/websocket/services/chat-run-registry.service.ts:55-68` 的 `ChatRun` 没有关联标签字段；`listRunningRuns()`（`:511`）与 `getRun(appSessionId)`（`:482`）是读它的两个口子，`McpReadToolDeps.runs` 就是这同一个 `chatRunRegistry`（见 `server/index.ts` 的 `mcpReadToolDeps.runs: chatRunRegistry`）。
- 写工具的参数在 `mcp-session-write-deps.ts`、`mcp-session-lifecycle.ts`、`mcp-approvals.ts`、`mcp-ui-navigation.ts` 几个文件里各自声明 `inputSchema`。

**要交付：**

1. `ChatRun` 增加 `correlationId: string | null`（默认 `null`）。`listRunningRuns()` 与 `getRun` 的返回类型同步带出这个字段（只增字段）。
2. `session_send`、`session_create`、`approval_answer`、三个 `ui_*` 写工具的 `inputSchema` 增加可选 `correlationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional()`（字符集与长度见 AC-337 (a)(e)；未传入时整条链路行为与现在逐字一致）。工具描述写明「这是一个不透明的关联标签，不是一个会被服务端解释或推进的实体」。
3. 启动 run 时（`session_send`/`session_create` 对应的 `startRun`/`beginRun` 一类调用点），把 `correlationId` 原样写进 `ChatRun`；`approval_answer` 与 `ui_*` 工具本身不开新 run，它们只把 `correlationId`（若提供）转记进对应调用的审计行（下一条）。
4. 任何写工具调用都把 `correlationId`（提供时）透传给 `recordMcpToolCall`，落进 AC-334 新开的 `mcp_audit_log.correlation_id` 列。不提供时该列保持 `null`（AC-334 本来就只开列不产出非空值，这一步正是补上产出方）。
5. `sessions_list` 增加可选 `correlationId` 过滤：**不新建任何持久化表或 join**——按 `deps.runs.listRunningRuns()` 里 `correlationId` 匹配的那些 `appSessionId` 收窄结果集（内存态、随进程重启清零，与其余 run 状态同一寿命，这正是 D4「不做独立实体」的落地方式，不是遗漏）。`mcp_usage_stats` 增加可选 `correlationId` 过滤，直接按 AC-334 开的那一列做 `WHERE`。
6. 全程不新增定时器、不新增后台循环、不新增任何读取 `correlationId` 并据此自动推进状态的代码路径（AC-337 (d) 的硬约束——复核时专门 grep 一遍新增代码里有没有 `setInterval`/`setTimeout`/一个新的 while 循环）。

## AC

- [ ] AC-337 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts`，覆盖 (a)–(e)。
- [ ] 取假：`recordMcpToolCall` 的记录路径不传 `correlationId`（变量存在但没接上）⇒ (b)(c) 必须红；记录变异 diff、失败行与恢复命令。
- [ ] 静态复核（写进完成记录，不是自动化判据）：`git diff` 本任务改动里 `grep -n "setInterval\|setTimeout\|new .*Scheduler\|cron"` 为空，佐证 (d)。
- [ ] 下列既有判据逐文件运行退出码 0：`mcp-session-send.test.ts`、`mcp-session-lifecycle.test.ts`、`mcp-approvals.test.ts`、`mcp-ui-navigate*.test.ts` 一类、`mcp-read-tools.test.ts`、`mcp-usage-stats.test.ts`（AC-334 已引入列的那份）、`mcp-invalid-argument.test.ts`。
- [ ] `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。用同一个 `correlationId` 调两次 `session_send`（不同 session）与一次 `mcp_usage_stats`，确认：`sessions_list {correlationId:...}` 只返回那两个会话；`mcp_usage_stats {groupBy:"tool", correlationId:...}` 只聚合这几次调用；超长/非法字符的 `correlationId` 报 `INVALID_ARGUMENT`。逐字记录请求与响应摘要。仅有测试夹具通过不算完成。

## Touches

- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/mcp-gateway/mcp-session-write-deps.ts
- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/mcp-approvals.ts
- server/modules/mcp-gateway/mcp-ui-navigation.ts
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-usage-stats.ts
- server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-usage-stats.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-correlation-id-write-tools-and-filters.md（self）
