---
id: gap-fleet-tracks-per-run-session-mcp-exposure-followup
title: 跟踪请求：per-run 会话 MCP 层删除/TTL 暴露——已有 DB 级删除与进程 TTL，缺 MCP 暴露（沿用
  gap-cloudcli-per-run-session-delete-ttl-interface 的结论与挂点）
status: ready
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

## AC

- [ ] 本项目对"是否排期实现 MCP 层 per-run 删除/TTL 暴露"给出一次明确决定（排期/不排期均可，只要是明确决定而非沉默），写回本任务
- [ ] 若决定排期，给出承接任务的 id 或后续任务创建计划；若决定不排期，写明理由（如优先级/风险考量）

## DoD

本任务本身不实现任何代码、不改数据库、不改服务端文件；交付物是一次明确写回本任务体的排期决定，而不是一段沉默。"做完" = 上述两条 AC 都已有可核对的落笔证据：决定本身（排期或不排期）连同它的依据都写在任务体里——若决定排期，承接任务的 id 或后续创建计划一并写明；若决定不排期，则写明优先级与风险上的理由。决定一经落笔，本任务即告完成，不留任何后续实现责任：实现方案、挂点选择与验收判据全部归承接任务维护，本任务只保留指针，以免同一判据出现两份副本。全程对数据库与 per-run 会话相关代码保持只读。

## Touches

- tasks/gap-fleet-tracks-per-run-session-mcp-exposure-followup.md (self，零源码改动)
