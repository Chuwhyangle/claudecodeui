---
id: gap-cloudcli-per-run-session-delete-ttl-interface
title: Finding：CloudCLI MCP 网关缺少 per-run 会话删除/TTL 接口（跨项目发现，来自 quay-fleet 的
  2026-10-12 风暴清理）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Finding

**发现方（跨项目）**：quay-fleet（Fleet Manager）在 2026-10-12 的 wake 会话风暴事故取证与清理过程中发现——清理方（人工+另一条调查会话）为了清掉风暴残留的 per-run 会话，只能逐个 `session_interrupt` + `session_close`，而 `session_close` 对 per-run 会话的既有读数是 `mode:'resident'` 专属、per-run 场景答 "only-resident" 属预期拒绝（`src/delegate-smoke.mjs` 头注释已有记录）——即 **CloudCLI MCP 网关目前没有任何批量/TTL 清理 per-run 会话的接口**：

- 没有「删除/归档一个已结束的 per-run 会话记录」的写工具。
- 没有「per-run 会话超过 N 分钟无活动自动过期」的 TTL/生命周期策略。
- 清理只能逐条走 `sessions_list` 全量扫描 + 人工判断 + `session_interrupt`（仅对活跃会话有意义）——没有真正的"删除会话记录本身"的路径，所以像本次事故那样一次性产生几十个 per-run 会话残留时，只能让它们一直留在 `sessions_list` 里，无法清空。

**跨项目边界（Fleet 自己遵守的原则，供本项目参考）**：Fleet 侧的结论是"不得直接改网关数据库、不得未经授权误删活跃会话"——这正是因为**网关本身没有提供一个安全、幂等、范围明确的删除/TTL 接口**，任何客户端（包括 Fleet 自己）想清理，只能手搓脚本直接碰底层数据，风险很高。这条 Finding 只是如实转交现象，不代为设计 claudecodeui 侧的解决方案（那是本项目自己的决定）。

## 复核结论（本项目，2026-10-12：判断 + 技术方向 + 决策归属）

> 本任务是判断/记录性质，**零源码改动**（`## Touches` 只有本任务文件自身）。下面每一条都是本轮在任务 worktree 里直读源码得到的读数，不采信转述。

### AC1 —— 三个工具的真实语义（逐条直读）

1. **`sessions_list`（只读）** — 表 `MCP_STAGE3_READ_TOOLS`，`server/modules/mcp-gateway/mcp-gateway.read-tools.ts:133`（schema `:1244-1294`，body `:1202+`）。读的是 `sessions` 表的近期行 + 运行登记表算 `running`；行上的 `isArchived` 照报，但**归档行在列表里读作不存在**——`read-tools.ts:840` 的注释逐字：「An archived row reads as absent either way, because the recents page the listing reads excludes it」，实现在 `:844` `stored.isArchived === 0`。它**没有任何写路径**。
2. **`session_interrupt`** — `mcp-session-lifecycle.ts:427-442`，只调 `deps.control.abort(caller, { sessionId })`；头注释 `:418-423` 逐字：「The adapter calls ONLY `abort`. It holds no host-manager seam, so it cannot close a resident host or kill a process」。空闲会话答 `aborted:false` + `NO_RUN_TO_ABORT_MESSAGE`（`:253` 逐字：「This session currently has no run in flight, so there is no run to abort.」）。⇒ 只中止在飞运行，**不碰记录**。
3. **`session_close`** — `mcp-session-host-control.ts:276-302`：关的是**常驻宿主进程**，委派 `closeResidentHost`（`server/modules/session-hosts/resident-host.service.ts:230-286`）。per-run 被**显式拒绝**，与 Fleet 转述一致且给出了确切口径：`resident-host.service.ts:237-243` 与 `:273-278` 都以 `LIFECYCLE_MODE_NOT_RESIDENT`（HTTP 409）拒绝，逐字：「Session "X" runs in "per-run" mode; only a resident host can be closed on demand.」/「Session "X" is stored as "per-run"; only a resident session can be closed on demand.」。**即便成功，返回的也只是宿主读数**（`{hostId, sessionId, mode:'resident', closeReason:'user', leases}`，`mcp-session-host-control.ts:139-145`），**不删会话行**。
4. **MCP 面全量：无删除/归档动词。** 写工具表 `MCP_STAGE4_WRITE_TOOLS`（`mcp-gateway.write-tools.ts:186-212`）五条 + 旁挂 `ui_open_session`/`ui_focus_turn`/`ui_show_diff`/`ui_open_task`/`draft_set`/`draft_submit` + stage-6 `session_cancel_queued`/`session_reconfigure`/`session_background`（`mcp-gateway.resident-tools.ts:70-147`），**无一条**删记录。

⇒ **AC1 结论：Fleet 转述的前提属实** —— 这三个工具确实不覆盖"删除一个已结束的 per-run 会话记录"。

### 但前提属实 ≠ 缺口就是转述的那个形状（本任务要纠偏的地方）

删除机制**已经存在、且天天在跑**，只是不在 MCP 面：

- 服务层：`sessionsService.deleteOrArchiveSessionById`（`server/modules/providers/services/sessions.service.ts:957-1011`）。默认**软删**= 置 `isArchived=1`（`:976-983`，行保留、从活跃列表消失、可 restore）；`force` 才**硬删**（删转录文件 + `DELETE FROM sessions`，`server/modules/database/repositories/sessions.db.ts:1316-1319`）。
- 传输层：`DELETE /api/providers/sessions/:sessionId?force=&deletedFromDisk=`（`provider.routes.ts:909-921`；挂载点 `server/index.ts:1086` `app.use('/api/providers', authenticateToken, providerRoutes)` —— 走的是 JWT `authenticateToken`，不是 MCP 的 PAT）。
- 前端日常在用：`src/shared/api.ts:370 deleteSession` → sidebar 的归档/永久删除（`src/modules/sidebar/hooks/useSidebarController.ts:1006`、`src/modules/sidebar/SidebarModals.tsx:181-215`）。
- 归档后会话确实从 `sessions_list`/`session_get` 消失（上面 `read-tools.ts:840,844`），且可 `POST /api/providers/sessions/:id/restore` 还原。
- **记录级 TTL 确实没有**；但**进程级 TTL 早就有了**：per-run 宿主 `PER_RUN_QUIET_CEILING_MS = 30 * 60 * 1000`（`server/modules/session-hosts/session-host-manager.service.ts:44`）、resident `RESIDENT_IDLE_TIMEOUT = 24h` 且可用 `SESSION_HOST_RESIDENT_IDLE_TIMEOUT_MS` 覆盖（同文件 `:61-63`、`:79-107`）。⇒ 不存在"进程泄漏"，只有"**行**泄漏"。

**⛔ 安全面必须点名（Fleet 的边界原则在本仓库现状下反而更尖锐）**：`deleteOrArchiveSessionById` 与 HTTP 路由**都没有**"目标会话是否在跑 / 是否有常驻宿主"的**服务端**守卫；该判断目前**只存在于 UI**（`src/modules/sidebar/SessionOptions.tsx:23` 逐字：「A running session cannot be deleted or forked, matching the Projects row.」）。也就是说，**照现状把这条路原样搬上 MCP，会得到一个比 Fleet 自己那条"不得未经授权误删活跃会话"红线更松的接口**。

### AC2 —— 技术选型与决策归属

候选三条：**A** 显式 `session_delete` 写工具（薄适配器，接既有 `deleteOrArchiveSessionById`）；**B** 基于 `lastActivity`（`sessions.updated_at`）的自动 TTL 清理；**C** 两者结合。

**本任务采纳的方向：A（先做薄适配器）。B 不采纳，C 因此不成立。** 三条理由：

1. **B 是保留策略决定，不是接口决定** —— 它会在无人在场时自动删/藏用户数据。本仓库对"删除传播 / 保留期"已有先例把它**单列为决策**而不是顺手实现（`docs/proposals/cloudcli-mcp-control-observability-2026-10.md:99` 的 D5「搜索与删除传播另行讨论」、`:238` 的保留期边界），且 B 要解决的症状（"列表被几十条残留塞满"）用 A 的归档路径已能人工清干净，B 只是省手。
2. **A 的机制已存在、已被 UI 跑过**（上面 5 条证据），是"接线"而不是"造机制"，与 `session_close` 正是 `closeResidentHost` 的适配器**同形**，风险面最小。
3. A 一旦落地，B 退化为 A 的一次批量调用（或直接调同一个服务），不会返工。

**A 落地时必须带的三件事（写给后续实现任务，防止它只做"接线"）**：

- (i) **服务端运行态守卫**：适配器在委派前拒绝"有在跑 run 或有 live 宿主"的目标（`force` 才放行），补上目前 UI 独占的那条判断（`SessionOptions.tsx:23`）。
- (ii) **默认软删**：`force` 缺省即归档（可从 `sessions_list` 消失、可 restore），硬删必须显式 `force`。
- (iii) **自指保护**：`session_delete` 必须进 `MCP_SELF_TARGET_WRITE_OPS`（`server/modules/mcp-gateway/mcp-self-target.ts:77-82`）。⛔ 注意这与 `ui_*`/`draft_*` 的"旁挂不保护"先例**相反**——那两个不碰目标会话的写面，删会话碰。

**代价必须先说清（这决定它不是"顺手加一个工具"）**：公开工具名集在本仓库是一串钉死的契约 —— `MCP_STAGE4_WRITE_TOOLS` 的**五条**是 AC-249 自己的判据（`write-tools.ts:5-19`、`:497`、`:538` 三处注释都点明"length is AC-249's own pinned contract"），另有 `MCP_SELF_TARGET_WRITE_OPS`、`mcp-tool-annotations.ts` 的注册表、scope 词表 `ACCESS_TOKEN_SCOPES`、错误码表 `mcp-tool-error-codes.ts:80,134-140`，以及若干张"每新增一个工具就红"的覆盖表。⇒ 两条路：并入 stage-4 表（要动 AC-249 的五条计数判据），或沿用 `ui_*`/`draft_*` 的旁挂先例（不计入 AC-249，但**必须**自己进自指保护表）。

**谁决策（本任务的裁定，分两层，别混为一谈）**：

- **方向的选型（A vs B vs C）**：走**本项目既有机制** —— 即"先立 GOAL + AC，再派实现任务"（本仓库对功能/公共接口变更的既定入口；`session_delete` 属公共 MCP 面变更，不是实现细节）。本任务交出的是**方向建议 A** + 上面的落地约束与代价；后续 GOAL/任务**不得重新调查**"接口是否存在 / 机制是否存在"。
- **是否现在花这笔公共面预算**：**人（yale）**。因为 (a) 改的是对外契约（新增工具名 + 新 scope 使用 + 自指保护面扩张），(b) 它不是缺陷修复而是能力新增——现状没坏，只是"清不干净"，(c) 本仓库的 MCP 面每一阶段都是显式排期推进的（`docs/proposals/mcp-gateway-SPEC.md:58` 的 D8 阶段顺序；GOAL-020/023/039/040）。⛔ 本任务**不**代替这个裁定去实现工具。

### AC3 —— 如实记录的结论（两半都要说，不许只挑一半）

- **不成立的那一半**：Fleet 原话"没有真正的'删除会话记录本身'的路径"**不成立**。路径存在（上面 5 条证据），UI 天天在用；缺的只是 MCP 面的出口。⇒ 本项目**不**认领"要为 claudecodeui 造一个会话删除机制"这件事，也**不需要"强行实现一个不需要的接口"**。
- **成立的那一半**：**MCP 面上**确实没有删除/归档工具，也没有记录级 TTL；一个纯 MCP 客户端（Fleet 或任何 PAT 持有者）因此只能逐条 `session_interrupt`，永远清不掉 `sessions_list`。⇒ 缺口在"MCP 面"这一层**成立**，并被本任务精确化成**"暴露 + 守卫"**两件事（AC2 的 (i)(ii)(iii)）。
- 因此本任务**不**结为"不是缺口"（它确实是缺口），也**不在本任务内实现**（DoD 明确不要求）；落地的下一步是 AC2 那条 GOAL/任务路径，且需人先裁定是否花这笔公共面预算。

## AC

- [x] 核实现有 `session_close`/`session_interrupt`/`sessions_list` 的真实语义是否确实不覆盖"删除一个已结束的 per-run 会话记录"（本次 Finding 的前提，需要本项目自己复核，不采信转述）
- [x] 若确认缺口成立，提出至少一种方案的技术选型（例如显式 `session_delete` 工具 vs 基于 `lastActivity` 的自动 TTL 清理任务 vs 两者结合），并裁定由谁决策（人/本项目既有机制）
- [x] 如果本项目认为不是缺口（例如已有未暴露在 MCP 层的清理机制），如实记录结论并关闭本任务，而不是强行实现一个不需要的接口

## DoD

本项目对"per-run 会话缺少删除/TTL 接口"这个现象给出一次权威判断（缺口成立/不成立），若成立则有一个被采纳的技术方向；不要求本任务内就实现完整方案。

## Touches

- tasks/gap-cloudcli-per-run-session-delete-ttl-interface.md (self-touch; 本任务不改动任何源码文件)

## Evidence

**形态先例**：`tasks/gap-quay-tab-loop-pulse-gantt-cross-project-interface-design.md`（同形的跨项目接口判断任务：`## Touches` 只有任务文件自身、交付物就是任务体、零源码改动）。

**零源码改动（机械读数）**：本分支 `git diff --name-only $(git merge-base develop HEAD) HEAD` 只有 `tasks/gap-cloudcli-per-run-session-delete-ttl-interface.md` 一条，与 `## Touches` 逐条对齐（无多、无少）。`server/`、`src/`、`shared/`、`docs/` 逐字空输出。

**AC1 的读数位置**（全部在任务 worktree 内直读）：
- `server/modules/mcp-gateway/mcp-gateway.read-tools.ts:133`（`sessions_list` 名）、`:840` + `:844`（归档行读作不存在）、`:1244-1294`（schema）
- `server/modules/mcp-gateway/mcp-session-lifecycle.ts:418-423`（只调 abort 的形状论证）、`:427-442`（`buildSessionInterrupt`）、`:253`（`NO_RUN_TO_ABORT_MESSAGE`）
- `server/modules/mcp-gateway/mcp-session-host-control.ts:276-302`（`buildSessionClose`）、`:139-145`（返回投影只有宿主读数）
- `server/modules/session-hosts/resident-host.service.ts:237-243`、`:273-278`（per-run 的 `LIFECYCLE_MODE_NOT_RESIDENT` 拒绝）
- `server/modules/mcp-gateway/mcp-gateway.write-tools.ts:186-212`（stage-4 五条）、`server/modules/mcp-gateway/mcp-gateway.resident-tools.ts:70-147`（stage-6 三条）；`grep -rn "session_delete" server/ src/ shared/` 零命中

**"机制已存在"的读数位置**：
- `server/modules/providers/services/sessions.service.ts:957-1011`（`deleteOrArchiveSessionById`；软删 `:976-983`）
- `server/modules/database/repositories/sessions.db.ts:1316-1319`（`DELETE FROM sessions WHERE session_id = ?`）
- `server/modules/providers/provider.routes.ts:909-921`（`router.delete('/sessions/:sessionId')`）+ `server/index.ts:1086`（`app.use('/api/providers', authenticateToken, providerRoutes)`）
- `src/shared/api.ts:370`（`deleteSession`）、`src/modules/sidebar/hooks/useSidebarController.ts:1006`、`src/modules/sidebar/SidebarModals.tsx:181-215`
- 进程级 TTL：`server/modules/session-hosts/session-host-manager.service.ts:44`（`PER_RUN_QUIET_CEILING_MS`）、`:61-63`（`RESIDENT_IDLE_TIMEOUT`）、`:79-107`（`SESSION_HOST_RESIDENT_IDLE_TIMEOUT_MS` 读取点）
- 缺服务端守卫：`src/modules/sidebar/SessionOptions.tsx:23`（唯一那条"running 不可删"的判断在 UI）
- 公共面代价：`server/modules/mcp-gateway/mcp-self-target.ts:77-82`、`mcp-tool-error-codes.ts:80,134-140`、`docs/proposals/mcp-gateway-SPEC.md:58`

**TTL 若要挂的既有钩子（供后续任务，不在本任务内做）**：`server/modules/mcp-gateway/mcp-gateway.audit.ts:202-216`（`startMcpAuditRetention`：立即一次 + `setInterval(prune, MS_PER_DAY)`，`setInterval`/`now`/`retentionDays` 全为注入缝，启动于 `server/index.ts:1714`）与 `server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts:25,197-226`（`POLL_INTERVAL_MS = 30_000` 的轮询器，启动于 `server/index.ts:1769`）。仓库**没有**会话级 cron/调度模块；上述两条是唯一两个周期性 timer，也是 B 方案唯一合格的挂点。
