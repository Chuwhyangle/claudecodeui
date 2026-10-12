---
id: gap-mcp-changes-quay-status-index-async-bootstrap
title: AC-348：changes 的 Quay 来源改为全覆盖紧凑状态索引 + 非阻塞去重限频异步加载 + bootstrap 只建基线 +
  状态与四种时间明示（修订 AC-335 (e)）
status: done
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

- [x] **红先行**：先写新判据文件 `server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts`。在实现前的代码上运行，AC-348 读数 (a)(b)(c)(e) 必须红，逐字记录失败行。
- [x] AC-348 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes.test.ts server/modules/quay/tests/quay.service.test.ts`，覆盖 (a)–(h)。
- [x] 取假形态 (i)–(v) 逐条执行，记录变异 diff、逐字失败行与恢复命令。
- [x] 以下既有判据逐文件串行运行（memory cap）退出码 0，不跑全量并行：`mcp-overview.test.ts`、`mcp-read-tools.test.ts`、`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-tool-annotations.test.ts`、`quay-process.test.ts`、`server/shared/tests/quay-test-script.test.ts`（同步计数钉与 baseline）。另外 `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作（`bootServer`，临时库、`listen(0)`、临时 HOME；**不得 build/restart 生产服务，不得打扰 Live Voice 任务**）。临时项目以本仓库 `tasks/` 的只读副本或 git worktree 作为 Quay 项目，并带真实的 `.quay/plugin` 链接。经 `/mcp` 用真 PAT，依次记录：

1. 首次 `changes`：Quay source 为 cold/warming，`complete=false`，0 个 quay 事件，调用耗时；
2. 约 1 秒后再次调用：Quay source 为 bootstrap、coverage=full、taskCount 等于真实任务数，0 个事件；
3. 在副本里改一个排名第 10 之后的任务状态，等最小间隔过去或用可注入时钟推进后再调：恰好 1 个迁移事件，`at` 等于该记录的 updatedAt；
4. 60 秒内连续调用 20 次：计数型 runner 显示每个项目只有 1 次 `task list --no-body`，完整快照 CLI 为 0 次；
5. changes 的 p50/p95（各 20 次）；
6. cursor 的字节数。

记录改动前后的对照读数。仅有测试夹具通过不算完成；完成记录必须包含这一节。

## 完成记录

实现提交 `17f22c8e feat(mcp-changes): serve Quay task status from a full-coverage async index`，分支 `task/gap-mcp-changes-quay-status-index-async-bootstrap`（worktree 同名）。以下每一个读数都在该提交的树上取得。

### AC-1 红先行（逐字）

实现前用新判据文件跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts`：`ℹ tests 8 / pass 0 / fail 8 / skipped 0`，EXIT=1。逐字失败行（`/tmp/red-first.log`）：

```
✖ (a) a transition on the fifteenth-ranked task is seen, and the source is a full-coverage index (1.030006ms)
  TypeError: createQuayService is not a function
✖ (b) a first reading bootstraps without events; only later tasks appear (0.311063ms)
  TypeError: createQuayService is not a function
✖ (c) the four instants are separated, and a re-read transition keeps its `at` (0.244185ms)
  TypeError: createQuayService is not a function
✖ (d) changes never awaits a loader that never settles (0.223225ms)
  TypeError: createQuayService is not a function
✖ (e) a stale index keeps its data and still diffs, and is reported as stale (0.302544ms)
  TypeError: createQuayService is not a function
✖ (g) the source-state vocabulary is exactly the six the contract names (0.104238ms)
  TypeError: MCP_CHANGES_SOURCE_STATES is not iterable
      at server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts:643:9
```

（(d)(f) 两条同样 `TypeError: createQuayService is not a function`，逐字见日志。AC 点名必须红的 (a)(b)(c)(e) 全部红。）

### AC-2 判据命令

`bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes.test.ts server/modules/quay/tests/quay.service.test.ts` → `ℹ tests 50 / pass 50 / fail 0 / skipped 0`，EXIT=0（日志 `/tmp/ac348-criteria.log`）。覆盖 (a)–(h)：(a) 全覆盖与第 15 名迁移、(b) bootstrap 不发事件、(c) 四种时间分离与 `(kind,ref,at)` 去重、(d) 非阻塞 + 60 秒限频两条腿、(e) stale 保留数据继续 diff、(f) 重启/清空索引不误报、(g) 白名单精确匹配（`quay.service.test.ts`）、(h) AC-335 (e) 腿移植加强（`mcp-changes.test.ts`，`refreshQuay`/`synchronizeSessions` 仍为 0，另加「从不 await 加载器」）。

### AC-3 假形态 (i)–(v)

每条只改一处、单独运行、跑完立刻 `git checkout -- server/modules/mcp-gateway/mcp-changes.ts server/modules/quay/quay.service.ts` 复原；五次复原后 `git status --porcelain` 为空、HEAD 仍为 `17f22c8e`。五条全部 EXIT=1，且 AC 点名的腿逐条红。diff 与日志：`/tmp/ac348-mut/form-{i,ii,iii,iv,v}.diff|.log`。

**(i) bootstrap 也发事件 ⇒ (b) 红**（`tests 8 / pass 6 / fail 2`）

```diff
--- a/server/modules/mcp-gateway/mcp-changes.ts
+++ b/server/modules/mcp-gateway/mcp-changes.ts
@@ -793,6 +793,27 @@
       nextHead[projectId] = { tasks: statusesOf(index) };
       sources.push(sourceOf('bootstrap'));
+      // FALSE FORM (i): a bootstrap announces every task as if it were news.
+      for (const [taskId, row] of index.tasks) {
+        candidates.push({
+          atMs: observedAt,
+          event: {
+            kind: 'quay_task',
+            project: projectOf(projectId),
+            at: formatMcpTime(observedAt, () => observedAt),
+            signal: 'progress',
+            ref: { taskId },
+            summary: `Quay task ${taskId} appeared as ${row.status}.`,
+            transition: { from: null, to: row.status },
+            atSource: 'index.observedAt',
+            source: {
+              type: 'quay.index',
+              observedAt: formatMcpTime(index.observedAtMs as number, () => observedAt),
+              ageMs: Math.max(0, observedAt - (index.observedAtMs as number)),
+            },
+          },
+        });
+      }
       continue;
```

逐字失败行：`✖ (b) a first reading bootstraps without events; only later tasks appear` / `AssertionError [ERR_ASSERTION]: the first full reading of a project emits no event`；(a) 同时红：`AssertionError [ERR_ASSERTION]: the baseline reading invents no event`。

**(ii) await 加载器 ⇒ (d) 红**（`tests 8 / pass 7 / fail 1`）

```diff
--- a/server/modules/mcp-gateway/mcp-changes.ts
+++ b/server/modules/mcp-gateway/mcp-changes.ts
@@ -759,6 +759,14 @@
     const index = deps.quay.readTaskIndex(projectId);
     deps.quay.requestTaskIndexLoad(projectId);
+    // FALSE FORM (ii): the read path waits for the load it just asked for.
+    // Bounded rather than unbounded, so a loader that never settles reds the
+    // reading instead of hanging it.
+    if (index.observedAtMs === null) {
+      await new Promise((resolve) => {
+        setTimeout(resolve, 60);
+      });
+    }
```

逐字失败行：`✖ (d) changes never awaits a loader that never settles (62.782519ms)` / `AssertionError [ERR_ASSERTION]: changes must not wait on the loader, took 60.6ms`。注：本条是「读路径等待加载」这一假形态的最小可判形态——判据里的加载器永不 settle，无界 await 会挂住而不是给出逐字失败行，故变异取有界等待（60ms > 判据的 50ms 上限）。

**(iii) 去掉 60 秒最小间隔 ⇒ (d) 红**（`tests 8 / pass 3 / fail 5`）

```diff
--- a/server/modules/quay/quay.service.ts
+++ b/server/modules/quay/quay.service.ts
@@ -1271,10 +1271,7 @@
     if (taskIndexLoading.has(projectId) || taskIndexInFlight >= QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS) {
       return;
     }
-    const lastStartedAt = taskIndexLastStartedAt.get(projectId);
-    if (lastStartedAt !== undefined && dependencies.now() - lastStartedAt < QUAY_TASK_INDEX_MIN_INTERVAL_MS) {
-      return;
-    }
+    // FALSE FORM (iii): no per-project minimum interval.
     const projectPath = dependencies.resolveProjectPathById(projectId);
```

逐字失败行：`✖ (d) one index load per project per minute, however often it is asked` / `AssertionError [ERR_ASSERTION]: a project must not load its index twice inside the minimum interval`；连带红 (a)(b)(c)(e)（`exactly the one task that moved — a `recent` reading would have seen none`、`one new task is one event — never "everything is new"`、`the same cursor re-reads the same one transition`、`a stale index STILL diffs — the change since the baseline is not dropped`）。

**(iv) 改回读 recent 前 10 ⇒ (a) 红**（`tests 8 / pass 7 / fail 1`）

```diff
--- a/server/modules/quay/quay.service.ts
+++ b/server/modules/quay/quay.service.ts
@@ -1254,7 +1254,16 @@
         title: typeof record.title === 'string' ? record.title.slice(0, QUAY_TASK_INDEX_TITLE_LIMIT) : '',
       });
     }
-    taskIndex.set(projectId, { tasks, observedAtMs: dependencies.now() });
+    // FALSE FORM (iv): keep only the ten newest rows — the `snapshot.tasks.recent`
+    // page this source used to be read from.
+    const recent = [...tasks.values()]
+      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
+      .slice(0, QUAY_RECENT_LIST_LIMIT);
+    const paged = new Map<string, QuayTaskStatusRow>();
+    for (const row of recent) {
+      paged.set(row.taskId, row);
+    }
+    taskIndex.set(projectId, { tasks: paged, observedAtMs: dependencies.now() });
```

逐字失败行：`✖ (a) a transition on the fifteenth-ranked task is seen, and the source is a full-coverage index (22.301255ms)` / `AssertionError [ERR_ASSERTION]: the source reports the real task count`（10 !== 30；第 15 名的迁移随之不可见）。

**(v) 过期时返回 null ⇒ (e) 红**（`tests 8 / pass 6 / fail 2`）

```diff
--- a/server/modules/quay/quay.service.ts
+++ b/server/modules/quay/quay.service.ts
@@ -1215,8 +1215,12 @@
     if (observedAtMs === null) {
       return { ...base, state: taskIndexLoading.has(projectId) ? 'warming' : 'cold' };
     }
-    const fresh = dependencies.now() - observedAtMs < QUAY_TASK_INDEX_TTL_MS;
-    return { ...base, state: fresh ? 'ready' : 'stale' };
+    // FALSE FORM (v): an expired reading reports as ABSENT, exactly as the
+    // snapshot cache's TTL did.
+    if (dependencies.now() - observedAtMs >= QUAY_TASK_INDEX_TTL_MS) {
+      return { coverage: 'full', taskCount: 0, observedAtMs: null, tasks: EMPTY_TASK_INDEX, state: 'cold' };
+    }
+    return { ...base, state: 'ready' };
```

逐字失败行：`✖ (e) a stale index keeps its data and still diffs, and is reported as stale` / `AssertionError [ERR_ASSERTION]: an index past its freshness window is stale, not absent`；(c) 同时红：`the same cursor re-reads the same one transition`。

### AC-4 既有判据 + typecheck（逐文件串行，memory cap）

| 判据文件 | tests / pass / fail | EXIT |
| --- | --- | --- |
| `server/modules/mcp-gateway/tests/mcp-overview.test.ts` | 11 / 11 / 0 | 0 |
| `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` | 8 / 8 / 0 | 0 |
| `server/modules/mcp-gateway/tests/mcp-english-only.test.ts` | 10 / 10 / 0 | 0 |
| `server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts` | 7 / 7 / 0 | 0 |
| `server/modules/mcp-gateway/tests/mcp-tool-annotations.test.ts` | 5 / 5 / 0 | 0 |
| `server/modules/quay/tests/quay-process.test.ts` | 7 / 7 / 0 | 0 |
| `server/shared/tests/quay-test-script.test.ts` | 11 / 11 / 0 | 0 |
| `npm run typecheck` | — | 0 |

计数钉同步更新：baseline 数据行 278→279，`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort` 306→307（实测 307），`quay-test-script.test.ts` 的 `known=3 unknown=303→304`、`known=1 unknown=305→306`。`scripts/suite-duration-baseline.tsv` 新增行取自本轮单文件实测 1094ms。

### 真实服务 DoD（改动前 / 改动后对照）

装置：`bootServer`（临时库、`listen(0)` 断言不是 3001、临时 HOME）、`/var/tmp/ac348-dod-<arm>-*`；临时 Quay 项目 = 本仓库 `tasks/` 的 `cp -a` 只读副本（保留 mtime，因为 CLI 报的 `updatedAt` 就是任务文件的 mtime）；带真实 `.quay/plugin` 链接，其 `bin/quay` 是计数型 runner（记录 argv 后 `exec` 真实插件 CLI），所以「跑了几次、跑的什么」是文件里数出来的；真 PAT 经 `/mcp`。**生产服务未被 build/restart，Live Voice 任务未被触碰**（临时端口与临时库，两个 arm 各起各的）。harness `/tmp/ac348-dod/dod.mts`，日志 `new-run.log` / `old-run.log`，读数 `readings-new.json` / `readings-old.json`。改动前的 arm 起的是主检出 `server/index.ts` 的 AC-348 之前接线（`readCachedTasks` 读 `snapshot.tasks.recent`），所以下表是同一个探针打在两份真实实现上的对照。

| DoD 项 | 本实现（新） | 改动前（旧） |
| --- | --- | --- |
| 1 首次 `changes` | `sources[0] = {state:'cold', coverage:'full', taskCount:0, observedAt:null, ageMs:null}`，`gaps[0] = {kind:'quay_task', state:'cold', reason:'Quay task index for project … is cold.'}`，`complete=false`，0 个 quay 事件，27ms | 无 `sources` 字段（`sources: null`），gap `Quay cache is cold for project …`（无机器可读 state），`complete=false`，0 事件，19ms |
| 2 约 1 秒后再次调用 | `state='bootstrap'`、`coverage='full'`、`taskCount=692`（= 副本真实任务数）、`observedAt=09:55:18.174Z`、`ageMs=986`，0 事件，`complete=false`，17ms，cursor 48920B | 先 `quay_snapshot {refresh:true}` 把十行页填满后：`complete=true`，**10** 个 quay 事件，全部盖着观测时刻（D2：首次观测被当成新闻），0 gap，cursor 1006B |
| 3 改排名第 10 之后的任务（`gap-ac317-criterion-killed-by-its-own-budget`，rank 21，done→ready，原 mtime 已还原） | 最小间隔过后第 1 次读：`state='ready'`、`ageMs=64520`、0 事件、`complete=true`（读的是未重载的索引，如实）；重载落地后第 2 次读：**恰好 1 个** 事件，`transition={from:'done',to:'ready'}`，`at.iso=2026-10-12T07:40:00.651Z` = 该记录的 `updatedAt`，`atSource='record.updatedAt'`，`source.type='quay.index'`，`source.observedAt=09:56:22.954Z`（= 索引加载时刻），`source.ageMs=8182303`，cursor 48922B | 同一条记录的同一个迁移（ISO 时刻逐字相同、rank 仍 21）：**0** 个事件，而 `complete=true` —— D1 的现场复现 |
| 4 60 秒内连续 20 次调用 | 20 次共 387ms；spawn 记录共 2 行，两行都是 `task list --json --no-body`；窗口内 1 次加载；**完整快照 CLI 0 次**；末次 `sources[0].taskCount=692` | 12 行 spawn，全是完整快照 CLI（`task list --json`、`goal list --json`、`adr list --json`、`driver status --kind worker --json`、`config validate --json`、`lanes --json --window-hours 3` 各两次），`task list --json --no-body` 0 次 |
| 5 p50/p95（20 次） | min 12 / p50 15 / p95 104 / max 104 ms | min 10 / p50 12 / p95 18 / max 18 ms |
| 6 cursor 字节 | 冷 160B → 692 个任务 **48920B**（≈70B/任务；按 672 个任务约 47KB） | 冷 228B → 1006B（只内嵌十行） |

第 6 项就是 Proposal 里那条发布约束的现场读数：全覆盖把 cursor 里逐任务的状态表从 10 条放大到 692 条，故本任务与 `gap-mcp-changes-cursor-bounded-rebase` 必须作为一个发布单元。第 5 项新实现略高（多出的是一次 JSON 解析 692 行 + 建 Map，p95 是单次尾部而非系统性差异），换来的是一次也不 spawn CLI。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/index.ts
- server/modules/quay/tests/quay.service.test.ts
- server/modules/mcp-gateway/mcp-changes.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-changes.test.ts
- server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-changes-quay-status-index-async-bootstrap.md（self）
