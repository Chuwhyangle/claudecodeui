---
id: gap-mcp-changes-session-keyset-asc-paging-no-loss
title: AC-347：changes 的 session 增量改为升序键集分页、项目过滤下推 SQL，消除 DESC LIMIT 与过滤后置导致的漏读
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-347
---
## Proposal

**Finding（2026-10-12，读代码核实，证据见 docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11b D3）：** `changes` 的 session 来源会漏读，违反 AC-335 承诺的「至少一次投递」。

- `server/modules/database/repositories/sessions.db.ts:1128-1139` 的 `getSessionsUpdatedSince(sinceIso, limit)` 是全局查询，并且是 `ORDER BY julianday(...) DESC, session_id DESC LIMIT ?`：窗口内较早的行被直接截掉。
- `server/modules/mcp-gateway/mcp-changes.ts` 的 `buildChanges` 拿到这批「最新的 limit 行」后再按升序排序，`truncated` 只看候选事件数是否超过 `limit`。
  - 窗口内行数恰好等于 `limit`、且没有其他事件时：`truncated=false`，水位跳到 `observedAt`，被截掉的较早行永久丢失。
  - 即使判定截断：水位取「最后发出的事件时间 − 1」，而未读的较早行都在这个时间之前，同样丢失。
- 项目过滤 `inScope` 在 LIMIT 之后才在 JS 里执行：限定单个项目时，其他项目的会话可以占满 limit，结果返回 0 行，水位却照样推进。
- `server/index.ts:360-368` 是生产接线（`listUpdatedSince`）。

**要交付（低风险、独立，只动 session 这一条路径）：**

1. 新的仓储读取：按 `(julianday(COALESCE(updated_at, created_at)), session_id)` **升序**键集取 `limit + 1` 行，用第 `limit+1` 行是否存在来判断「来源还有剩余」。可选的项目过滤（project_path 集合）在 SQL 的 `WHERE` 里做。旧方法 `getSessionsUpdatedSince` 若无其他消费者就替换，有则保留；用 grep 确认后在完成记录里写明。
2. `buildChanges`：session 来源有剩余时，响应 `complete=false`；下一页从会话键集位置继续。
   - cursor 增加 session 键集位置，例如 `sessionKey: {atMs, sessionId}`，并把版本号升为 v2。
   - v1 的 cursor 仍须被接受，按其 watermark 作为起点（AC-347 (e)）。
   - 其他来源（run、approval、quay）的水位语义不变；任一来源截断都不得让其他来源跳过未读事件。实现可以选择「session 有剩余时整体水位不越过 session 的键集位置」，在完成记录里说明所选不变式。
3. `server/index.ts` 的 `listUpdatedSince` 接线同步改为新读取。注意：`createMcpGatewayModule` 是否会覆盖这一组依赖，要按记忆 create-mcp-gateway-module-overwrites-readtools-projects 与 production-assembly-narrowed-seam-hidden-by-fixtures 核对，并用真服务 DoD 证明生产装配走的是新路径。
4. 只增字段，旧字段语义不变；不动 Quay 来源（那是 `gap-mcp-changes-quay-status-index-async-bootstrap` 的范围）。

## AC

- [ ] **红先行**：先写新判据文件 `server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts`。在实现前的代码上运行，AC-347 读数 (a)(b)(c) 必须红，逐字记录失败行。
- [ ] AC-347 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts server/modules/mcp-gateway/tests/mcp-changes.test.ts`，覆盖 (a)–(f)。
- [ ] 取假形态 (i)–(iii) 逐条执行，记录变异 diff、逐字失败行与恢复命令。
- [ ] 下列既有判据逐文件串行运行（tsx runner，`scripts/with-memory-cap.sh`）退出码 0：`mcp-changes.test.ts`、`mcp-read-tools.test.ts`、`mcp-error-envelope.test.ts`、`mcp-english-only.test.ts`、`mcp-invalid-argument.test.ts`、`server/shared/tests/quay-test-script.test.ts`（新测试文件会移动其计数钉，按惯例同步，并在 `scripts/suite-duration-baseline.tsv` 追加行）。另外 `npm run typecheck` 退出码 0。不跑全量并行套件。

## DoD

在真实服务实例上实际操作（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得 build/restart 生产服务，不得占用正在运行的 Live Voice 任务资源**）。

- 播种两个项目：项目 A 有 60 个会话，项目 B 在同一窗口内有 200 个更新的会话。
- 经 `/mcp` 用真 PAT：
  - `changes {projects:[A], kinds:["session"], limit:50}` 沿 cursor 翻页，记录每页事件数与 `complete`，确认 A 的 60 个会话全部出现且各出现一次；
  - 不限项目的同样翻页，确认 260 个会话不重不漏。
- 记录改动前后（develop 基线 vs 本分支）的对照读数，以及 changes 单次调用耗时的 p50/p95（各 20 次）。

仅有测试夹具通过不算完成；完成记录必须包含这一节。

## Touches

- server/modules/database/repositories/sessions.db.ts
- server/modules/mcp-gateway/mcp-changes.ts
- server/index.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-changes.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-changes-session-keyset-asc-paging-no-loss.md（self）
