---
id: gap-mcp-changes-cursor-bounded-rebase
title: AC-349：changes 游标瘦身并限 8KB——服务端有界基线 LRU、非 Quay 项目不占字节、基线丢失/重启/超限显式 rebase
  gap、兼容旧游标
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-changes-quay-status-index-async-bootstrap
goal_ac: AC-349
---
## Proposal

**Finding（2026-10-12，证据见 docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11b D4）：** `server/modules/mcp-gateway/mcp-changes.ts` 的 cursor 携带 `perProjectHead`，有三个问题：

- **所有在作用域内的项目都写一条 head**，包括没有 Quay 配置的项目。实测 58 个项目、head 全为空时，编码后约 4.2KB。
- **逐任务状态只增不删**（`mcp-changes.ts:555-556`）。单个项目 672 个任务时约 51KB，每次调用进出各付一次。前置任务 `gap-mcp-changes-quay-status-index-async-bootstrap` 改成全覆盖后，这个表会达到全部任务的规模（quay 仓库有 2729 个任务）。
- **切换项目作用域时，`nextHead` 只覆盖当前作用域**，其他项目的 head 丢失，之后切回会产生「全部是新任务」的误报。

**裁定约束（外部 Agent 2026-10-12）：** 服务重启、游标丢失、服务端索引或基线被清空时，**不得静默漏数据**——必须明确报告 gap，或标为 rebase/bootstrap，不得宣称 complete。旧字段语义保持兼容，只做增量扩展。

**要交付：**

1. **cursor 新格式（v3）**：
   - 只为有 Quay 配置的项目记录 `{baselineId, digest}`；
   - `baselineId` 引用服务端有界 LRU 中的一份基线（任务 id → 状态的紧凑映射）；`digest` 是该基线内容的哈希，用来校验 LRU 命中的确实是同一份基线；
   - session 键集位置、watermark、bootId 保持①、②之后的语义；
   - 编码后不超过 8192 字节（常量）。超限时不截断内容，而是对相应项目报告 `state:'rebase'` 的 gap，并让它重新建立基线。
2. **服务端基线 LRU**（模块内状态，不持久化）：
   - 容量上限（常量，建议 256 份基线）与单份大小上限（常量，建议 10000 个任务）写进代码常量和工具描述；
   - 每次 diff 后写入新基线，旧基线按 LRU 淘汰。
3. **基线丢失时的行为**，覆盖三种情形：LRU 未命中、digest 不一致、bootId 改变。
   - 该项目报告 `gaps:[{kind:'quay_task', state:'rebase', reason}]`，并在 `sources` 中标 `state:'rebase'`，`complete=false`；
   - 不编造任何事件，以当前索引重新建立基线；
   - reason 必须明确写出「此期间发生的迁移可能未报告」。
4. **兼容旧游标**：v1、v2 游标（逐任务表）仍被接受。解码后把其中的表作为一次性基线做 diff（不报 rebase），之后改发 v3。不再支持的形状才拒绝。
5. **作用域切换**：cursor 中保留作用域外项目的条目，不随调用作用域裁剪。如果条目数超出体积上限，被淘汰的项目在下次被查询时报告 rebase。

## AC

- [x] **红先行**：先写新判据文件 `server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts`；先在本任务起点提交（未含本次改动）的树上运行，AC-349 读数 (a)(b)(c)(d) 必须红，逐字失败行记入完成记录。
- [x] AC-349 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes.test.ts`，覆盖 (a)–(f)。
- [x] 取假形态 (i)(ii) 逐条执行，记录变异 diff、逐字失败行与恢复命令。
- [x] 以下既有判据逐文件串行运行（memory cap）退出码 0：`mcp-changes-session-paging.test.ts`、`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`server/shared/tests/quay-test-script.test.ts`（同步计数钉与 baseline）。另外 `npm run typecheck` 退出码 0。不跑全量并行。

## DoD

在真实服务实例上实际操作（`bootServer`，临时库与 HOME、`listen(0)`；**不得 build/restart 生产服务，不得打扰 Live Voice 任务**）。播种 58 个项目，其中 8 个是 Quay 项目，任务规模取真实仓库的只读副本，经 `/mcp` 用真 PAT 记录：

1. 工作区作用域下，bootstrap、迁移、空闲三个阶段的 cursor 字节数（必须都不超过 8192）；
2. 在临时实例上重启（只重启这个临时实例），用旧 cursor 调用：对应项目报告 rebase gap，`complete=false`，0 个编造事件，下一次调用恢复 ready；
3. 用一个 v2 旧 cursor 调用：被接受，并按其中的表 diff；
4. 作用域切换来回各一次：没有出现「全是新任务」的突发；
5. changes 的 p50/p95（各 20 次）。

记录与②完成时那条基线的对照读数。仅有测试夹具通过不算完成；完成记录必须包含这一节。

## 完成记录

**实现提交：** `1eca6a36`（`feat(mcp): bound the changes cursor with a server-side baseline LRU (AC-349)`）、`4d672220`（`test(mcp): pin the v3 changes cursor in the sibling criteria and the suite data`）。分支 `task/gap-mcp-changes-cursor-bounded-rebase`，起点树 `6a41e690`（与 develop 的 merge-base）。

改动落在 `server/modules/mcp-gateway/mcp-changes.ts`（v3 编码/解码、服务端有界基线 LRU、`state:'rebase'` 各丢失路径、字节预算裁剪 + `rebased` 记账）与 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts`（`changes` 工具描述里点出 8192 / 256 / 10000 三个常量）。

### AC-1 红先行（逐字）

新判据文件 `server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts` 先写、只在起点树 `6a41e690` 上运行（工作区未含本次改动）：

```
✖ (a) 58 projects / 8 Quay / 2729 tasks: no phase's cursor exceeds the byte budget
✖ (b) the cursor embeds no task table: one compact {baselineId, digest} per Quay project
✖ (c) a baseline the LRU evicted reports a rebase gap — never a fabricated "everything appeared"
✖ (c) a cursor from another boot rebases every carried Quay project
✖ (d) switching scope away and back does not re-baseline (no "all tasks are new" burst)
✖ (e) a v2 cursor (which DOES embed a task table) is accepted, diffed once, and upgraded to v3
✖ (f) the caps are code constants AND are named in the `changes` tool description
✖ (g) refs exceeding the budget are trimmed, and every dropped project reports rebase next call
ℹ tests 8
ℹ pass 0
ℹ fail 8
ℹ duration_ms 1773.301305
```

AC 点名的四条 (a)(b)(c)(d)，逐字失败行：

- **(a)** `AssertionError [ERR_ASSERTION]: bootstrap cursor is 91320 bytes, over the undefined-byte budget`（`mcp-changes-cursor-bounds.test.ts:165`）。`undefined` 是起点树上 `MCP_CHANGES_CURSOR_MAX_BYTES` 尚不存在所致——这条失败行本身就证明它跑在改动前的树上。
- **(b)** 断言「every Quay project is referenced by a compact ref」：`actual: []`，`expected: ['proj-00', 'proj-01', 'proj-02', 'proj-03', 'proj-04', 'proj-05', 'proj-06', 'proj-07']`（`:200`）。
- **(c) LRU 淘汰**：`an out-of-scope project's ref (proj-a) must survive the scope switch`（`:238`）。
- **(c) 跨 boot**：`every carried Quay baseline must report a rebase after a restart` — `0 !== 2`（`:270`）。
- **(d)** `coming back to a project must diff against its retained baseline, not re-baseline` — `actual: ['bootstrap']` / `expected: ['ready']`（`:296`）。

**诚实说明：** 起点树那一轮的捕获在 (d) 之后被截断，(e)(f)(g) 的失败体没有留下逐字文本；八条 `✖` 标题与 `tests 8 / pass 0 / fail 8` 的计数是完整的。AC-1 只点名 (a)(b)(c)(d)，四条的逐字失败行都在上表。

### AC-2 判据命令（逐字）

```
npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes.test.ts
```

结果：`tests 23 / pass 23 / fail 0`，**EXIT=0**（覆盖 (a)–(g)）。两条假形态恢复成原实现后重跑，仍为 23/23、EXIT=0。

### AC-3 假形态 (i)(ii)

**假形态 (i) —— 字节闸保留、丢弃不留痕**（去掉 `rebased` 记账，长度上限仍生效，损失变成静默）。变异 diff：

```diff
--- a/server/modules/mcp-gateway/mcp-changes.ts
+++ b/server/modules/mcp-gateway/mcp-changes.ts
@@ -1241,9 +1241,9 @@ export async function buildChanges(
     if (ids.length > 0) {
       const dropped = ids[ids.length - 1];
       delete nextCursor.baselines[dropped];
-      if (!nextCursor.rebased.includes(dropped)) {
-        nextCursor.rebased = [...nextCursor.rebased, dropped].sort();
-      }
+      // FALSE FORM (i): the cursor is still trimmed to the byte budget, but the
+      // dropped ref is NOT marked — so the loss is silent and the next call
+      // re-baselines the project as if nothing had been lost.
     } else if (nextCursor.rebased.length > 0) {
       nextCursor.rebased = nextCursor.rebased.slice(0, -1);
     } else {
```

结果 `EXIT=1`，`tests 8 / pass 7 / fail 1`，逐字失败行：

```
✖ (g) refs exceeding the budget are trimmed, and every dropped project reports rebase next call
  AssertionError [ERR_ASSERTION]: the projects dropped from the cursor must be marked for rebase
      at ... mcp-changes-cursor-bounds.test.ts:372:10
```

**假形态 (ii) —— 上限声明了但从不执行**（删掉整个裁剪循环）。变异 diff：

```diff
--- a/server/modules/mcp-gateway/mcp-changes.ts
+++ b/server/modules/mcp-gateway/mcp-changes.ts
@@ -1235,22 +1235,9 @@ export async function buildChanges(
   // `rebased` so its next reading reports the loss instead of hiding it. When
   // even the marker list cannot fit, the marker list itself is trimmed from the
   // end — the earliest losses are the ones a caller is least able to act on.
-  let encodedCursor = encodeChangesCursor(nextCursor);
-  while (encodedCursor.length > MCP_CHANGES_CURSOR_MAX_BYTES) {
-    const ids = Object.keys(nextCursor.baselines).sort();
-    if (ids.length > 0) {
-      const dropped = ids[ids.length - 1];
-      delete nextCursor.baselines[dropped];
-      if (!nextCursor.rebased.includes(dropped)) {
-        nextCursor.rebased = [...nextCursor.rebased, dropped].sort();
-      }
-    } else if (nextCursor.rebased.length > 0) {
-      nextCursor.rebased = nextCursor.rebased.slice(0, -1);
-    } else {
-      break;
-    }
-    encodedCursor = encodeChangesCursor(nextCursor);
-  }
+  // FALSE FORM (ii): the budget is declared but never enforced — the cursor is
+  // encoded once and handed back at whatever size the refs happen to make it.
+  const encodedCursor = encodeChangesCursor(nextCursor);
```

结果 `EXIT=1`，`tests 8 / pass 7 / fail 1`，逐字失败行：

```
✖ (g) refs exceeding the budget are trimmed, and every dropped project reports rebase next call
  AssertionError [ERR_ASSERTION]: a 200-project cursor must fit the budget, got 27816
      at ... mcp-changes-cursor-bounds.test.ts:364:10
```

**诚实说明：** 假形态 (ii) 之下的 (a) 腿**不红**——(a) 的夹具只有 8 个 Quay 项目，天然落在预算内；能捕捉「上限未执行」的是 (g)（200 个项目编号）。这一条按实测记录，不美化。

**恢复命令（两形态共用）：**

```
git -C /data/home/yale/work/claudecodeui-worktrees/gap-mcp-changes-cursor-bounded-rebase checkout -- server/modules/mcp-gateway/mcp-changes.ts
```

恢复后 `git status --porcelain` 为空（HEAD `4d672220`）。

### AC-4 既有判据 + typecheck

逐文件串行运行（未跑全量并行）：

| 判据文件 | tests | pass | fail | exit |
| --- | --- | --- | --- | --- |
| `mcp-changes-session-paging.test.ts` | 5 | 5 | 0 | 0 |
| `mcp-english-only.test.ts` | 10 | 10 | 0 | 0 |
| `mcp-error-envelope.test.ts` | 7 | 7 | 0 | 0 |
| `server/shared/tests/quay-test-script.test.ts` | 11 | 11 | 0 | 0 |
| `npm run typecheck` | — | — | — | 0 |

计数钉与 baseline 同步：`quay-test-script.test.ts` 的 `unknown=308`（AC2）/ `unknown=310`（AC3）；`scripts/suite-duration-baseline.tsv` 新增行 `1220	server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts`，来源行注明 `gap-mcp-changes-cursor-bounded-rebase, measured one file at a time on 2026-10-12`，覆盖率行由 282/310 改为 283/311。

### 真实服务 DoD

**夹具与实例：** 58 个项目（其中 8 个 Quay），任务取自真实仓库 `tasks/` 的**只读副本**，共 694 个任务文件，轮转切成 8 片（87×6 + 86×2）。临时库与 HOME 在 `/var/tmp/ac349-dod-VuKYeQ`，`bootServer` + `listen(0)`（端口 15893，pid 2287888），经 `/mcp` 用真 PAT 调用。**未 build/restart 生产服务，Live Voice 任务未受影响。**

| 读数 | 结论 |
| --- | --- |
| ① 三阶段 cursor 字节 | bootstrap 1610 B / migration 1610 B / idle 1610 B，均 ≤ 8192 |
| ② 重启后用旧 cursor | 8 个 Quay 项目全部 rebase gap，`complete=false`，0 个编造事件；下一次调用恢复 ready |
| ③ v2 旧 cursor | 被接受，按其表 diff（1 个事件），返回 v3（350 B） |
| ④ 作用域来回 | 作用域外 8 条 ref 全部保留，两次调用均 0 事件，无「全是新任务」突发 |
| ⑤ p50/p95 | p50 **13 ms** / p95 **23 ms**（20 次；min 11 / max 23） |

逐条读数的关键字段：

- **①a（索引加载前的首调）：** cursor 171 B，`complete=false`，0 事件，`sources:['cold']`，31 ms——冷路径不编造数据。
- **①b bootstrap：** 首调后轮询至收敛（waitedMs 6135，timedOut false）；cursor **1610 B**，`cursorVersion:3`，`baselineRefs:8`，`rebased:[]`，`nonQuayReferenced:[]`，`tasksEmbeddedInCursor:false`，`withinBudget:true`，8 个源均 `bootstrap`（taskCount 87/87/87/87/87/87/86/86）。
- **② 迁移：** 只改项目副本里的 `gap-ac-001-criterion-repoint-to-migrated-test`（done→ready）；边界调用 1610 B / 0 事件；等 2000 ms 后**恰好 1 个** `quay_task` 事件 `{from:'done', to:'ready'}`，`atSource:'record.updatedAt'`。空闲阶段 1610 B / 0 事件 / `complete=true`。
- **③ v2：** 手造 v2 游标（内嵌任务表 6331 B，对齐当前 bootId，故意翻转受害者行）→ `complete=true`，恰好 1 个事件 `{from:'todo',to:'ready'}`，返回 v3 350 B。
- **④ 作用域：** 切走后 `refsCarriedWhileOutOfScope:8`、1610 B、0 事件；切回后 `backBaselineRefs:8`、`backEvents:[]`。
- **⑤ 延迟：** 链式 20 次（每次用上一次返回的 cursor，避免测成冷路径），`minMs 11 / p50Ms 13 / p95Ms 23 / maxMs 23`，`lastComplete:true`，`lastSourceStates:['ready']`，`lastCursorBytes:1610`；计数包装脚本记录 16 次 `quay` CLI 派生（8 项目 × 2 次加载，受 60 s 最小间隔节流）。
- **② 重启：** 只用新端口 11745（新 pid 2407419）重启**临时实例**（bootId `c70e029a…` → `e5c25e68…`）。用重启前的旧 cursor：首调索引尚未加载（`cold`，586 B，`complete=false`，0 事件）；等 6114 ms 索引就绪后再调 → **`rebaseGapCount:8`**，`rebaseCoversEveryQuayProject:true`，`complete=false`，0 事件，cursor 1610 B；reason 逐字如「The service restarted since this cursor was issued; the Quay statuses it had recorded for <uuid> cannot be compared across the restart, so status changes in the window may not be reported.」；再下一次 `complete=true`、全部源 `ready`、0 事件。

**与②完成时那条基线的对照：** AC-348（②）的 DoD 记录是 **692 个任务时 cursor 48920 B**（单项目、旧实现）；本实现是 **694 个任务、跨 8 个 Quay 项目时 1610 B**，约 30×。诚实的边界：两者语料不同（②单项目 692 任务，本任务 8 项目 694 任务），不是受控 A/B；能确定的对照是同一路径下 cursor 不再随任务表规模增长（`tasksEmbeddedInCursor:false`）。

## Touches

- server/modules/mcp-gateway/mcp-changes.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts
- server/modules/mcp-gateway/tests/mcp-changes.test.ts
- server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-mcp-changes-cursor-bounded-rebase.md（self）

## Notes

**2026-10-12（作者改写，人授权）：** 上一轮 parked `needs-human`，唯一原因是准入闸 `unsatisfiable-ac-unannotated` 对 AC 第 1 条的**纯文本误报**：原文里的一个状态限定语命中了封闭短语表 `UNSATISFIABLE_AC_DECLARATION_PHRASES`，闸把它读成「本条 AC 只有外部主体能满足」。该条实际描述的是**红先行**这一可执行动作（在未含本次改动的起点树上跑新判据文件并记录红行），执行者完全能满足，故只改写措辞、不动语义。被改写的原文逐字如下（围栏内是引文，按本闸的设计约定不算「本条 AC 的自身文本」）：

```
- [ ] **红先行**：先写新判据文件 `server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts`。在本任务开始时的代码（即②落地后）上运行，AC-349 读数 (a)(b)(c)(d) 必须红，逐字记录失败行。
```

语义（红先行 + 记录逐字失败行）逐字不变；DoD 末行同一限定语一并改写为「②完成时」。机读复核：`judgeUnsatisfiableUnannotatedAc` 由 `hit` 转 `clean`；`prosePrereqAssessment(body, fm, tasksDir).gap` 仍为 `[]`。

**依赖不变：** 本任务 `depends_on: gap-mcp-changes-quay-status-index-async-bootstrap`（②）。② 的交付物 `server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts` 正是本任务 AC 第 2 条与 AC-349 判据逐字要求的同一份文件（缺文件立即 exit 1），故 ② 完成前本任务不可执行——这正是 `depends_on` 边的作用，不再重新 park。