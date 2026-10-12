---
id: gap-mcp-changes-session-keyset-asc-paging-no-loss
title: AC-347：changes 的 session 增量改为升序键集分页、项目过滤下推 SQL，消除 DESC LIMIT 与过滤后置导致的漏读
status: ready
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

- [x] **红先行**：先写新判据文件 `server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts`。在实现前的代码上运行，AC-347 读数 (a)(b)(c) 必须红，逐字记录失败行。
- [x] AC-347 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts server/modules/mcp-gateway/tests/mcp-changes.test.ts`，覆盖 (a)–(f)。
- [x] 取假形态 (i)–(iii) 逐条执行，记录变异 diff、逐字失败行与恢复命令。
- [x] 下列既有判据逐文件串行运行（tsx runner，`scripts/with-memory-cap.sh`）退出码 0：`mcp-changes.test.ts`、`mcp-read-tools.test.ts`、`mcp-error-envelope.test.ts`、`mcp-english-only.test.ts`、`mcp-invalid-argument.test.ts`、`server/shared/tests/quay-test-script.test.ts`（新测试文件会移动其计数钉，按惯例同步，并在 `scripts/suite-duration-baseline.tsv` 追加行）。另外 `npm run typecheck` 退出码 0。不跑全量并行套件。

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

## 完成记录

Worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-mcp-changes-session-keyset-asc-paging-no-loss`（branch `task/gap-mcp-changes-session-keyset-asc-paging-no-loss`），实现提交 `b2adb54e`。

### 1. 新仓储读取与接线

- `sessionsDb.getSessionsUpdatedSince` 的消费者只有一处（`server/index.ts` 的 `changes` 接线，旧行号 360-368，grep 全仓确认无第二处），故**替换**为 `getSessionsUpdatedSinceKeyset(after, projectPaths, limit): { rows, hasMore }`：`WHERE` 里做 `project_path IN (...)`（`projectPaths === null` 表示不限项目；空数组直接返回空页），谓词用 `julianday(COALESCE(updated_at, created_at))`，排序 `ASC, session_id ASC`，取 `limit + 1` 行，第 `limit+1` 行存在即 `hasMore`。`julianday('2026-03-01 00:00:00')` 与 `julianday('2026-03-01T00:00:00.000Z')` 实测都等于 `2461100.5`，两种时间戳格式的相等比较安全。
- `mcp-changes.ts`：`McpChangesDeps.sessions.listUpdatedSince` → `listChangedSince(after: {atMs, sessionId|null}, projectIds: string[]|null, limit): { rows, hasMore }`；cursor 版本字节升为 `2`，并新增 `MCP_CHANGES_LEGACY_CURSOR_VERSIONS = new Set([1, 2])`，`McpChangesCursor` 增 `sessionKey: {atMs, sessionId} | null`。
- `server/index.ts` 接线改为 `listChangedSince` → `getSessionsUpdatedSinceKeyset`（`projectIds` 经 `projectsDb.getProjectPathById` 映射为 path 并滤 null；`null` 表示 workspace 不过滤）。
- `mcp-gateway.transport.ts` 只更新注释（该模块对 `changes` 这袋依赖零覆盖，注释里点明读的是新的升序键集读取）。

### 2. 所选不变式

session 来源改为**升序键集分页**，其余来源（run / approval / quay）水位语义不变。`truncated = candidates.length > input.limit || sessionsHaveMore`（任一成立即 `complete=false`），`emitted` 仍按合并排序切前 `limit` 条；`nextCursor.sessionKey` 取**本页最后一个发出的 session 事件**的 `(atMs, sessionId)`，本页没发出 session 就沿用传入 cursor 的 `sessionKey`。v1 cursor（无 `sessionKey`）被接受，归一化为 `sessionKey: null`，按 watermark 起点读取。

### 3. 红先行（AC 第 1 条）

实现前，在新判据文件上运行：

```
TypeError: deps.sessions.listUpdatedSince is not a function
    at buildChanges (.../server/modules/mcp-gateway/mcp-changes.ts:465:32)
ℹ tests 5
ℹ pass 0
ℹ fail 5
```

(a)(b)(c)(d)(e) 全部红。

### 4. AC-347 判据逐字运行退出码 0（AC 第 2 条）

```
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts \
  server/modules/mcp-gateway/tests/mcp-changes.test.ts
```
→ exit 0，`ℹ tests 12 / pass 12 / fail 0`（新判据 (a)–(e) 5 条 + sibling `mcp-changes.test.ts` 7 条，含 (f) 非法 cursor）。

### 5. 假形态 (i)–(iii)（AC 第 3 条）

- **(i) `ORDER BY DESC`**（模拟原 `DESC … LIMIT`）：
  ```
  -         ORDER BY ${instant} ASC, session_id ASC
  +         ORDER BY ${instant} DESC, session_id DESC
  ```
  逐字失败行：`AssertionError [ERR_ASSERTION]: paging must expose all 60 distinct sessions` / `actual: 50` / `expected: 60`（整文件 5 条同时红）。恢复：把两个 `ASC`/`DESC` 换回。
- **(ii) 项目过滤后置到 LIMIT 之后**（模拟 `inScope` 在 JS 里跑）：
  ```
  -    const page = deps.sessions.listChangedSince(after, input.projects ?? null, input.limit);
  -    for (const row of page.rows) {
  +    const page = deps.sessions.listChangedSince(after, null, input.limit);
  +    for (const row of page.rows) {
  +      if (!inScope(row.projectId)) { continue; }
  -  const truncated = candidates.length > input.limit || sessionsHaveMore;
  +  const truncated = candidates.length > input.limit;
  ```
  逐字失败行：`AssertionError [ERR_ASSERTION]: the scoped page must be full of A sessions, not emptied by B` / `30 !== 50`（(c) 自己的断言）。恢复：还原读取时的项目 scoping、删掉 JS 过滤、恢复 `|| sessionsHaveMore`。
- **(iii) 键集丢掉 `sessionId` 次序**（同一 `updatedAt` 只按瞬间前进）：
  ```
  -      conditions.push(`(${instant} > julianday(?) OR (${instant} = julianday(?) AND session_id > ?))`);
  -      params.push(after.atIso, after.atIso, after.sessionId);
  +      conditions.push(`${instant} > julianday(?)`);
  +      params.push(after.atIso);
  ```
  逐字失败行：`AssertionError [ERR_ASSERTION]: all 60 same-instant sessions must be reachable` / `50 !== 60`（只有 (d) 红，(a)(b)(c)(e) 仍绿）。恢复：还原 OR 子句与三个参数。
  三条假形态跑完后均已还原，工作树干净、判据复绿。

### 6. 既有判据串行 + typecheck（AC 第 4 条）

`scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test <file>` 逐文件串行，全部 exit 0：

| 文件 | tests | pass |
|---|---|---|
| mcp-changes.test.ts | 7 | 7 |
| mcp-read-tools.test.ts | 8 | 8 |
| mcp-error-envelope.test.ts | 7 | 7 |
| mcp-english-only.test.ts | 10 | 10 |
| mcp-invalid-argument.test.ts | 4 | 4 |
| server/shared/tests/quay-test-script.test.ts | 11 | 11 |

`npm run typecheck` exit 0（三条 tsc 全过）。
计数钉同步：新增测试文件后 `find server … | sort` 由 304 → 305，`quay-test-script.test.ts` 的 `known=1 unknown=303 → 304`、`known=3 unknown=301 → 302`；`scripts/suite-duration-baseline.tsv` 追加 `5133\tserver/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts` 并把头注覆盖率改为 `277/305`。跨模块 mock 同步：`mcp-english-only.test.ts` 的 `changes` 依赖袋也改为 `listChangedSince`。

### 7. 真服务 DoD（AC DoD 节）

脚本：临时根 `mktemp -d`，`bootServer({tempRoot})`（真 `server/index.ts`，`DATABASE_PATH=<tmp>/auth.db`，`freePort()` 上 `listen(0)`，`MCP_ENABLED=1`），`seedAccessToken` 起独立子进程经 `accessTokensService.issueToken` 铸真 PAT（scope `cloudcli:read`），再用另一个子进程经 `sessionsDb.createSession` 播 A 60 / B 200 个会话（B 的一律更新），最后用 MCP SDK 客户端经 `/mcp` 翻页。**未 build/restart 生产服务，未占用 Live Voice 资源。**

本分支（`b2adb54e`）：

```
scoped  pages=2 perPage=[50,10] complete=[false,true]
scoped  events=60 distinct=60 dups=0 foreign=0
unscoped pages=6 perPage=[50,50,50,50,50,10] complete=[false,false,false,false,false,true]
unscoped events=260 distinct=260 dups=0
unscoped a=60 b=200
latency n=20 p50=14.40ms p95=23.87ms min=11.55 max=23.87
VERDICT PASS
```

对照基线（同一工作树内把两处文件还原成 develop 的 pre-fix 形态——`DESC` 排序、项目过滤后置为 LIMIT 之后的 JS 过滤、`truncated` 只看候选数——只变这一个变量）：

```
scoped  pages=1 perPage=[0] complete=[true]      ← 项目 A 的 60 个会话一个都没返回，却自称 complete
unscoped pages=1 perPage=[50] complete=[true]    ← 只返回 B 最新的 50 条，其余 210 条永久丢失
VERDICT FAIL
```

生产装配证据：DoD 起的服务就是生产入口 `server/index.ts`（transport 的 spread 不覆盖 `changes` 依赖袋），所以上面读到的新路径就是生产接线实际走的路径；夹具不会造成差异。

### 8. 备注

- 未动 Quay 来源（`gap-mcp-changes-quay-status-index-async-bootstrap` 范围）。
- `sessions.projectForSession`、run/approval/quay 的 watermark 语义未变。

## Blocker

**2026-10-12T08:52:49.877Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-mcp-changes-session-keyset-asc-paging-no-loss — 1 violation(s)
- run_id：wk-prod-anchor
- session_id：d2e75f9e-7ad3-474c-ac7e-5ffe1a148659
