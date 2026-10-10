---
id: gap-live-host-for-session-canonicalize
title: 三处会话→活宿主重实现收敛到 sessionHostManager.liveHostForSession（AC-324）
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-324
---
## Proposal

AC-324（GOAL-036）要求把三处各自重实现的「会话→活宿主」查询收敛到 `session-host-manager.service.ts:1585` 已有的、经 session-hosts barrel 导出的 `sessionHostManager.liveHostForSession(appSessionId): ProcessHost | null` 方法：

1. `server/modules/session-hosts/resident-host.service.ts:320-327` 的模块私有 `liveHostForSession(sessionHostManager, appSessionId)`，供本模块内 `startResidentHost`/`closeResidentHost` 的三个调用点（约 `:112`、`:207`、`:235`）使用。
2. `server/modules/mcp-gateway/mcp-session-host-control.ts:297-305` 的 `readLiveHost(manager, sessionId)`，经 barrel 导出，投影到 `{mode, leases} | null`。
3. `server/modules/providers/services/sessions.service.ts:1249-1255` 的模块私有 `liveHostForSession(appSessionId)`，供 `switchSessionLifecycleMode`（约 `:1184`）使用。

语义等价证据（已在 GOAL-036 body 写明，这里复述关键点）：三处重实现都是 `manager.snapshot().find(h => h.state !== 'closed' && h.bindings.has(id))`；canonical 方法遍历 `hosts.values()`（不经 `snapshot()`/`withinRetention`）再 `copyHost`。`withinRetention`（`session-host-manager.service.ts:1591-1600` 附近）对非 closed 宿主总返回 true，所以对「非 closed」子集两条路径逐字等价；canonical 方法还少一次整表复制。

## Touches

- server/modules/session-hosts/resident-host.service.ts
- server/modules/mcp-gateway/mcp-session-host-control.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/session-hosts/tests/live-host-for-session.test.ts (new)

## AC

- [ ] AC1 红态基线逐字记录：改动前运行 `for f in server/modules/session-hosts/tests/live-host-for-session.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done`，退出码 1，输出 `缺判据文件：server/modules/session-hosts/tests/live-host-for-session.test.ts`（已于 2026-10-10 捕获，见会话记录）。
- [ ] AC2 三处私有重实现被删除，三个调用点改为调用 `sessionHostManager.liveHostForSession` / `deps.sessionHostManager.liveHostForSession`；`readLiveHost` 保留导出签名与 `{mode, leases}` 投影，内部委派 canonical 方法。
- [ ] AC3 新判据 `server/modules/session-hosts/tests/live-host-for-session.test.ts` 绿，覆盖 open/closed/bound/unbound 四种宿主下 `liveHostForSession` 的既有行为基线。
- [ ] AC4 既有判据不改一字仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts server/modules/session-hosts/tests/resident-host-service.test.ts` 退出 0。
- [ ] AC5 negative control：`git diff` 对 `server/modules/session-hosts/session-hosts.routes.ts` 的 `running` Set 构造逐字零改动。
- [ ] AC6 ArchGuard after：`archguard_get_package_metrics`（scope=server, packageName=modules/session-hosts）与 `archguard_detect_cycles(outputScope=package)` 的结果与 2026-10-10 审查报告的 before-facts（fanIn 9 / fanOut 31 / 无环）逐字相同。
- [ ] AC7 `npm run typecheck` 与 `npm run lint` 退出 0（写下退出码）。
- [ ] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；合并到 develop 后，窄范围判据（AC3+AC4 的测试文件）再次逐字通过（postmerge）。

## DoD

- 三处重实现真的被删除，不是新增第四处包装；`readLiveHost`、`switchSessionLifecycleMode`、`startResidentHost`/`closeResidentHost` 的既有对外行为（HTTP 响应、MCP 工具返回值、spy 计数断言）真的逐字不变。
- negative control（`session-hosts.routes.ts` 的 `running` Set）真的未被触碰。
- ArchGuard after 真的与 before-facts 逐字相同（证明零包级边变化，纯体内收敛）。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、不新增无消费者导出）与 AGENTS.md 测试内存上限指引（本任务只跑窄范围判据文件，不在会话内跑全量 suite）。
- 候选 #2（lease-close 安全策略搬迁）未被混入本次改动；其风险调查另行记录为 follow-up，不在本任务 Touches 内实现。

<!-- dedup-ref -->
边界（dedup）：`grep -rl "goal_ac: AC-324" tasks/` 为空（本任务是第一个）；`grep -rln "liveHostForSession\|readLiveHost" tasks/*.md` 命中的既有任务（gap-ac251-mcp-session-host-control 等）均只交付「建立」这些函数，不涉及三处的收敛去重，本任务与之互补不重叠。
