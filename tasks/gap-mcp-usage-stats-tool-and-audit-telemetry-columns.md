---
id: gap-mcp-usage-stats-tool-and-audit-telemetry-columns
title: AC-334：mcp_audit_log 加 error_code/response_bytes/correlation_id
  三列，新增只读统计工具 mcp_usage_stats 按工具/错误码/调用方给出 p50/p95
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-334
---
## Proposal

**契约（AC-334，已在上一轮定稿并激活，本任务是其实现）：** 给 `mcp_audit_log` 补三列（迁移只加列，旧行保持可读），新增一个只读统计工具聚合这些列，且全程不落任何参数或返回正文。

**现状（代码核实）：**
- `server/modules/database/schema.ts` 的 `MCP_AUDIT_LOG_TABLE_SCHEMA_SQL` 定义 `mcp_audit_log(id, at, token_id, client_id, tool, args_digest, outcome, duration_ms, denied_scopes)`。`server/modules/database/migrations.ts:94-106` 有现成的「widen 一张已存在的表」范式（AC-286 的 `denied_scopes` 列，经 `addColumnToTableIfNotExists` 守卫），本任务照此范式加三列而不是另造迁移机制。
- 记录点是 `server/modules/mcp-gateway/mcp-gateway.audit.ts` 的 `createAuditedRunner`：四个 `recordMcpToolCall` 调用点——principal 为空（denied）、scope 不足（denied）、schema 校验失败（error）、成功（ok）、以及 catch 块（error 或 denied，取决于 `McpScopeDeniedError`）。
- `server/modules/mcp-gateway/mcp-gateway.read-tools.ts:106` 的 `MCP_STAGE3_READ_TOOLS` 与 `:1335`（`session_search`）、`:1405`（`quay_snapshot`）是新只读工具的注册范式（`cloudcli:read`，`:97` 的 `READ_SCOPE`）。

**要交付：**

1. **迁移**：`addColumnToTableIfNotExists` 依次加 `error_code TEXT`、`response_bytes INTEGER`、`correlation_id TEXT`，均可空，紧跟 `denied_scopes` 那条迁移之后，保持「widen 范式」的顺序惯例。`MCP_AUDIT_LOG_TABLE_SCHEMA_SQL`（新库的 `CREATE TABLE`）同步补上这三列，使新库与「老库+迁移」收敛到同一形状。
2. **记录**：`recordMcpToolCall` 的入参类型增加可选 `errorCode?: string | null` 与 `responseBytes?: number | null`（`correlationId` 暂不填，由 AC-337 的写工具负责传入；本任务只开列，不产出非空值——这是两条 AC 之间唯一需要协调的接口）。四个调用点：
   - denied（principal 为空、scope 不足）：`errorCode: 'INSUFFICIENT_SCOPE'`，`responseBytes: null`。
   - schema 校验失败：`errorCode: 'INVALID_ARGUMENT'`，`responseBytes: null`。
   - 成功：`errorCode: null`，`responseBytes` = 结果序列化后的字节数（`Buffer.byteLength(JSON.stringify(structuredContent ?? toTextContent(result)), 'utf8')`，跟返回给客户端的那份一致，不要另造一份摘要）。
   - catch 块：`toMcpErrorResult(error)` 已经算出信封；**只调用一次**，把它的 `structuredContent.code` 取出来同时用于记录和返回（现状是只在返回路径算一次，本任务让记录路径复用同一次计算，不重复 catch 逻辑）；`responseBytes: null`。
3. **只读工具 `mcp_usage_stats`**（新文件 `server/modules/mcp-gateway/mcp-usage-stats.ts`，不塞进 `mcp-gateway.read-tools.ts`，理由：这个工具的实现是纯 SQL 聚合，不依赖 `McpReadToolDeps` 的任何服务，独立成文件更符合「不深层 import」的既有惯例，注册仍走 `MCP_STAGE3_READ_TOOLS` 同一张表）：
   - 输入 `{since?: ISO8601, until?: ISO8601, groupBy: 'tool'|'error_code'|'client'}`（`groupBy` 必填，不给默认值——「按什么分组」没有无害的默认）；
   - 查询 `WHERE token_id = :callerTokenId`（AC-334 (c) 的用户边界——按**调用令牌所属用户**过滤，不是按 `client_id`，因为同一用户可能用多个 client/PAT；`token_id` 要先 join `access_tokens.user_id` 取得 user id，再按 `access_tokens.user_id = :callerUserId` 过滤，这样同一用户的不同 token 聚合在一起）；
   - 输出每组 `{key, n, ok, error, denied, p50, p95, max, bytesP50, bytesP95}`，分位数用最近秩法（`a[ceil(p*n)-1]`，与 `mcp-resolve-target` 一类工具已经用过的同一手法一致）；
   - 需要 `cloudcli:read`。
4. 工具描述与所有新增用户可见文案为英文。

## AC

- [ ] AC-334 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-usage-stats.test.ts server/modules/mcp-gateway/tests/mcp-audit.test.ts`，覆盖契约 (a)–(e)。读数 (c)（跨用户不混聚）与 (d)（正文搜不到标记串）须各自对应一条断言，不能只靠综合读数带过。
- [ ] 取假形态各一条，记录变异 diff、逐字失败行与恢复命令：让统计按 `client_id` 而非 `access_tokens.user_id` 过滤 ⇒ (c) 必须红（同用户两个 token 的调用被错误地分到两组，或跨用户聚合）；把 `args` 原文而非摘要写进任何记录字段 ⇒ (d) 必须红。
- [ ] 下列既有判据逐文件运行退出码 0：`mcp-read-tools.test.ts`、`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-tool-annotations.test.ts`、`mcp-audit-route.test.ts`、`server/shared/tests/quay-test-script.test.ts`（新注册工具与新测试文件各自的计数钉）。
- [ ] `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。播种两个用户各一个 PAT，各自调用几次不同工具（含一次带标记串的 `session_send`），经 `/mcp` 用用户 A 的 PAT 调 `mcp_usage_stats {groupBy:"tool"}`：只看到用户 A 自己的调用，总数与分位数与库里过滤后的行吻合；响应体与同一服务的 `mcp_audit_log` 行里都搜不到那个标记串。逐字记录请求与响应摘要。仅有测试夹具通过不算完成。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/mcp-usage-stats.ts（new）
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/tests/mcp-usage-stats.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-audit.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/mcp-gateway/tests/mcp-tool-annotations.test.ts
- server/modules/mcp-gateway/tests/mcp-audit-route.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-usage-stats-tool-and-audit-telemetry-columns.md（self）
