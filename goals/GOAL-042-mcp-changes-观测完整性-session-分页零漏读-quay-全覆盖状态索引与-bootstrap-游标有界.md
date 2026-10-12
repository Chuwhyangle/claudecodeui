---
id: GOAL-042
title: MCP changes 观测完整性：session 分页零漏读、Quay 全覆盖状态索引与 bootstrap、游标有界与显式 rebase
status: achieved
kind: goal
origin: docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11；外部
  Agent 2026-10-12 裁定 E1–E4
activatedAt: 2026-10-12T06:52:05.221Z
statusLog:
  - at: 2026-10-12T11:54:08.707Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

GOAL-040（AC-334..337）已达成并部署：changes、mcp_usage_stats、session_search 剪枝、correlationId 都已上线。外部 Agent 2026-10-12 实测 changes 时发现，三个项目首次调用均为 complete=false 且 Quay cache cold；改用 quay_snapshot refresh 后看似完整。复核真实代码路径后，确认问题出在 changes 的两个数据源，共 5 个缺陷：

- D1：Quay 数据只读 snapshot.tasks.recent 前 10 条，其余任务的迁移不可见，却仍报告 complete；
- D2：首次观测被当作 progress 事件发出，at 取的是观测时刻；
- D3：session 分页用 DESC LIMIT，且项目过滤在 LIMIT 之后，会漏读；
- D4：游标逐任务内嵌状态，并为所有项目写 head，体积 4–51KB；
- D5：30s 显示 TTL 过期即被视为 cold，complete 几乎恒为 false。

完整证据、代码行号与裁定见 docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11。

## 范围

- 修正 session 增量分页：升序键集，项目过滤下推到 SQL（AC-347）。
- Quay 来源改为全覆盖的紧凑状态索引（task list --json --no-body）；非阻塞、去重、限频的异步加载；bootstrap 只建立基线；cold/warming/stale/ready 状态明示；四种时间分开（AC-348，修订 AC-335 (e)）。
- 游标瘦身并设上限；服务端基线丢失时显式 rebase gap（AC-349）。

## 非目标

- 不引入 fs.watch，不做周期性 Quay CLI，不建事件总线或持久化事件日志，不建全文索引。
- 不同步执行任何 Quay CLI，不运行完整快照 CLI。
- 不实现 Quay 侧的 task_trace，真实迁移时刻仍只是近似值，并明确标注 atSource。
- 不修改 quay_snapshot、overview 的既有语义，不 build/restart 生产服务。

## 退出条件

1. session 分页零漏读（AC-347）。覆盖状态：直接覆盖。
2. Quay 全覆盖索引、bootstrap、状态明示、非阻塞加载，以及对 AC-335 (e) 的合规修订（AC-348）。覆盖状态：直接覆盖。
3. 游标有界，基线丢失时显式 rebase（AC-349）。覆盖状态：直接覆盖。
4. 对照测量：在隔离实例上，changes 的 p95 低于 50ms，且没有同步 CLI；每个项目在 60s 内至多 1 次加载；cursor 不超过 8KB。用 mcp_usage_stats 与计数型假 runner 读出。覆盖状态：由 AC-348、AC-349 的读数与各任务 DoD 覆盖，无单独 AC。
5. 既有 MCP 判据保持通过（只移植、不放宽），typecheck 通过。覆盖状态：无单独 AC。

## 已知限制

- 任务②、③都修改 mcp-changes.ts 与 server/index.ts 的接线，因此串行执行：② 依赖 ①，③ 依赖 ②。
- 新增服务端测试文件会移动 quay-test-script.test.ts 的文件计数钉和 suite-duration-baseline，须在各自任务内同步。
- 本 GOAL 落地后仍需人工 build/restart 才会上线，并需在 ChatGPT 侧刷新连接器。
