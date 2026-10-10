---
id: gap-session-host-control-lease-gate-rest-parity-followup
title: "风险调查 follow-up（候选 #2，未实现）：REST POST /:sessionId/close 是否也该有 mcp-gateway
  的 lease-blocking force 门"
status: ready
labels:
  - gap
  - needs-human
parent: null
children: []
extra: {}
---
## Proposal

（本任务只记录风险调查，不实现）

2026-10-10 架构审查候选 #2（docs/experiments/2026-10-10-archguard-ownership-architecture-review.md）与其后续 GOAL-036 的实现过程中都确认并复核了这个不对称，截至 AC-324 合并后（commit 7b2b4f7d 之后）**仍然成立，未被本次改动触碰**：

- `server/modules/mcp-gateway/mcp-session-host-control.ts` 的 `buildSessionClose` 持有 `blockingLeases()` / `leasesBlockingMessage()` / `SESSION_HAS_ACTIVE_LEASES_CODE` 三个符号（约 187-268 行），经 MCP 的 `session_close` 工具调用：会话持有 `cron`/`background-task` lease 时，不带 `force: true` 会被拒绝（`SESSION_HAS_ACTIVE_LEASES`，message 点名 lease 种类与数量），宿主不关闭。
- `server/modules/session-hosts/session-hosts.routes.ts` 的 `POST /:sessionId/close`（约 419-436 行，本次复核过，未改一字）**没有 `force` 参数，也不读 lease**，直接调用 `closeResidentHost` 无条件关闭；`resident-host.service.ts` 的 `closeResidentHost` 在关闭**之后**才读回 leases 用于回报，不用于决策。
- `archguard_get_cochange` 对 `mcp-session-host-control.ts`（180 天 / 758 commits 窗口）未发现与 `sessions.service.ts`/`session-hosts.routes.ts` 的联合变更——没有证据表明有人在手动保持这两条路径同步；放着不管只会越漂越远。

## 为什么不直接实现（本任务停在 todo，不升 ready）

这不是一个机械收敛（像 AC-324 那样「调用已存在的同一个函数」），而是一个**产品决策**：REST 的 `close` 今天没有 `force` 这个概念——给它加一道会拒绝的门，意味着现有经 REST 调用 `/:sessionId/close` 的客户端（Web UI 自己的「关闭」按钮？任何脚本化调用？）会从「总是成功」变成「持有 cron/background-task lease 时默认失败，需要显式传 force」。这是不是期望的行为变化，需要人决定：

1. 是否要让 REST close 与 MCP close 在"持有活跃 lease 时的默认拒绝"上对齐？
2. 如果要对齐，REST 的请求体/query 要不要加 `force` 字段？现有调用方（如 Web UI 的关闭交互）要不要先在 UI 上加确认态？
3. 如果不对齐，是否需要在两处的文档/注释里显式写明"REST 故意不做这道门，原因是 X"，避免未来被当成缺陷修复？

## 建议的实现形状（供人决策后参考，本任务本身不做）

- 把 `blockingLeases`/`leasesBlockingMessage`/`SESSION_HAS_ACTIVE_LEASES_CODE` 从 `mcp-gateway` 搬到 `session-hosts`（它们读的是 `HostLease`，是 session-hosts 的数据形状），经 barrel 导出，`mcp-gateway` 改为调用而不是拥有——这一半是机械的，像 AC-324 一样。
- 是否让 REST 路由也调用这道门——这一半不是机械的，取决于上面的产品决策。
- 两半不要混在一个 PR 里：先做搬迁（行为不变，`mcp-gateway` 原样委派），REST 是否接线作为**独立**、需要人签字的改动。

## Touches

- tasks/gap-session-host-control-lease-gate-rest-parity-followup.md

（本任务不改任何源码；上面这条是 C8 自-touch 声明——本任务唯一的"产物"是它自己的任务文件。）

## AC

- [x] AC1 风险调查完成并记录在本任务体内：不对称的具体位置、为何不是机械决策、搬迁与接线应该分两步。
- [ ] AC2（待人决策后才能勾）：人对上面三个问题给出答案，本任务据此升级为可实现的任务或被标记 won't-fix。

## DoD

- 本任务本身不改任何源码；它的产出是一份可供人决策的风险/选项记录，不是实现。

<!-- dedup-ref -->
边界（dedup）：`grep -rln "SESSION_HAS_ACTIVE_LEASES\|blockingLeases" tasks/*.md` 命中仅 gap-ac251-mcp-session-host-control（交付该门本身，不涉及 REST 对齐问题）；本任务与之不重叠。
