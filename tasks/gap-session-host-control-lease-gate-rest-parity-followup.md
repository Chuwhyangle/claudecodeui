---
id: gap-session-host-control-lease-gate-rest-parity-followup
title: "风险调查 follow-up（候选 #2，未实现）：REST POST /:sessionId/close 是否也该有 mcp-gateway
  的 lease-blocking force 门"
status: needs-human
labels:
  - gap
  - needs-human
parent: null
children: []
extra: {}
---
## Proposal（本任务只记录风险调查与所有权再诊断，不实现；2026-10-10 第二轮复核后结论收紧）

GOAL-036 的 Candidate #1（live-host 查询收敛）achieved 后，按同一套 ownership-first 方法论重新评估 Candidate #2——**结论从「机械搬迁是安全的，只差 REST 是否接线的产品决策」收紧为「搬迁本身也不该在产品决策之前做」**，理由见下面「第二轮：为什么搬迁本身也被阻塞」。本任务保持 `needs-human`，不升级为可实现任务，不开 Goal/AC，不改任何源码。

### 现状（本轮重新读源码核实，GOAL-036 合并后仍逐字成立）

- `server/modules/mcp-gateway/mcp-session-host-control.ts:148-200` 定义并**只在本文件内使用**三个符号：`SESSION_HAS_ACTIVE_LEASES_CODE`（导出）、`leasesBlockingMessage`、`blockingLeases`（后两者模块私有，**未经 mcp-gateway barrel 导出**——`grep -n` 核实 `server/modules/mcp-gateway/index.ts` 只再导出了 `SESSION_HAS_ACTIVE_LEASES_CODE` 这一个错误码常量，不导出另外两个函数）。
- `buildSessionClose`（同文件 `:260-282`）在委派 `closeResidentHost` **之前**先用 `deps.hosts.liveHost` 读活宿主、用 `blockingLeases` 过滤 `cron`/`background-task` lease，无 `force:true` 时结构化拒绝；这个顺序是刚性约束——`resident-host.service.ts` 的 `closeResidentHost` 在真正 `closeHost` 之前读回 leases 只为**回报**，`closeHost` 会清空 binding 的 leases，所以门必须在委派前跑。
- `server/modules/session-hosts/session-hosts.routes.ts` 的 `POST /:sessionId/close`（本轮 `grep force` 复核：零命中）仍然没有这道门，直接无条件 `closeResidentHost`。
- **真正的生命周期状态机（AC-157/AC-165，均 done）与这道门完全独立**：`session-host-manager.service.ts` 的 `reportExited`（`:769`，driver 上报 `exited` 事件触发，`:918`/`:996` 两个调用点）在进程异常退出/oom/signal 时**直接关闭宿主，完全不经过、也不受这道 lease 门影响**——这道门只守「显式请求关闭」这一条路径（今天唯一的调用方是 MCP 的 `session_close`），对「进程自己死了」「`shutdown()` 停机」这些路径不适用、也不应该适用（不能跟一个已经死掉的进程谈判）。这把这道门的性质钉得更死：它是**某个 API 入口（MCP）的调用方策略**，不是 session-hosts 状态机本身的不变量。

### 第二轮：为什么搬迁本身也被阻塞（不只是 REST 接线）

把 `blockingLeases`/`leasesBlockingMessage`/`SESSION_HAS_ACTIVE_LEASES_CODE` 搬到 `session-hosts` 这件事，本身是否该做，取决于同一个未裁决的问题，不是独立于它的机械前置步骤：

1. **今天只有一个调用方**：三个符号目前只被 `mcp-session-host-control.ts` 自己用，`grep -rln "blockingLeases\|leasesBlockingMessage\|SESSION_HAS_ACTIVE_LEASES"` 命中的生产文件只有它自己和 `index.ts`（再导出）。这与 GOAL-036 的 Candidate #1 完全不同——那里是**三个模块各自独立重写同一段逻辑**，搬迁消除的是已经存在的真实重复。这里**没有重复可消除**；搬迁的唯一理由是"给一个还不存在的第二个调用方（REST）预留位置"，这正是「不要为假设的未来需求设计」要拦住的那类改动。
2. **文件自己的文档注释明写了一个架构原则**（`mcp-session-host-control.ts:8-19`）：`closeResidentHost`"故意不做"这个决定；这是 session-hosts 的 mechanism（无条件关闭、关闭后回报 leases）与 mcp-gateway 的 policy（要不要在关闭前用 lease 状态拒绝、给不给 `force` 旁路）之间的刻意分层——`force` 本身是 MCP 工具入参的 wire 概念，不是 session-hosts 的领域概念（`closeResidentHost` 没有、也从未有 `force` 参数）。把判定谓词搬进 session-hosts，是在搬动这条分层线，不是单纯的"挪文件位置"。
3. **搬迁的合理性完全依赖 REST 是否要接这道门**：如果人的答案是"REST 故意保持无条件关闭、永远不加这道门"，那就永远不会有第二个调用方，搬迁就是零收益的churn，且违反了作者写在代码里的分层理由，没有理由覆盖它；如果答案是"要对齐"，搬迁才成立，而且要跟 REST 接线一起设计（两者是同一个决策的两个面，不是"先搬、后决定接不接线"的两步）。
4. **方向性确认（如果未来真的要做）**：`session-hosts.routes.ts` 不能反向 import `mcp-gateway`（会把现有的单向依赖——mcp-gateway 依赖 session-hosts——倒过来，`archguard_detect_cycles` 当前对 `modules/mcp-gateway`/`modules/session-hosts` 两者都读到 `cycleCount: 0`，倒过来极可能新增一个环）；所以**如果**要做，目标只能是搬进 `session-hosts`，不是"从 mcp-gateway 再导出给 REST 用"。这一点在方向上确认了 2026-10-10 审查报告候选 #2 原始诊断没有错——错的是「现在就做」这个时机判断，不是目标方向。

### ArchGuard before-facts（本轮重新核实，供将来真的要做时比较用，本身不构成实现理由）

- `modules/mcp-gateway`：fanIn 20 / fanOut 280 / cycleCount 0。
- `modules/session-hosts`：fanIn 8 / fanOut 30 / cycleCount 0。
- 包级环集合不变（size 8 / size 2 / size 2，成员列表与 GOAL-036 记录的一致）。
- **预期机械 delta（若真的搬迁，未执行，仅作为候选比较的语义预测）**：mcp-gateway→session-hosts 这条既有 barrel 边会新增 3 个符号（`blockingLeases`/`leasesBlockingMessage`/`SESSION_HAS_ACTIVE_LEASES_CODE`），`modules/session-hosts` 的 fanIn 预计从 8 增至 ~11（而不是像 AC-324 那样零变化）——这是一次**有预期非零 delta** 的搬迁，不是 AC-324 那种纯体内收敛；如实标注，不要在真正执行时把它错误地判定为"应为零"。

### 候选比较（三选一，均未实施）

| 候选 | 做什么 | 现在就做的理由 | 反对/风险 |
|---|---|---|---|
| A（维持现状） | 不动 | 零风险；与代码自己的分层文档一致 | REST 若将来要接线，仍需面对同一个搬迁决策，只是推迟 |
| B（搬迁到 session-hosts，mcp-gateway 改为调用） | `blockingLeases`/`leasesBlockingMessage`/`SESSION_HAS_ACTIVE_LEASES_CODE` 搬进 `session-hosts`（如 `resident-host.service.ts` 旁），经 barrel 导出，mcp-gateway 委派 | 为 REST parity 预先铺路 | 今天零消费者证明不了这个重复；覆盖代码自己写明的分层理由；产品决策未定前做，一旦决定"REST 永远不要这道门"就是纯 churn |
| C（REST 也反向 import mcp-gateway） | 不搬，REST 直接从 mcp-gateway 导入 | 改动面最小 | 方向反了（session-hosts 依赖 mcp-gateway），ArchGuard 当前两个包都是 `cycleCount: 0`，这样接会有引入新环的真实风险 |

**结论：三个候选都不满足"现在就实施"的证据门槛**——A 是唯一不依赖未裁决决策的候选，B/C 都要先有人对 REST parity 的回答。本任务继续停在 `needs-human`，不升级、不开 Goal、不改产品行为。

## 为什么不直接实现（维持 2026-10-10 初版结论，本轮强化）

1. 是否要让 REST close 与 MCP close 在"持有活跃 lease 时的默认拒绝"上对齐？—— 未裁决。
2. 如果要对齐，REST 的请求体/query 要不要加 `force` 字段？现有调用方（Web UI 的关闭交互、任何脚本化调用）要不要先在 UI 上加确认态？—— 未裁决。
3. 如果不对齐，是否需要在两处的文档/注释里显式写明"REST 故意不做这道门"，避免未来被当成缺陷修复？—— 未裁决。
4. **（本轮新增）即使只做"搬迁，不接线"这一半，是否值得在零消费者、且有明文分层理由的情况下现在就做？**—— 未裁决，且本任务的建议答案是"不值得，等（1）有答案"。

## Touches

- tasks/gap-session-host-control-lease-gate-rest-parity-followup.md

（本任务不改任何源码；上面这条是自-touch 声明。）

## AC

- [x] AC1 风险调查完成并记录在本任务体内（第一轮）：不对称的具体位置、为何不是机械决策、搬迁与接线应该分两步。
- [x] AC2（记录性，非产品决策）：第二轮复核确认——搬迁本身也依赖同一个未裁决问题，不是独立于它的安全前置步骤；三个候选（维持现状/搬迁/反向依赖）的比较与 ArchGuard before-facts、预期非零 delta 已记录在案。
- [ ] AC3（待人裁决才能勾，非"（待外部）"——这是产品决策，不是外部系统状态）：人对上面四个问题给出答案，本任务据此升级为可实现任务（指向候选 B，若裁决"要对齐"）或标记 won't-fix（若裁决"永远不对齐"，候选 A 定案）。

## DoD

- 本任务本身不改任何源码；它的产出是一份可供人决策的风险/选项记录与候选比较，不是实现。

<!-- dedup-ref -->
边界（dedup，本轮重新核实）：`grep -rl "goal_ac: AC-324" tasks/` 命中仅 gap-live-host-for-session-canonicalize（已 done，范围是另一条 live-host 查询，不是这道 lease 门）；`grep -rln "SESSION_HAS_ACTIVE_LEASES\|blockingLeases" tasks/*.md` 命中仅 gap-ac251-mcp-session-host-control（交付该门本身）与本任务；`gap-session-hosts-lease-driven-lifecycle`（AC-157，done）与 `gap-claude-resident-idle-close`（AC-165，done）交付的是 lease **驱动状态机**（busy/lingering/idle/关闭原因），与这道**显式 close 的 force 门**是完全不同的机制，不重叠。本任务与所有以上任务互补不重叠。
