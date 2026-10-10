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

1. `server/modules/session-hosts/resident-host.service.ts:320-327` 的模块私有 `liveHostForSession(sessionHostManager, appSessionId)`，供本模块内 `startResidentHost`/`closeResidentHost` 的三个调用点使用。
2. `server/modules/mcp-gateway/mcp-session-host-control.ts:297-305` 的 `readLiveHost(manager, sessionId)`，经 barrel 导出，投影到 `{mode, leases} | null`。
3. `server/modules/providers/services/sessions.service.ts:1249-1255` 的模块私有 `liveHostForSession(appSessionId)`，供 `switchSessionLifecycleMode` 使用。

语义等价证据：三处重实现都是 `manager.snapshot().find(h => h.state !== 'closed' && h.bindings.has(id))`；canonical 方法遍历 `hosts.values()`（不经 `snapshot()`/`withinRetention`）再 `copyHost`。`withinRetention` 对非 closed 宿主总返回 true，所以对「非 closed」子集两条路径逐字等价。

## Touches

- server/modules/session-hosts/resident-host.service.ts
- server/modules/mcp-gateway/mcp-session-host-control.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/session-hosts/tests/live-host-for-session.test.ts (new)

## AC

- [x] AC1 红态基线逐字记录：改动前运行 `for f in server/modules/session-hosts/tests/live-host-for-session.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done`，退出码 1，输出 `缺判据文件：server/modules/session-hosts/tests/live-host-for-session.test.ts`（2026-10-10 捕获，见会话记录）。
- [x] AC2 三处私有重实现已删除，三个调用点改为调用 `sessionHostManager.liveHostForSession` / `deps.sessionHostManager.liveHostForSession`；`readLiveHost` 保留导出签名与 `{mode, leases}` 投影，内部委派 canonical 方法（commit a4f146fb on task/gap-live-host-for-session-canonicalize，经 `git merge --no-ff` 落 develop）。
- [x] AC3 新判据 `server/modules/session-hosts/tests/live-host-for-session.test.ts` 绿：4 个用例（open+bound 命中、完全无绑定返回 null、closed 宿主在 retention 窗内仍在 snapshot() 但 liveHostForSession 返回 null、按 sessionId 精确区分两个活宿主）全部通过。
- [x] AC4 既有判据不改一字仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts server/modules/session-hosts/tests/resident-host-service.test.ts` 退出 0，11 个既有测试（含 AC-251 的 spy 计数与取假形态断言）全部通过；三文件合计 postmerge 在 develop 主 checkout 上重跑仍是 15 pass / 0 fail。
- [x] AC5 negative control：`git diff --stat` 对 `server/modules/session-hosts/session-hosts.routes.ts` 为空（未出现在改动文件列表里），`running` Set 构造逐字未动。
- [x] AC6 ArchGuard after（如实记录，不强行凑成"逐字相同"）：`modules/session-hosts` 包级环集合（size 8 / size 2 / size 2，成员列表）与 before-facts 逐字相同——零新增/移除的跨包边，证明这是纯体内收敛。`fanIn`/`fanOut` 数值从 9/31 变为 8/30（各 -1），已核实原因：`resident-host.service.ts` 删除重实现后不再从 `@/shared/types.js` 具名导入 `ProcessHost`（该导入只为旧函数的返回类型存在），减少一条 session-hosts→shared 的 fanOut 边；fanIn 的 -1 未能完全独立复核到单一具体边（怀疑是 ArchGuard 对 `.find()` 回调内联类型推断 vs 直接方法调用的静态分析口径差异，不是真实的新增/移除导入），如实记录为残留不确定性，不裁定为"假"。环集合（真正决定架构形状的不变量)逐字未变是本 AC 的主张,fanIn/fanOut 的 ±1 是记录在案的次要偏差。
- [x] AC7 `npm run typecheck` 退出 0；`npm run lint` 退出 0（仅既有的、与本次改动文件无关的 warning，无新增 warning/error）。
- [x] AC8 `git diff --stat develop...task/gap-live-host-for-session-canonicalize` 与 `## Touches` 逐条对齐（4 个文件，含新文件）；已用 `git merge --no-ff` 单次合并进 develop（commit 见 develop 历史），postmerge 在主 checkout 上重跑 AC3+AC4 的判据文件仍 15 pass / 0 fail，`npm run typecheck` 仍退出 0。

## DoD

- 三处重实现真的被删除，不是新增第四处包装；`readLiveHost`、`switchSessionLifecycleMode`、`startResidentHost`/`closeResidentHost` 的既有对外行为（HTTP 响应、MCP 工具返回值、spy 计数断言）真的逐字不变——由既有判据的 15/15 pass 证明。
- negative control（`session-hosts.routes.ts` 的 `running` Set）真的未被触碰——由零 diff 证明。
- ArchGuard after 的包级环集合真的与 before-facts 逐字相同；fanIn/fanOut 的 ±1 偏差已核实并如实记录，未被掩盖。
- 本会话直接实现：isolated worktree（`task/gap-live-host-for-session-canonicalize`，fork 自 develop）→ 实现 → 窄范围判据 → typecheck/lint → ArchGuard after → self-host 冒烟（真实进程在 worktree 内以 `SERVER_PORT=58173` 启动，`/api/session-hosts` 返回 401（鉴权中间件正确拦截，证明路由已挂载且改动文件在真实启动路径上不报错），随后干净关闭）→ merge develop into worktree → 单次 `git merge --no-ff` 进 develop → postmerge 窄范围判据与 typecheck 重跑绿。未跑全量 suite（AGENTS.md 内存上限指引：会话内不跑无界多文件 `--test`/全量 suite，留给本项目自己的 fan-in/CI）。
- 候选 #2（lease-close 安全策略搬迁）未被混入本次改动；风险调查见 follow-up 任务 `gap-session-host-control-lease-gate-rest-parity-followup`（todo，未实现）。

<!-- dedup-ref -->
边界（dedup）：`grep -rl "goal_ac: AC-324" tasks/` 命中仅本任务；`grep -rln "liveHostForSession\|readLiveHost" tasks/*.md` 命中的既有任务（gap-ac251-mcp-session-host-control 等）均只交付"建立"这些函数，不涉及三处的收敛去重，本任务与之互补不重叠。
