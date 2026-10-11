---
id: gap-mcp-session-get-projectid-null-under-production-gateway-assembly
title: session_get 在生产装配下 projectId 恒为 null：createMcpGatewayModule 覆盖
  readTools.projects 时丢掉了 getProjectIdByPath（2d65c107 回归）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**Finding（2026-10-11，复核 `2d65c107` 时真服务实测）：** `gap-mcp-session-get-past-recents-page-and-small-envelope-defects` 把 `session_get` 改为按 id 直接读会话行，`projectId` 由新的 `deps.projects.getProjectIdByPath(project_path)` 计算。`server/index.ts:283-288` 把这个方法加进了 `mcpReadToolDeps.projects`。但生产装配 `createMcpGatewayModule`（`server/modules/mcp-gateway/mcp-gateway.transport.ts:556-566`）会用一个只含 `getProjectsWithSessions / getArchivedProjectsWithSessions / getProjectSessionsPage` 的新对象**覆盖** `readTools.projects`，于是 `getProjectIdByPath` 被丢掉，`toSessionRow` 的可选链静默返回 `null`。

真服务读数（`bootServer` 临时实例，端口 11039；项目 `p-big` 下播种 205 个会话）：
- `session_get {session:"dod-s-204"}`（最新、在最近一页内）→ `projectId: null`；
- 同一实例 `sessions_list {project:"p-big"}` → `["dod-s-204","p-big"]`；
- `session_get {session:"dod-s-000"}`（最近一页外）→ 能解析成功，但 `projectId: null`。

也就是说，在生产装配下**所有**会话的 `session_get.projectId`（以及复用 `buildSessionDetail` 的 `ui_last_opened_session`）都从正确值退化成了 `null`，违反了原任务「行的投影与现在逐字段一致」。单元测试全绿，因为 `mcp-read-tools.test.ts` 的夹具直接提供 `projects`，不经过 `createMcpGatewayModule` 的覆盖。运行中的服务尚未重启，仍是旧代码，所以目前没有线上影响；**在本修复落地前不应重启服务到 develop**。

**要交付：**

1. `createMcpGatewayModule` 的 `projects` 覆盖里补上 `getProjectIdByPath`，取值方式与 `server/index.ts` 一致：经 database 模块 barrel 的 `projectsDb.getProjectPath(p)?.project_id ?? null`，不深层 import。更稳妥的写法是只覆盖缺失成员而不整体替换，二选一，在完成记录里说明理由。
2. 把 `McpReadToolDeps.projects.getProjectIdByPath` 由可选改为必填，或在 `toSessionRow` 缺这个依赖时显式报错而不是静默 `null`，让同类装配遗漏在类型检查或测试里变红。若改为必填会波及其他夹具，就同步那些夹具。
3. 回归断言写进既有的 `server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts`（它的 (e) 腿就是「生产同款装配在运行时」）：经 `createMcpGatewayModule` 装配后，`session_get` 读出的 `projectId` 等于 `sessions_list` 里同一会话的 `projectId`，且不为 `null`。先写断言、在当前 develop 上观察红，逐字记录失败行。不新增测试文件。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts` 退出码 0，含第 3 条的新断言；改动前该断言为红，失败行记录在完成记录里。
- [ ] 取假：把 `createMcpGatewayModule` 恢复为整体替换且不带 `getProjectIdByPath` 后，新断言（或第 2 条的类型或运行时守卫）必须红；记录后恢复。
- [ ] 下列既有判据逐文件运行退出码 0：`mcp-read-tools.test.ts`、`mcp-ui-last-opened.test.ts`、`mcp-gateway-wiring.test.ts`、`mcp-write-notification.test.ts`、`server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts`。另外 `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。播种一个项目及 205 个会话，经 `/mcp` 用真 PAT 调：`session_get` 取最新与最老两个会话，`projectId` 都等于该项目 id；`sessions_list {project:<该项目>}` 同一会话的 `projectId` 相同。逐字记录请求与响应摘要。仅有测试夹具通过不算完成，完成记录必须包含这一节。

## Touches

- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/index.ts
- tasks/gap-mcp-session-get-projectid-null-under-production-gateway-assembly.md（self）
