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

- [ ] **红先行**：先写新判据文件 `server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts`；先在本任务起点提交（未含本次改动）的树上运行，AC-349 读数 (a)(b)(c)(d) 必须红，逐字失败行记入完成记录。
- [ ] AC-349 判据逐字运行退出码 0：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts server/modules/mcp-gateway/tests/mcp-changes.test.ts`，覆盖 (a)–(f)。
- [ ] 取假形态 (i)(ii) 逐条执行，记录变异 diff、逐字失败行与恢复命令。
- [ ] 以下既有判据逐文件串行运行（memory cap）退出码 0：`mcp-changes-session-paging.test.ts`、`mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`server/shared/tests/quay-test-script.test.ts`（同步计数钉与 baseline）。另外 `npm run typecheck` 退出码 0。不跑全量并行。

## DoD

在真实服务实例上实际操作（`bootServer`，临时库与 HOME、`listen(0)`；**不得 build/restart 生产服务，不得打扰 Live Voice 任务**）。播种 58 个项目，其中 8 个是 Quay 项目，任务规模取真实仓库的只读副本，经 `/mcp` 用真 PAT 记录：

1. 工作区作用域下，bootstrap、迁移、空闲三个阶段的 cursor 字节数（必须都不超过 8192）；
2. 在临时实例上重启（只重启这个临时实例），用旧 cursor 调用：对应项目报告 rebase gap，`complete=false`，0 个编造事件，下一次调用恢复 ready；
3. 用一个 v2 旧 cursor 调用：被接受，并按其中的表 diff；
4. 作用域切换来回各一次：没有出现「全是新任务」的突发；
5. changes 的 p50/p95（各 20 次）。

记录与②完成时那条基线的对照读数。仅有测试夹具通过不算完成；完成记录必须包含这一节。

## Touches

- server/modules/mcp-gateway/mcp-changes.ts
- server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts（new）
- server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts
- server/modules/mcp-gateway/tests/mcp-changes.test.ts
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