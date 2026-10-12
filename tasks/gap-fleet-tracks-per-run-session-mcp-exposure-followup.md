---
id: gap-fleet-tracks-per-run-session-mcp-exposure-followup
title: 跟踪请求：per-run 会话 MCP 层删除/TTL 暴露——已有 DB 级删除与进程 TTL，缺 MCP 暴露（沿用
  gap-cloudcli-per-run-session-delete-ttl-interface 的结论与挂点）
status: done
labels:
  - gap
  - tracking
parent: null
children: []
extra:
  schema: execution
---
## Proposal

`gap-cloudcli-per-run-session-delete-ttl-interface`（本项目自己的任务，已 `done`）已经给出权威判断：MCP 工具面确实没有删除/TTL 动词（`session_close`/`session_interrupt` 都不覆盖 per-run 会话），但服务端已有可用机制——`sessions.service.ts:957-1011` 的 `deleteOrArchiveSessionById`、`sessions.db.ts:1316-1319` 的 `DELETE FROM sessions`、`provider.routes.ts:909-921` 的 REST `DELETE /sessions/:sessionId`、以及进程级 TTL 常量 `session-host-manager.service.ts` 的 `PER_RUN_QUIET_CEILING_MS`/`RESIDENT_IDLE_TIMEOUT`。该任务还点名了两个仓库里**仅有的**周期性 timer 挂点，供后续任务复用（"不在本任务内做"）：`mcp-gateway.audit.ts:202-216` 的 `startMcpAuditRetention`（立即一次 + 每日 `setInterval`，时钟与 retention 天数都是注入缝）与 `scheduled-message-dispatcher.service.ts` 的 30s 轮询器。

这个"跟踪请求"任务的来源是本项目的兄弟项目 quay-fleet：它自己的 `fleet-p2-session-retention-and-gateway-blocker`（会话保留/自动清理策略任务）因为上面这条缺口，对 per-run 会话的处置只能停在"dry-run 评估 + 拒绝记录"，没有任何真正的清理路径。quay-fleet 的人（2026-10-12）明确要求"跟踪 claudecodeui 的 gateway delete/TTL task，自动推进上游，勿碰数据库"——quay-fleet 不会、也不能直接改本项目的代码或数据库，只能在本项目自己的任务板上提出请求，由本项目团队决定是否、何时排期实现。

本任务**不**预先设计实现方案，只请求本项目对已经识别出的缺口与挂点做一次排期决定：是否要把 MCP 层的 session_delete/TTL 暴露做出来，用哪个挂点、什么时候做。

查重核实（2026-10-12）：`gap-ac240-mcp-stateless-transport-mount-order`（传输挂载顺序）、`gap-ac268-oauth-e2e-flow`（OAuth 流程）、`gap-resident-idle-timeout-not-configurable`（RESIDENT 会话空闲超时可配置性，不是 per-run）、`gap-session-hosts-lease-driven-lifecycle`（宿主状态机由保活理由驱动）、`gap-ac244-mcp-audit-log-outcomes-and-retention`（审计日志表的保留策略，不同表）均与本任务范围不重叠。

## 排期决定（本项目，2026-10-12）

**决定：本轮不排期**——不为 MCP 层 per-run 删除/TTL 暴露分配公共 MCP 面预算。这是一个明确决定，不是沉默；依据与重启（承接）路径都落笔在本节，实现方案/挂点选择/验收判据一律由承接任务维护，本任务不复制判据。

### 依据

1. **缺口成立，但只在 MCP 面这一层，且现状未坏。** 沿用 `gap-cloudcli-per-run-session-delete-ttl-interface`（done）已裁定的结论，不重复其调查。本轮只在任务 worktree 内对其载荷点做零改动复核，结论未漂移：`grep -rn "session_delete" server/ src/ shared/` 零命中；`MCP_STAGE4_WRITE_TOOLS` 仍是钉死的五条（`server/modules/mcp-gateway/mcp-gateway.write-tools.ts:186`）；服务端删除机制在位（`server/modules/providers/services/sessions.service.ts:957` 的 `deleteOrArchiveSessionById`、`server/modules/database/repositories/sessions.db.ts` 的 `DELETE FROM sessions`、`server/modules/mcp-gateway/mcp-self-target.ts:77` 的 `MCP_SELF_TARGET_WRITE_OPS`）。⇒ 缺的只是 MCP 面的出口，不是机制。

2. **不排期的理由（AC2）——排期权不在本任务这一层，因此本轮不能排。**
   - 该变更是**能力新增**而非缺陷修复：现状没有坏，只是 MCP 客户端"清不干净"（无法删/归档一条已结束的 per-run 会话记录）。它改的是对外契约——新增工具名、新 scope 使用、`MCP_SELF_TARGET_WRITE_OPS` 自指保护面扩张，并牵动一串钉死契约（`MCP_STAGE4_WRITE_TOOLS` 五条 = AC-249 判据、`ACCESS_TOKEN_SCOPES`、错误码表、注解注册表，以及多张"每新增一个工具就红"的覆盖表）。
   - 上游任务 `gap-cloudcli-per-run-session-delete-ttl-interface` 的 AC2 已明确裁定：**"是否现在花这笔公共面预算"归人（yale）**。截至本轮该裁定尚未落笔，本项目不能代为提交这笔预算；本轮的明确决定因此是"不排期"（不分配预算），而不是沉默。
   - 这同时避免了制造一个立刻卡死的承接任务：上游任务已写明，在人裁定预算之前立案会立刻卡在"依赖的公共面契约还不存在"，不是真正可执行的任务。

### 重启（承接）路径

本任务只保留指针，不复制任何判据：

- **入口**：公共接口变更走本项目既定入口——"先立 GOAL + AC，再派实现任务"。承接实现任务**必须**引用 `gap-cloudcli-per-run-session-delete-ttl-interface`，**不得**重新调查"接口是否存在 / 机制是否存在"。
- **方向**：A（显式 `session_delete` 薄适配器，接既有 `deleteOrArchiveSessionById`）；B（基于 `lastActivity` 的自动 TTL 清理）不采纳，C 因此不成立。
- **承接任务必须自带的落地约束**：(i) 服务端运行态守卫（拒绝"有在跑 run 或有 live 宿主"的目标，`force` 才放行）；(ii) 默认软删（归档、可 restore；硬删需显式 `force`）；(iii) 进 `MCP_SELF_TARGET_WRITE_OPS`。
- **TTL 若将来要做**：仓库仅有的两个周期 timer 挂点是 `mcp-gateway.audit.ts` 的 `startMcpAuditRetention` 与 `scheduled-message-dispatcher.service.ts` 的 30s 轮询器。
- **触发条件**：人（yale）落笔"花这笔公共面预算"后，按上述入口立案；在此之前保持不排期。

### 边界（DoD）

本任务零源码改动、零数据库改动、零服务端改动；对数据库与 per-run 会话相关代码全程只读。交付物即本节文字。决定已落笔，本任务即告完成，不留任何后续实现责任。

## AC

- [x] 本项目对"是否排期实现 MCP 层 per-run 删除/TTL 暴露"给出一次明确决定（排期/不排期均可，只要是明确决定而非沉默），写回本任务
- [x] 若决定排期，给出承接任务的 id 或后续任务创建计划；若决定不排期，写明理由（如优先级/风险考量）

## DoD

本任务本身不实现任何代码、不改数据库、不改服务端文件；交付物是一次明确写回本任务体的排期决定，而不是一段沉默。"做完" = 上述两条 AC 都已有可核对的落笔证据：决定本身（排期或不排期）连同它的依据都写在任务体里——若决定排期，承接任务的 id 或后续任务创建计划一并写明；若决定不排期，则写明优先级与风险上的理由。决定一经落笔，本任务即告完成，不留任何后续实现责任：实现方案、挂点选择与验收判据全部归承接任务维护，本任务只保留指针，以免同一判据出现两份副本。全程对数据库与 per-run 会话相关代码保持只读。

## Touches

- tasks/gap-fleet-tracks-per-run-session-mcp-exposure-followup.md (self，零源码改动)
