---
id: gap-mcp-session-get-past-recents-page-and-small-envelope-defects
title: MCP 小契约缺陷：session_get 认不出最近 200 名之外的会话；quay_snapshot 缺 project 报
  INTERNAL_ERROR；审计回看接口不带耗时
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-resolve-target-exact-precedence-and-strict-writes
---
## Proposal

**Finding（2026-10-11，MCP 网关只读审计，逐条读代码核实）：** 三个独立的小契约缺陷，都在既有工具内部，都不改工具集合与参数名。

1. **B1 `session_get` 只认最近 200 个会话。** `server/modules/mcp-gateway/mcp-gateway.read-tools.ts:633` 的 `readRecentSessionRows` 只取 `listRecentSessions(SESSION_LIST_PAGE_SIZE=200, 0)` 这一页。`buildSessionDetail`（`:699-704`）在这一页里 `find` 不到就抛 `SESSION_NOT_FOUND`。而解析闸 `resolveDeps.listSessions` 读的是**全部**未归档会话（`server/index.ts` 的注释写明「a valid session id that sits past the first page is still resolved」）。结果是：一个较老的会话被闸门正确解析成 id，却在 `session_get`（以及复用 `buildSessionDetail` 的 `ui_last_opened_session`）里报「不存在」，同一个 id 两种读数。
2. **B2 `quay_snapshot` 缺少 `project` 时报 `INTERNAL_ERROR`。** `inputSchema` 把 `project` 声明为可选（`read-tools.ts:1313`），处理函数里的 `readProjectArgument`（`mcp-overview-tools.ts:637-641`）对缺失或空串抛**普通 `Error`**。`toMcpErrorResult`（`mcp-error-envelope.ts:601-602`）把非 `McpToolError` 映射为 `INTERNAL_ERROR`，于是一个调用方参数错误被报成服务端故障，客户端会误判为可重试或服务异常。正确分类是 `INVALID_ARGUMENT`，并点名 `project`。
3. **B4 `/api/settings/mcp-audit` 不返回耗时。** `mcp_audit_log.duration_ms` 每次调用都会写入（`mcp-gateway.audit.ts`），但 `mcp-audit-route.ts` 的行投影没有这个字段，设置页和调用方无法回看一次调用花了多久。

**审计中撤回的一条（不做）：** `SELF_TARGET`、`MESSAGE_NOT_FOUND` 不在 `MCP_ERROR_CODES` 词表里，但这是设计如此：`mcp-error-envelope.ts:28-33` 写明服务自身的合法错误码原样透传、不改写成网关码。

**要交付：**

1. B1：`buildSessionDetail` 改为按 id 直接读这一个会话行（复用 sessions 模块 barrel 已有的按 id 读取能力，没有就在 `McpReadToolDeps.sessions` 上加一个按 id 的只读方法，并在生产与夹具里接上），不再依赖最近一页。行的投影（标题、provider、projectId、lastActivity）与现在逐字段一致。`sessions_list` 的分页语义**不动**（属 GOAL-027 AC-300）。
2. B2：`readProjectArgument` 改抛 `McpToolError(INVALID_ARGUMENT, …)`，details 点名 `project`。在 `tools/list` 的错误码声明里给 `quay_snapshot` 补 `INVALID_ARGUMENT`（若尚未声明）。**不**把 `project` 改成 schema 必填：那会改动 `mcp-invalid-argument.test.ts` 钉住的参数表与 schema 形状，超出本任务范围。
3. B4：审计路由每行增加 `durationMs`（数字或 null），既有字段不变。
4. **不新增 `server/**/*.test.ts` 文件**：断言写进既有的 `mcp-read-tools.test.ts`（B1）、`mcp-overview.test.ts`（B2）、`mcp-audit-route.test.ts`（B4），不移动测试文件计数钉。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 退出码 0。新增断言：夹具播种超过 200 个会话，最老的那个（不在最近一页内）用 id 调 `session_get` 成功，且字段与它在全量列表里的投影一致；改动前同一断言报 `SESSION_NOT_FOUND`（先写测试观察红，逐字记录失败行）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-overview.test.ts` 退出码 0。新增断言：`quay_snapshot {}` 与 `quay_snapshot {project:"   "}` 返回 `isError:true`，code 为 `INVALID_ARGUMENT` 而非 `INTERNAL_ERROR`（空白串的读数以实际经过解析闸后的结果为准，若闸门先报 `PROJECT_NOT_FOUND` 则如实断言该码，并在完成记录里说明）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit-route.test.ts` 退出码 0。新增断言：每行带数值型 `durationMs`，且等于库里该行的 `duration_ms`。
- [x] 下列既有判据逐文件运行退出码 0：`mcp-error-envelope.test.ts`、`mcp-english-only.test.ts`、`mcp-invalid-argument.test.ts`、`mcp-tool-annotations.test.ts`、`mcp-resolve-target.test.ts`。另外 `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。用真 PAT 经 `/mcp` 调：`session_get` 取一个排在最近 200 名之外的会话 id，成功；`quay_snapshot {}`，得到 `INVALID_ARGUMENT`。再用同一实例的 JWT 调 `GET /api/settings/mcp-audit?includeReads=1`，可见这几次调用的 `durationMs`。逐字记录请求与响应摘要。仅有测试夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/mcp-audit-route.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts
- server/modules/mcp-gateway/tests/mcp-audit-route.test.ts
- tasks/gap-mcp-session-get-past-recents-page-and-small-envelope-defects.md（self）
