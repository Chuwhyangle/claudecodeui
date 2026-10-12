---
id: gap-mcp-changes-quay-status-index-async-bootstrap
title: AC-348：changes 的 Quay 来源改为全覆盖紧凑状态索引 + 非阻塞去重限频异步加载 + bootstrap 只建基线 +
  状态与四种时间明示（修订 AC-335 (e)）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-changes-session-keyset-asc-paging-no-loss
goal_ac: AC-348
---
## Proposal

**Finding（2026-10-12，读代码核实 + 外部 Agent 实测，证据见 docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11b D1/D2/D5）：**

- **D1 覆盖率**：生产接线 `server/index.ts:401` 的 `readCachedTasks` 读的是 `snapshot.tasks.recent`，而它被 `QUAY_RECENT_LIST_LIMIT = 10` 截断（`server/modules/quay/quay.service.ts:109,600`）。排名第 10 之后的任务发生迁移，changes 看不见，却仍报告 `complete=true`。
- **D2 初始化即事件**：`server/modules/mcp-gateway/mcp-changes.ts:566-588` 在 `previous === undefined` 时就发出 progress 事件，`at` 取观测时刻，`ageMs` 取 now 与 updatedAt 之差。首次观测、真实迁移、数据时间、观测时间四者混用；同一次迁移每次读取 `at` 都不同，`(kind,ref,at)` 去重失效。
- **D5 TTL 即 cold**：快照缓存的 30 秒 TTL（`quay.module.ts:10`）一过期，`getCachedSnapshot` 就返回 `null`（`quay.service.ts:1466-1470`），changes 立刻报 cold。stale 与 cold 无法区分，complete 实际上几乎恒为 false。

**裁定（外部 Agent 2026-10-12，账本 §11c）：**
- E1：bootstrap 只建立基线，不发事件，并明确标记 bootstrap 与 coverage。
- E2：采用 B′，即非阻塞、去重、每项目最小间隔 60 秒、受资源预算约束的异步加载；不得同步等待，不得运行完整快照 CLI。**这修订了 AC-335 (e)**，修订文本记在 AC-348 与 AC-335 的 origin（`0993a114`）。
- E3：不引入 fs.watch。
- E4：`task list --json --no-body` 以精确参数序列纳入只读白名单。前置核实（账本 §11d）：5 个 Quay 项目全部 rc=0，216–405ms，输出不含 body，每行有 updatedAt，没有归因于 CLI 的写入。

**要交付：**

1. **白名单**：`QUAY_READ_ONLY_COMMANDS`（`quay.service.ts:486` 一带）只新增 `['task','list','--json','--no-body']` 这一条。`isReadOnlyQuayCommand` 保持逐字匹配，任何其他 flag 组合依旧拒绝。
2. **任务状态索引（quay 模块内，经 barrel 导出）**：
   - 每个项目维护一份 `{ tasks: Map<id, {status, updatedAt, title(截断到 80 字符)}>, observedAt, coverage:'full', taskCount }`。
   - 与 `snapshotCache` **分开存放，过期不清空**：超过新鲜度阈值（常量，建议 120 秒）就标为 stale 并继续提供上一份数据。
   - 状态机：`absent → loading → ready ↔ stale`，失败时为 `error`，并保留上一份数据。
3. **非阻塞加载 `requestTaskIndexLoad(projectId)`**：
   - 立即返回，不返回 Promise 给调用方去等待；
   - 同一项目只允许一个在途加载；
   - 每项目最小间隔 60 秒（时钟可注入）；
   - 全局并发上限（常量，建议 2）；
   - 超时沿用 `commandTimeoutMs`；
   - 输出体积设上限（常量，建议 8MB；quay 仓库实测为 1.36MB），超限时进入 error 状态，不写入半份数据。
4. **changes 的 Quay 段改为读取上述索引，按项目分情况：**
   - 无 `.quay/config.yml`：跳过，不出现在 `sources` 里。
   - 索引不存在：调用 `requestTaskIndexLoad`，`sources` 状态为 `cold` 或 `warming`，并在 `gaps` 里给出机器可读的 `state`。不发事件，cursor 中该项目的基线原样保留。
   - cursor 里还没有该项目的基线：状态为 `bootstrap`，以当前索引建立基线，**不发事件**。
   - 已有基线：做差异比较，产出三类事件——
     - 状态迁移：`transition:{from,to}`，`at` 取记录的 `updatedAt`，并标 `atSource:'record.updatedAt'`；
     - 基线之后出现的新任务：标记 `appeared`；
     - 消失的任务：标记 `removed`。
   - 每个事件都带 `source:{type:'quay.index', observedAt: 索引加载时刻, ageMs}`。
   - 索引处于 stale 时，照常 diff 并发出事件，同时报告 stale。
5. **输出只增字段**：`sources: [{kind:'quay_task', project, state:'ready'|'stale'|'cold'|'warming'|'bootstrap'|'error', coverage, taskCount, observedAt, ageMs}]`；事件新增可选字段 `transition`、`atSource`。
   - `complete = 没有任何 gap，且没有截断，且所有在作用域内的 Quay source 都是 ready`。
   - 旧字段的语义不变。`quay_snapshot`、`overview` 的行为不变。
6. **修订后的 AC-335 (e) 腿**：在 `mcp-changes.test.ts` 中移植并加强——`refreshQuay` 与 `synchronizeSessions` 仍为 0，另加「从不 await 加载器」的断言；不得删除，也不得放宽原有断言。
7. **接线**：修改 `server/index.ts` 中 changes 的 `quay` 依赖。注意 `createMcpGatewayModule` 的整袋覆盖问题，以及可选成员名必须与真实对象一致（记忆 create-mcp-gateway-module-overwrites-readtools-projects、production-assembly-narrowed-seam-hidden-by-fixtures）。生产装配是否生效，须用真服务 DoD 证明。

**⚠️ 发布约束**：在 `gap-mcp-changes-cursor-bounded-rebase` 落地之前，cursor 仍然逐任务内嵌状态表；而全覆盖会让表的规模从「前 10 条」扩大到「全部任务」（单项目 672 个任务约 51KB）。因此**本任务不得单独发布上线**，与 ③ 作为一个发布单元。DoD 里要记录 cursor 的字节数，让这个风险能被看见。

## AC

- [ ] **红先行**：先写新判据文件 `server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts`。在实现前的代码上运行，AC-348 读数 (a)(b)(c)(e) 必须红，逐字记录失败行。
- [ ] AC-348 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes.test.ts server/modules/quay/tests/quay.service.test.ts`，覆盖 (a)–(h)。
- [ ] 取假形态 (i)–(v) 逐条执行，记录变异 diff、逐字失败行与恢复命令。
- [ ] 以下既有判据逐文件串行运行（memory cap）退出码 0，不跑全量并行：`mcp-overview.test.ts`、`mcp-read-tools.test.ts`、`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-tool-annotations.test.ts`、`quay-process.test.ts`、`server/shared/tests/quay-test-script.test.ts`（同步计数钉与 baseline）。另外 `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作（`bootServer`，临时库、`listen(0)`、临时 HOME；**不得 build/restart 生产服务，不得打扰 Live Voice 任务**）。临时项目以本仓库 `tasks/` 的只读副本或 git worktree 作为 Quay 项目，并带真实的 `.quay/plugin` 链接。经 `/mcp` 用真 PAT，依次记录：

1. 首次 `changes`：Quay source 为 cold/warming，`complete=false`，0 个 quay 事件，调用耗时；
2. 约 1 秒后再次调用：Quay source 为 bootstrap、coverage=full、taskCount 等于真实任务数，0 个事件；
3. 在副本里改一个排名第 10 之后的任务状态，等最小间隔过去或用可注入时钟推进后再调：恰好 1 个迁移事件，`at` 等于该记录的 updatedAt；
4. 60 秒内连续调用 20 次：计数型 runner 显示每个项目只有 1 次 `task list --no-body`，完整快照 CLI 为 0 次；
5. changes 的 p50/p95（各 20 次）；
6. cursor 的字节数。

记录改动前后的对照读数。仅有测试夹具通过不算完成；完成记录必须包含这一节。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/index.ts
- server/modules/quay/tests/quay.service.test.ts
- server/modules/mcp-gateway/mcp-changes.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-changes.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-changes-quay-status-index-async-bootstrap.md（self）
