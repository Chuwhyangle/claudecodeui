---
id: gap-mcp-correlation-id-write-tools-and-filters
title: AC-337：写工具可选 correlationId 关联标签，记入 run
  元数据与审计，sessions_list/mcp_usage_stats 可按它过滤（无新实体/无调度）
status: ready
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

- [x] AC-337 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts`，覆盖 (a)–(e)。
- [x] 取假：`recordMcpToolCall` 的记录路径不传 `correlationId`（变量存在但没接上）⇒ (b)(c) 必须红；记录变异 diff、失败行与恢复命令。
- [x] 静态复核（写进完成记录，不是自动化判据）：`git diff` 本任务改动里 `grep -n "setInterval\|setTimeout\|new .*Scheduler\|cron"` 为空，佐证 (d)。
- [x] 下列既有判据逐文件运行退出码 0：`mcp-session-send.test.ts`、`mcp-session-lifecycle.test.ts`、`mcp-approvals.test.ts`、`mcp-ui-navigate*.test.ts` 一类、`mcp-read-tools.test.ts`、`mcp-usage-stats.test.ts`（AC-334 已引入列的那份）、`mcp-invalid-argument.test.ts`。
- [x] `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。用同一个 `correlationId` 调两次 `session_send`（不同 session）与一次 `mcp_usage_stats`，确认：`sessions_list {correlationId:...}` 只返回那两个会话；`mcp_usage_stats {groupBy:"tool", correlationId:...}` 只聚合这几次调用；超长/非法字符的 `correlationId` 报 `INVALID_ARGUMENT`。逐字记录请求与响应摘要。仅有测试夹具通过不算完成。

## 完成记录（AC-337，2026-10-12）

**AC #1 —— 判据。** `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts` → 退出码 0，8 个 leg 全绿，覆盖 (a) `tools/list` 广告、(a2) 生产装配把 run registry 整袋交给写工具、(b)/(b2) run 与审计行落标签、(c)/(c2) 两个读过滤、(d) 不推进任何状态、(e) 非法/越界标签。

**AC #2 —— 取假（两条臂，各记录变异点、失败行与恢复命令）。**
- 臂 1（审计路径）：把 `recordMcpToolCall` 的记录路径改成不接 `correlationId`（变量存在但不传）⇒ 4 pass / 3 fail，`(b)`、`(c)`、`(e)` 全红（`the run the send opened must carry the label` / `the filter must narrow total to the labelled sessions` / `a legal label is stored verbatim`）。恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-gateway.audit.ts server/modules/mcp-gateway/mcp-gateway.write-tools.ts`；恢复后工作树干净。
- 臂 2（registry 路径）：把 `ChatRun` 的标签写入点退回不写 ⇒ 3 pass / 4 fail，`(b)`、`(c)`、`(d)`、`(e)` 全红（同上三条 + `the label is stored verbatim and never rewritten`）。恢复命令：`git checkout -- server/modules/mcp-gateway/mcp-session-send.ts`；恢复后确认 stamp 调用点在原位（`mcp-session-send.ts:447`）。

**AC #3 —— 静态复核（佐证 (d)）。** 对 `git diff develop...HEAD` 与未提交 diff 同时 `grep -nE "setInterval|setTimeout|new .*Scheduler|cron"`，均为空（exit 1）。本任务不改动任何调度器、不新增定时器/后台循环，也没有任何「读到 `correlationId` 就推进状态」的路径：标签只有写入点（registry / 审计列）与两个读过滤，读写之外无分支。

**AC #4 —— 既有判据。** 22 份判据文件逐份单文件运行（`/tmp/ac337-dod/criteria.sh`，顺序、单文件、非 `--test` 扇出），全部退出码 0：含 `mcp-session-send.test.ts`、`mcp-session-lifecycle.test.ts`、`mcp-approvals.test.ts`、四个 `mcp-ui-*.test.ts`、`mcp-read-tools.test.ts`、`mcp-usage-stats.test.ts`、`mcp-invalid-argument.test.ts` 等既有面；`server/shared/tests/quay-test-script.test.ts` 11/11；运行后无进程残留。

**AC #5 —— typecheck。** `npm run typecheck` → 退出码 0。

**DoD —— 真实服务实例上一次实际操作（退出码 0）。** 驱动：`/tmp/ac337-dod/run.mjs`，import 工作树的 `scripts/mcp-smoke.mjs` 的 `bootServer`（临时 `DATABASE_PATH=/tmp/ac337-dod-*/auth.db`、`HOST=127.0.0.1`、`listen(0)` 得到随机端口），**未重启、未改动 :3001 上运行的 CloudCLI 服务**。打标签 `fleet-7f3a`，session A/B 各一次 `session_send`，session C 不打标签作对照。逐字读数：

- `REQ  {"tool":"sessions_list","arguments":{"correlationId":"fleet-7f3a"}}`
  `RESP {"sessions":[{"id":"ae272855-6f24-4cb1-8ce9-3b93a99d7183",…},{"id":"7e55fc0b-1173-4d0d-b2e4-32ce664d309b",…}],"total":2}` —— 恰为 A、B 两个会话。
- 不带过滤的 `sessions_list` → `total:3`（含未打标签的 C，证明过滤是真的在收窄而非恒空）；`correlationId:"no-such-label"` → `{"sessions":[],"total":0}`。
- `REQ  {"tool":"mcp_usage_stats","arguments":{"groupBy":"tool","correlationId":"fleet-7f3a"}}`
  `RESP {"groupBy":"tool","correlationId":"fleet-7f3a","total":2,"groups":[{"key":"session_send","n":2,"ok":2,"error":0,"denied":0,"p50":14,"p95":16,"max":16,"bytesP50":120,"bytesP95":120}]}` —— 只聚合这 2 次带标签调用；不带过滤时 `total` 更大。
- 非法/超长标签 5 例（129 字符、`""`、`bad/label`、`bad label`、`lab🚀el`）→ `isError:true`，`structuredContent.code === "INVALID_ARGUMENT"`，`structuredContent.details.fields[0].path === "correlationId"`，problem 逐字为 `must be <= 128`（129）/ `must be >= 1`（空串）/ `Invalid string: must match pattern /^[A-Za-z0-9_.:-]+$/`（三个非法字符例）。注意 MCP 线上协议里 SDK 的 text block 只是非 JSON 摘要（`Invalid arguments for tool "session_send": correlationId.`），真正的信封在 `result.structuredContent` 上。
- 合法边界（长度 1 的 `a`、长度 128 的全 `z`、含 `_.:-` 的 `a_B.c:d-1`）被接受；对仍然空闲的 session C 的一次合法标签 `session_send` 返回了真实 `runId`，即「接受」是端到端现象而不只是「未被反驳」。

**DoD 附带发现并修复的生产装配缺口（判据补钉 leg (a2)）。** 首次在真实服务上跑时 `sessions_list {correlationId}` 恒返回空集，而 `mcp_usage_stats {correlationId}` 正常——任何夹具都测不出这一条，因为每个夹具都自己手写了 adapter。根因有两半：(1) `createMcpGatewayModule`（`mcp-gateway.transport.ts`）与 `server/index.ts` 把写工具那一袋 `runs` 收窄成了 `{ getRun }` 投影，喂不进标签；(2) 该 seam 的成员名曾写作 `setCorrelationId?`，而 `chatRunRegistry` 暴露的是 `setRunCorrelationId`，成员可选 ⇒ 失配被静默吞掉。已改为整袋交接 `chatRunRegistry`、并按 registry 的成员名寻址（`getRun` 本来就是同一约定），新增判据 leg (a2) 直接读 `createMcpGatewayModule` 的装配输出并断言 `seam === chatRunRegistry` 且经由它落下的标签真的进了 registry，把这个缺口钉住。

**两次 DoD 驱动自身的修正（记录，避免复现）。** 非法标签断言最初读 `r.json` 得 `null`（MCP 线上返回的是纯文本错误，不是 JSON），改为直接 `client.callTool` 并读 `raw.structuredContent`；`sessions_list` 的行字段是 `id` 不是 `sessionId`，最初的映射产出 `[null,null]`，已改正并补上第三个未打标签的对照会话，使「不带过滤 > 带过滤」成为真实读数。

## Touches

- scripts/suite-duration-baseline.tsv
- server/index.ts
- server/modules/mcp-gateway/mcp-approvals.ts
- server/modules/mcp-gateway/mcp-correlation-id.ts (new)
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/mcp-gateway/mcp-session-write-deps.ts
- server/modules/mcp-gateway/mcp-ui-focus-turn.ts
- server/modules/mcp-gateway/mcp-ui-navigation.ts
- server/modules/mcp-gateway/mcp-ui-open-session.ts
- server/modules/mcp-gateway/mcp-ui-open-task.ts
- server/modules/mcp-gateway/mcp-ui-show-diff.ts
- server/modules/mcp-gateway/mcp-usage-stats.ts
- server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts (new)
- server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-usage-stats.test.ts
- server/shared/tests/quay-test-script.test.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- tasks/gap-mcp-correlation-id-write-tools-and-filters.md（self）
