---
id: gap-mcp-changes-on-demand-event-stream
title: AC-335：新增只读工具 changes 按需增量变化流——不透明游标、跨项目、signal 分活性/进展/阻塞，每条带 source
  与新鲜度，bootId 变化如实报 gaps
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-335
---
## Proposal

**契约（AC-335，已由 goal-driver 机械 triage 激活；契约在 `docs/proposals/cloudcli-mcp-control-observability-2026-10.md` §4「阶段 1a」定稿，本任务是其实现）：** 新增一个只读工具 `changes`（`cloudcli:read`），按需计算自上次游标以来的变化，用一个 `projects` 参数**同时**覆盖 workspace 与 project 两种作用域（不拆成两个工具）。它是本讨论用来替代「每两次写之间轮询一遍 sessions_list / session_get」的增量读面。

**现状（代码核实）：**
- 注册面：`server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 的 `MCP_STAGE3_READ_TOOLS`（`:106`）是「stage-3 有哪些只读工具」的唯一声明；`registerMcpReadTools`（`:1475`）按 name 表安装。新增一个只读工具**必然**要同步改三处：该表、`mcp-tool-annotations.ts`、`mcp-tool-error-codes.ts`（后两者对 name 并集是全的），并同步带尺寸钉的既有判据（`mcp-read-tools.test.ts` 的 `registered.length == 12`、`mcp-invalid-argument.test.ts` 的每工具声明参数表等）。
- 会话来源：`server/modules/database/repositories/sessions.db.ts` 的 `sessions` 表带 `updated_at`（watcher 维护）。现状只有 `getAllSessions` 等全量/分页读；需要给该仓储加一个「按 `updated_at > ?` 排序 + 限量」的读取方法用于增量取。**本任务不新增索引**——`sessions.updated_at` 的索引由同批的 `gap-mcp-session-search-time-pruning-and-stable-cursor` 在其改动里补（其任务体明确要求 AC-335 复用它、不要重复建）。
- 运行态来源：进程内 `chatRunRegistry`（`server/modules/websocket/services/chat-run-registry.service.ts`）持有 run，每条 run 带创建时的 `bootId`（`:67`、`:386`）；网关已通过 `runGet.deps.runs` / `readTools.runs` 拿到同一个它。
- 审批来源：`chatControl.pendingApprovals`（`mcp-approvals.ts` 的 `McpApprovalsDeps.control` 已是同一条通道）。
- Quay 来源：`McpQuayRunner.readCached`（`mcp-overview-tools.ts:74`，**cache-only、绝不 spawn**）——`changes` 只允许读缓存。
- bootId：进程只有一个 `BOOT_ID`（`activity-heartbeat.service.ts` 拥有，`activity-protocol.service.ts` 与 `run_get` 都复用它）。`changes` 的 `bootId` 必须复用这同一个，不得另造第二个计数器（§10：「可复用活动协议的 `bootId` 与 rev，不另造」）。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：于 `tasks/*.md` 对 `变化流` / `changes 工具` / `bootId`+游标 逐个 grep，0 条命中「MCP 按需 changes 增量流」这一机制；最接近的是 `gap-activity-protocol-snapshot-rev`（AC-193，浏览器活动坞的 rev 协议，done）——那是**客户端订阅**协议的 rev，本任务是**服务端按需拉取**的事件流，机制不同，但**必须复用其 `bootId` 与 rev**。`task-granularity-advice.js` 报 peers：`gap-mcp-usage-stats-tool-and-audit-telemetry-columns`(ready)、`gap-mcp-session-search-time-pruning-and-stable-cursor`(ready)、`gap-mcp-correlation-id-write-tools-and-filters`(todo)（共 `mcp-gateway.read-tools.ts`——每个新增只读工具都要改这张表）与 `gap-live-voice-voice-terminated-interrupt`(ready)、`gap-mcp-deploy-freshness-build-sha-health-check`(ready)（共 `server/index.ts` 装配）。**决定：separate**——各自独立的 AC 与验收；共享的只是「新增只读工具必然要编辑的注册表/全量映射/装配点」，调度器按 Touches 串行化，合并不省并行度却会混淆验收。

**要交付：**

1. 新模块 `server/modules/mcp-gateway/mcp-changes.ts`，导出 `buildChanges(input, ctx, deps)` 与注册描述符/schema。输入：`cursor?`、`since?`(ISO8601)、`projects?`(string[])、`kinds?`(session|run|interaction|quay_task|quay_gate|commit 的子集)、`limit?`(1..200，默认 50)。输出：`cursor`、`generatedAt`、`bootId`、`complete`、`events[]`、`gaps[]`。每条 event：`kind`、`project:{id,title}`、`at`、`signal`(liveness|progress|blocked)、`ref`(sessionId?|runId?|taskId?|commit?)、`summary`（**不含消息正文**）、`source:{type:"db.sessions"|"mem.runs"|"mem.approvals"|"quay.cache"|"git", observedAt, ageMs}`。
2. **游标**：不透明的 `{v, watermark, bootId, perProjectHead}`（base64url 编码的 JSON，带版本字节）。投递语义 **at-least-once**：同一游标重复取结果可重复（可含重复事件）但**不遗漏**；调用方按 `(kind, ref, at)` 去重。**篡改或坏格式的游标报 `INVALID_ARGUMENT`**。
3. **signal 分类（核心正确性）**：会话新消息/活动 → `liveness`；run 开始与结束、Quay 缓存里任务 `status/updatedAt` 迁移 → `progress`；存在待审批（pending approval / run 停在 blocked） → `blocked`。分类必须与事件的事实来源一致，不得凭空猜。
4. **gaps（诚实性）**：当游标里的 `bootId` 与当前进程 `bootId` 不同时，返回 `gaps` 说明「此前内存中的 run 与审批变化不可见」，而不是假装 `complete:true`；Quay 缓存冷时在 `gaps` 里说明 `{kind:"quay_task", reason:"cache cold"}`（不 spawn CLI）。
5. **不触发重活**：`changes` 只读 watcher 维护的库、进程内 run/approval、Quay **缓存**；**不得**调用全量会话同步（`synchronizeSessions`），**不得**在冷缓存时 spawn Quay CLI。这些依赖全部注入，判据用计数 fake 断言调用计数为 0。
6. **装配**：`mcp-gateway.read-tools.ts` 的 `MCP_STAGE3_READ_TOOLS` 加 `changes`（`cloudcli:read`），同步 `mcp-tool-annotations.ts`、`mcp-tool-error-codes.ts`；`server/index.ts` 的 `mcpReadToolDeps` 与 `mcp-gateway.transport.ts` 的 `createMcpGatewayModule`（后者对齐 `readTools` 袋——注意该处曾整体覆盖 `projects` 丢字段的回归）绑定上述来源；`sessions.db.ts` 加按 `updated_at > ?` 的限量读方法。
7. 新增用户可见文案一律英文；新增服务端测试文件同步 `scripts/suite-duration-baseline.tsv` 与 `server/shared/tests/quay-test-script.test.ts` 的计数钉（若同批还有别的任务新增服务端测试文件，计数钉取并集 +2，见 `merge-both-branches-bump-same-count-pin`）。

## AC

- [ ] AC-335 判据逐字运行退出码 0：`for f in server/modules/mcp-gateway/tests/mcp-changes.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes.test.ts`，覆盖契约 (a)–(f)：
  - (a) 输入/输出形状逐字段：`limit` 1..200 且默认 50；event 的 `signal` 恰为三值之一；`source.type` 恰为命名集合之一；`summary` 不含消息正文（夹具带一条标记串的会话消息，`summary` 与整个响应里都搜不到该标记串）。
  - (b) 夹具依次造「会话新消息、run 开始、run 结束、一条待审批、Quay 缓存任务状态变化」，用上一次返回的 `cursor` 再取，恰好看到这些变化且每条 signal 正确（会话新消息=liveness、run 开始/结束=progress、任务状态迁移=progress、待审批=blocked）。
  - (c) 重复取同一 cursor 结果可重复但不遗漏（at-least-once 语义）。
  - (d) 游标里的 `bootId` 与当前不同时返回 `gaps`（说明此前内存 run/审批不可见），且 `complete` 不谎报为 true。
  - (e) 注入服务（全量会话同步、Quay CLI）调用计数为 0；Quay 冷缓存时在 `gaps` 里说明。
  - (f) 篡改的 cursor 报 `INVALID_ARGUMENT`。
- [ ] 取假一：把「会话新消息」的 signal 标成 `progress` ⇒ (b) 必须红；记录变异 diff、逐字失败行与恢复命令。
- [ ] 取假二：`bootId` 变化时不报 `gaps`（假装 `complete:true`）⇒ (d) 必须红；记录变异 diff、逐字失败行与恢复命令。
- [ ] 下列既有判据逐文件运行退出码 0：`server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`（stage-3 工具数钉 12→13）、`mcp-invalid-argument.test.ts`（新工具的声明参数表）、`mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts`、`mcp-english-only.test.ts`、`server/shared/tests/quay-test-script.test.ts`（服务端测试文件计数钉）。
- [ ] `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。播种若干会话并让 watcher 落库、起一个真 run、造一条待审批、预热一次 Quay 快照缓存；经 `/mcp` 调 `changes {}` 拿到首帧与 `cursor`，再改状态后带该 `cursor` 调第二次，逐帧确认刚好看到这些变化、每条 `signal` 正确、`source.observedAt/ageMs` 如实；再断言冷缓存路径在 `gaps` 里说明且未 spawn CLI。逐字记录请求与响应摘要。仅有测试夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-changes.ts（new）
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/database/repositories/sessions.db.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-changes.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
- server/modules/mcp-gateway/tests/mcp-tool-annotations.test.ts
- server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-changes-on-demand-event-stream.md（self）