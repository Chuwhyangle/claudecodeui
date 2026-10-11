---
id: gap-mcp-session-get-projectid-null-under-production-gateway-assembly
title: session_get 在生产装配下 projectId 恒为 null：createMcpGatewayModule 覆盖
  readTools.projects 时丢掉了 getProjectIdByPath（2d65c107 回归）
status: ready
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

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts` 退出码 0，含第 3 条的新断言；改动前该断言为红，失败行记录在完成记录里。
- [x] 取假：把 `createMcpGatewayModule` 恢复为整体替换且不带 `getProjectIdByPath` 后，新断言（或第 2 条的类型或运行时守卫）必须红；记录后恢复。
- [x] 下列既有判据逐文件运行退出码 0：`mcp-read-tools.test.ts`、`mcp-ui-last-opened.test.ts`、`mcp-gateway-wiring.test.ts`、`mcp-write-notification.test.ts`、`server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts`。另外 `npm run typecheck` 退出码 0。

## DoD

在真实服务实例上实际操作一次（`scripts/mcp-smoke.mjs` 的 `bootServer`，临时 `DATABASE_PATH`、`listen(0)`；**不得重启或改动正在运行的 CloudCLI 服务**）。播种一个项目及 205 个会话，经 `/mcp` 用真 PAT 调：`session_get` 取最新与最老两个会话，`projectId` 都等于该项目 id；`sessions_list {project:<该项目>}` 同一会话的 `projectId` 相同。逐字记录请求与响应摘要。仅有测试夹具通过不算完成，完成记录必须包含这一节。

## 完成记录

**要求 1（二选一取 A，理由）：** `createMcpGatewayModule` 的 `projects` 整体替换把调用方（生产里 `readTools: mcpReadToolDeps`）已经提供的 `getProjectIdByPath` 丢掉了。取 A——在该模块的 `projects` 字面量里补上 `getProjectIdByPath`（经 database barrel 的 `projectsDb.getProjectPath(p)?.project_id ?? null`），而不是「只覆盖缺失成员」：模块**有意独占** `projects` 这一袋（`McpGatewayModuleDeps.readTools` 的类型就把 `projects` 从调用方入参里 `Omit` 掉，目的正是让网关的项目读取只有一处来源）。合并调用方成员需要把该不变量放开，反而弱化「一处来源」；补一个成员既保住它，取值又与 `server/index.ts` 逐字一致，且不深层 import。

**要求 2（类型守卫）：** `McpReadToolDeps.projects.getProjectIdByPath` 由可选改为必填，`toSessionRow` 直接调用（去掉 `?.` 与 `?? null`）。同类装配遗漏从此在 `npm run typecheck` 变红。波及 7 个直接构造 `McpReadToolDeps` 的既有夹具，已逐一补上该成员：`mcp-ui-last-opened`、`mcp-run-get`、`mcp-overview`、`mcp-not-found-semantics`、`mcp-session-send`、`mcp-session-search`、`mcp-resolve-target`。这 7 个文件因此列入 `## Touches`（要求 2 明确要求「同步那些夹具」）；`server/index.ts` 与 `mcp-read-tools.test.ts` 原本就已提供该成员，未改动。

**要求 3 改动前红（逐字）：** 先只加断言（并把 (e) 腿的 `sessions` 换成生产同款——带 `readSessionById`），在 develop（5619613f）上运行：

```
production-session-wiring (e) byName={"isError":false,"payload":{"sessions":[{"id":"ac246-alpha-session",...,"projectId":"2351e0a9-9081-4255-8968-9f5c35efa13b",...}],"total":1}}
production-session-wiring (e) sessionGet={"isError":false,"payload":{"session":{"id":"ac246-alpha-session",...,"projectId":null,...},...}}
✖ (e) the production-same assembly resolves sessions_list `project` by name, refuses an ambiguous fragment, and keeps the exact id working (294.818785ms)
  AssertionError [ERR_ASSERTION]: session_get and sessions_list must agree on the same session projectId
  + actual - expected
  + null
  - '2351e0a9-9081-4255-8968-9f5c35efa13b'
      at /data/home/yale/work/claudecodeui-worktrees/gap-mcp-session-get-projectid-null-under-production-gateway-assembly/server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts:858:12
ℹ pass 4 / ℹ fail 1
```

**AC1 改动后绿：** `ℹ tests 5 / ℹ pass 5 / ℹ fail 0`；新读数 `production-session-wiring (e) sessionGet={"isError":false,"payload":{"session":{"id":"ac246-alpha-session",...,"projectId":"c3ccb1fa-2628-47a3-82f3-366ef7d07b73",...}}}` 与同一会话在 `byName` 里的 `projectId` 一致。

**AC2 取假（逐字，记录后已恢复）：** 把 `createMcpGatewayModule` 的 `projects` 恢复为整体替换（三读取器、无 `getProjectIdByPath`）后：

```
production-session-wiring (e) sessionGet={"isError":true,"payload":{"code":"INTERNAL_ERROR","message":"deps.projects.getProjectIdByPath is not a function","retryable":false}}
✖ (e) the production-same assembly resolves sessions_list `project` by name, refuses an ambiguous fragment, and keeps the exact id working
  AssertionError [ERR_ASSERTION]: session_get must read a session that exists
ℹ pass 4 / ℹ fail 1
```
类型守卫同时红：`server/modules/mcp-gateway/mcp-gateway.transport.ts(561,5): error TS2322: Type '{ projects: { getProjectsWithSessions: ...; getArchivedProjectsWithSessions: ...; getProjectSessionsPage: ...; }; ... }' is not assignable to type 'McpReadToolDeps | undefined'.` 随后已按要求 1 复原（提交 `ec07411f`）。

**AC3 逐文件退出码（全 0）：**

```
EXIT 0  server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-ui-last-opened.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-write-notification.test.ts
EXIT 0  server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-run-get.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-overview.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-session-send.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-session-search.test.ts
EXIT 0  server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
```
`npm run typecheck` EXIT 0；`npm run lint`（oxlint）仅既有 warning，无 error。

**DoD（真服务实例，逐字读数）：** 用 `scripts/mcp-smoke.mjs` 的 `bootServer`（临时 `DATABASE_PATH`、`HOST=127.0.0.1`、`listen(0)` 探得、`MCP_ENABLED=1`；**未触碰正在运行的 CloudCLI 3001 服务**）。编排脚本放在 `/tmp`（不入工作树）。先以独立 tsx 进程在临时库建项目目录 `.../projects/p-big` 并播种 205 个会话 `dod-s-000…dod-s-204`（`dod-s-204` 最新、`dod-s-000` 最老，最老者落在 200 行的最近页之外），再用 `seedAccessToken` 播一个真 PAT（`ccp_` 前缀、全 scope），经 `/mcp` 调用：

```
READ seed: projectId=0172d4c5-00a1-404e-9712-7b7c3840f5dc title=p-big sessions=205
READ pat: prefix=ccp_49db… user=2
READ session_get dod-s-204: isError=false text={"session":{"id":"dod-s-204","title":"seeded dod-s-204","provider":"claude","projectId":"0172d4c5-00a1-404e-9712-7b7c3840f5dc","lifecycleMode":"per-run","hostState":null,"running":false,"awaitingUser":false,"lastActivity":{"relative":"283 days ago","iso":"2026-01-01T03:24:00.000Z"}},"pendingInteraction":null,"host":null,"hostNote":"No host: this session currently has no host process (per-invocation process mode and not running).","run":null}
READ session_get dod-s-000: isError=false text={"session":{"id":"dod-s-000","title":"seeded dod-s-000","provider":"claude","projectId":"0172d4c5-00a1-404e-9712-7b7c3840f5dc",...,"lastActivity":{"relative":"283 days ago","iso":"2026-01-01T00:00:00.000Z"}},...,"run":null}
READ sessions_list project=p-big: isError=false text={"sessions":[{"id":"dod-s-204",...,"projectId":"0172d4c5-00a1-404e-9712-7b7c3840f5dc",...},... (205/most-recent-200 rows) ...]}
```

结论（脚本五条断言全 PASS，输出 `DOD OK`）：
- `session_get dod-s-204` 与 `session_get dod-s-000`（最新、最老，各在最近页内/外）的 `projectId` 都 = `0172d4c5-00a1-404e-9712-7b7c3840f5dc`，非 `null`；
- `sessions_list {project:"p-big"}` 中同一会话 `dod-s-204` 的 `projectId` 与之相同。

修复前同一路径退化为 `projectId: null`（见 Proposal 的 Finding）；本节的读数是修复后的真服务读数。

## Touches

- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-ui-last-opened.test.ts
- server/modules/mcp-gateway/tests/mcp-run-get.test.ts
- server/modules/mcp-gateway/tests/mcp-overview.test.ts
- server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts
- server/modules/mcp-gateway/tests/mcp-session-search.test.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
- tasks/gap-mcp-session-get-projectid-null-under-production-gateway-assembly.md（self）
