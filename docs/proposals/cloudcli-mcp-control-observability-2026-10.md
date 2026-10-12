# CloudCLI MCP 控制面与观测面改进（2026-10）— 长期讨论记录

> 状态：**第 0 阶段已落地（含 1 个待发布的生产回归修复）；第 1 阶段 AC-334/336/337 已派发给 driver，AC-335 定稿待最终点头；一个独立的发布新鲜度检测任务已派发**。本文件是该长会话的唯一事实账本：证据、分歧、决策、进度都追加在这里。
> 发起：外部 ChatGPT Agent（10/7–10/11 高频经 CloudCLI MCP 使用 ClaudeCodeUI / Quay 等项目）。
> 维护者：本仓库内的 Claude 会话。每轮讨论后更新 §6 决策表、§8 进度日志与 §9 的最新一轮小节。

## 0. 先校正一个事实前提

- **CloudCLI 就是本仓库**（`package.json` name=`@yalehwang/cloudcli`，MCP 服务在 `server/modules/mcp-gateway/`）。不存在独立的「CloudCLI 服务」仓库。所以「属于 CloudCLI 还是 ClaudeCodeUI」的边界问题，实际是 **CloudCLI（本仓库 server）vs Quay（各项目内的任务/门控系统）**。
- 既有边界（`docs/proposals/cloudcli-ai-manager.md` §3 D3、`mcp-gateway-SPEC.md` §非目标）：CloudCLI 汇总并投影跨项目状态，负责 session/host/run、MCP 控制面和鉴权，**不判断该做什么**；Quay 负责 task/goal 状态、driver、gate；**CloudCLI 对 Quay 状态只读**。
- 「没有完整历史 MCP 调用审计」**不完全成立**：`mcp_audit_log`（AC-244）每次调用写一行，含 `tool / outcome / duration_ms / client_id / token_id / args_digest`，保留 90 天。它没记的是**错误码、返回体积、关联 Operation**。§1 的基线就取自这张表。

## 1. 证据基线（`mcp_audit_log`，2026-10-07 00:00 → 10-11 09:40，只做聚合，不读参数）

共 2777 次调用、5 个调用方，头部调用方 2558 次（≈92%）。

| tool | n | err | p50 ms | p95 ms | max ms | 解读 |
|---|---|---|---|---|---|---|
| session_read | 1543 | 10 | 36 | 98 | 1875 | 占 56%：靠反复读来轮询，缺增量/变化流 |
| session_get | 342 | 15 | 45 | 66 | 248 | |
| session_send | 201 | 0 | 1006 | 15025 | 21215 | 含 waitSeconds |
| quay_snapshot | 181 | 6 | 814 | 3789 | 14625 | 冷缓存要 spawn CLI；`task list` 输出 26MB 级 |
| sessions_list | 145 | **32 (22%)** | 14 | 22 | 96 | 错误率最高；与 P0(1) 歧义吻合，但审计**没存错误码**，无法确证 |
| run_get | 140 | 14 | 12287 | 25034 | 25132 | 长轮询（max 25s），属预期 |
| projects_list | 50 | 0 | 52 | 67 | 72 | |
| session_search | **1** | 0 | **24591** | — | — | 几乎没人用；唯一一次 24.6s（每次全量 ripgrep 扫 JSONL） |
| 其余 13 个工具 | 合计 ≤ 50 次 | | | | | |

代理指标（头部调用方）：两次写操作之间的读调用数 **p50=5，p90=22，max=98**（243 次写）。这只是「完成一个推进意图要多少次调用」的**近似**，因为没有意图/Operation 标记，无法精确分组。（10-11 第二轮按 §1.1 的口径重算为 p50=4，见下。）

### 1.1 基线口径（2026-10-11 第二轮固定，之后所有前后对比都按这个口径）

- **数据源**：`$DATABASE_PATH`（默认 `~/.cloudcli/auth.db`）的 `mcp_audit_log`，**只读**打开，只取 `tool / outcome / duration_ms / client_id / token_id / at`，**不读 `args_digest`**。
- **时间窗**：`at` 存的是 UTC（`YYYY-MM-DD HH:MM:SS`）。基线窗为 **[2026-10-07 00:00:00, 2026-10-11 10:00:00) UTC**，左闭右开、固定端点，可重复计算。
- **调用方**：`coalesce(client_id, 'pat:'||token_id)`。头部调用方指调用次数最多的那个（2558/2777，92.1%）。**它是否就是外部 ChatGPT Agent 未经核实**：审计没有客户端名称，只能从量级推断。
- **分位数**：最近秩法，`a[ceil(p·n)−1]`，基于 `duration_ms`。
- **写操作**：工具注解里 `readOnlyHint=false` 的 15 个工具，且 `outcome=ok`。包括 `session_send/create/start/close/interrupt/reconfigure/background/cancel_queued`、`approval_answer`、`draft_set/submit`、`ui_open_session/focus_turn/show_diff/open_task`。
- **两次写之间的读调用数**：按时间排序同一调用方的调用，每遇到一次成功写操作，就把之前累计的非写调用数记为一个样本并清零。这个**代理**指标会把「同一意图里的多次写」切成多段，把「跨意图的空闲轮询」并进下一段，所以只能用于同一客户端的**前后对比**，不能当作绝对的「每意图调用数」。精确度量要等 AC-337 的 correlationId。
- **无法计算的项**：错误码分布、返回体积、按意图分组。审计没有这三列，由 AC-334 补上。

| 指标（固定窗） | 值 |
|---|---|
| 调用总数 / 调用方数 | 2777 / 5 |
| 整体错误率 | 88/2777 = 3.2% |
| 整体耗时 p50 / p95 | 39 ms / 4085 ms（p95 被 run_get 与 session_send 的长轮询拉高） |
| session_read 占比 | 55.6% |
| sessions_list 错误率 | 32/145 = 22.1% |
| 头部调用方成功写次数 | 270 |
| 两次写之间的读调用 p50 / p90 / max | **4 / 22 / 98** |

可复现脚本（只读）：

```js
// node baseline.cjs "2026-10-07 00:00:00" "2026-10-11 10:00:00"   （在仓库根运行，用的是仓库自带的 better-sqlite3）
const D=require(process.cwd()+"/node_modules/better-sqlite3");
const db=new D((process.env.DATABASE_PATH||process.env.HOME+"/.cloudcli/auth.db"),{readonly:true});
const [from,to]=process.argv.slice(2);
const rows=db.prepare("select tool,outcome,duration_ms d,coalesce(client_id,'pat:'||token_id) c,at from mcp_audit_log where at>=? and at<? order by at, rowid").all(from,to);
const q=(a,p)=>{if(!a.length)return null;a=[...a].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.ceil(p*a.length)-1)]};
const W=new Set(["session_send","session_create","session_start","session_close","session_interrupt","session_reconfigure","session_background","session_cancel_queued","approval_answer","draft_set","draft_submit","ui_open_session","ui_focus_turn","ui_show_diff","ui_open_task"]);
const cnt={};for(const r of rows)cnt[r.c]=(cnt[r.c]||0)+1;const top=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0][0];
const g=[];let n=0;for(const r of rows.filter(r=>r.c===top)){if(W.has(r.tool)&&r.outcome==="ok"){g.push(n);n=0}else n++}
console.log({rows:rows.length,topCalls:cnt[top],okWrites:g.length,p50:q(g,.5),p90:q(g,.9),max:Math.max(...g)});
```

## 2. 现状矩阵（逐条对照建议；→ 表示已有归属）

| # | 建议 | 现状 | 依据 | 已有任务/目标 |
|---|---|---|---|---|
| P0-1 | 项目解析 UUID > 精确名 > 路径 | **部分实现，且有缺陷**：顺序是「精确 id → 不区分大小写的子串（唯一命中才接受）」，**没有「精确标题」这一层，也不匹配路径**。`project="quay"` 遇上 quay-web/foo-quay 必然 `TARGET_AMBIGUOUS` | `mcp-resolve-target.ts:154-194` | AC-246 / `gap-ac246-…` 已 done；**「精确标题优先」没有任务** |
| P0-1b | 结构化歧义错误 | **已实现**：`TARGET_AMBIGUOUS` + `details{query,kind,candidates[{id,title}]}`；候选里没有 path / matchType | `mcp-resolve-target.ts:211-221` | 同上 |
| P0-2 | session_search | **全文检索已实现**（字面量、不区分大小写、按 provider/speaker 过滤、返回 messageId+snippet，可接 `session_read around`）。**缺**：时间过滤、turnId、稳定游标（现在是 skip 计数）、性能（每次全量 ripgrep）、语义检索 | `mcp-session-search.ts`, `session-conversations-search.service.ts:642` | `gap-mcp-session-search`、`gap-mcp-cross-project-session-aggregation` 已 done；缺口无任务 |
| P0-3 | workspace/project_changes | **未实现**。没有持久化事件日志；run / approval / host 都只在内存（run 保留 5 分钟），重启即丢 | storage audit §4/§5 | 无（`cloudcli-ai-manager.md` 的 G2「无事件发布载体」只是提案） |
| P0-4 | Operation 闭环 | **未实现**。没有任何关联 id，最接近的是 run 的 `source=mcp` | — | 无；`cloudcli-ai-manager.md` G1/G4 只是提案 |
| P1-5 | structured transcript / sinceSeq | **部分实现**：latest/outline/around 三种模式加 4000 字符文本游标；**latest/around 的文本里没有 messageId**；没有 afterSeq（SPEC:274 写了但未实现）；Codex 消息 id 每次读都重新生成（不稳定） | `read-tools:565-577,979-997` | GOAL-027 把 session_read 分页列为**非目标**；没有归属 |
| P1-6 | Quay task_trace / freshness | trace **未实现**；freshness **部分实现**（`status: cached/refreshed`、`generatedAt`；没有 ageMs/source/observedAt） | `mcp-overview-tools.ts:494-512` | AC-247 已 done；AC-282（描述与行为一致）在草稿 GOAL-023，没有任务 |
| P1-7 | 统一 pending interaction | **基本已实现**：`approvals_list`（工具审批 + AskUserQuestion 合并展开）、`pendingInteraction`、`approval_answer` 幂等、`session_send.blockedBy` | `mcp-approvals.ts` | 4 个任务均 done |
| P1-8 | UI 导航确认 / 多设备 | **基本已实现**：投递确认（applied/declined/unresponsive），最终结果用 `ui_visible_context{navigationId}` 查（内存，10 分钟），多设备需显式 client。**缺**：messageId/turnId 不做服务端存在性校验；按 turn 定位被推迟 | `ui-navigation.service.ts`, `mcp-ui-focus-turn.ts:71` | 多个 done；缺口无任务 |
| P2 | 分页/fields/compact/批量/重启 | sessions_list 只有 limit（≤200）+ total，没有 cursor；没有 fields/compact；没有批量；重启能识别（bootId、`RUN_NOT_FOUND{reason}`）但 run 状态会丢 | | **草稿 GOAL-027（AC-298..302）**已覆盖 cursor、runId、输出 schema，但没有任务 |
| T | 调用遥测 | **部分实现**：审计表 + 90 天保留 + `GET /api/settings/mcp-audit`（该路由**不返回 duration**）。没有错误码、返回体积、聚合（p50/p95）、Operation 关联 | `mcp-gateway.audit.ts`, `schema.ts:414-424` | AC-244 / AC-304 已 done；聚合无任务 |

审计顺带发现的小缺陷（目前都**没有任务**）：
- B1 `session_get` 只在最近 200 个会话里查找：网关已经解析出的较老会话仍会报 `SESSION_NOT_FOUND`（`read-tools:632-633,700-704`）。
- B2 `quay_snapshot` 缺 `project` 参数时抛普通 `Error`，没走 `McpToolError` 信封（`mcp-overview-tools.ts:637-641`）。
- ~~B3 `SELF_TARGET` 和 `MESSAGE_NOT_FOUND` 实际会发出，但不在 `MCP_ERROR_CODES` 词表里。~~ **10-11 撤回**：这是设计如此。`mcp-error-envelope.ts:28-33` 写明服务自身的合法错误码原样透传，不改写成网关码。
- B2 补充事实：因为 `inputSchema` 里 `project` 是可选的，缺少它时会进入处理函数抛普通 `Error`，被 `toMcpErrorResult` 映射成 `INTERNAL_ERROR`（`mcp-error-envelope.ts:601-602`）。一个调用方参数错误就这样被报成了服务端故障。
- B4 `/api/settings/mcp-audit` 不返回 `duration_ms`。

## 3. 架构立场（批判性讨论）

**R1 归属。** 下面的东西归 CloudCLI：会话、run、审批、UI 导航相关的观测与检索；跨项目聚合；调用遥测。下面的归 **Quay**：task/goal 的状态迁移史（trace）、gate 结论、「实质进展」的语义。CloudCLI 只**转述**并标注来源与新鲜度，不自己推断。所以 `task_trace` 应由 Quay 导出（如 `quay task trace <id> --json`，或 `task log --since`），CloudCLI 只做薄透传。在 Quay 导出之前，最多读该项目 `git log -- tasks/` 的提交标题（例如 `tasks: X todo→ready`），且必须标注 `source: git-commit-subject (heuristic)`。

**R2 不做第二个调度器。** Operation 不应是一个有状态、会推进的实体。最小形态是一个**关联标签**（correlationId）：调用方在写操作上自愿携带，网关把它记进 run 元数据和审计；读侧按标签聚合。它不排程、不重试、不判定完成；完成与否仍以 Quay gate 为准。推荐默认把 **Quay task id** 当作标签值，不另造实体。

**R3 增量优先于全量。** 现有用法是「轮询 session_read 和 quay_snapshot」（占 63%）。最小的杠杆是一个**按需计算的变化流**：不建事件总线、不建持久化 journal，直接用已有、带时间戳的数据源（`sessions.updated_at`、内存里的 run/approval 注册表、Quay 缓存的 `updatedAt`、tasks/ 的 git 提交）拼出「since 游标之后的变化」。只有在证明这种拼接丢事件时，才升级成持久化 journal。

**R4 活性 ≠ 进展。** 变化流里每条事件必须带 `signal` 分类：`liveness`（会话有新消息、run 在跑）、`progress`（Quay 状态迁移、提交、AC 勾选、gate 结论）、`blocked`（pending interaction、needs-human、gate 红）。「会话很活跃」不得被当作「任务在推进」。

**R5 检索先治性能，语义检索往后放。** 唯一一次 session_search 调用耗时 24.6s。先用 `sessions.updated_at` 做 since/until 预过滤，缩小 ripgrep 要扫的文件集，再把游标改成稳定的键集游标。FTS5 或向量索引意味着**另存一份转录副本**，会带来保留期、删除传播、隐私面的问题，应作为单独决策（D5）。

**R6 兼容。** 错误码保持 `TARGET_AMBIGUOUS`，不改名成 `AMBIGUOUS_PROJECT`（改名会破坏已有客户端），已有的 `details.kind=project` 就能区分；只**增**字段（`candidates[].path`、`matchType`）。所有新参数都是可选的，默认行为不变，只有 P0-1 的解析顺序是例外，见 D1。

**R7 权限现实。** 系统是单用户的，MCP scope 粒度是「用户」，**没有按项目的 ACL**，`project` 参数只是过滤条件，不是授权。所以跨项目的变化流和检索不会扩大暴露面（`cloudcli:read` 就够）。但如果将来要多租户或按项目授权，这些聚合工具是第一批需要加 ACL 的地方，应记作已知债务。

## 4. 最小方案与接口契约（草案）

### 阶段 0 — 修正与打点（小、低风险、立刻减少调用）

**0a 解析顺序（P0-1）**，在 `resolveMcpTarget` 中依次：
1. 精确 id（逐字匹配，现状）；
2. *(项目)* 绝对路径完全等于 `project_path`（路径在库里唯一，零歧义）；
3. 去掉首尾空白后，**精确标题**唯一命中（先区分大小写，再不区分大小写）；多个项目精确同名（如两个 `app/` 目录）时 → `TARGET_AMBIGUOUS`；
4. 子串唯一命中（现状；只作为发现用的兜底，写工具上是否允许见 D1）；
5. 否则报 `TARGET_AMBIGUOUS` / `*_NOT_FOUND`，`details.candidates[] = {id, title, path?, matchType: "exact_title"|"substring"}`。

可复现测试（加在 `tests/mcp-resolve-target.test.ts`）：fixture 为 `quay`、`quay-web`、`foo-quay`。期望：`"quay"` → quay 的 id；`"QUAY"` → 同一个 id；`"web"` → quay-web；`"qua"` → AMBIGUOUS 且有 3 个候选并带 path；两个同名 `app` → AMBIGUOUS；用绝对路径 → 命中；归档项目不参与。真实 DoD：在真服务上调用 `sessions_list(project="quay")` 和 `quay_snapshot(project="quay")` 都成功。

**0b 审计补列**（迁移只加列）：`error_code TEXT NULL`、`response_bytes INTEGER NULL`、`correlation_id TEXT NULL`。仍然**不存参数正文或返回正文**。`/api/settings/mcp-audit` 补上 `durationMs`。新增只读聚合：`GET /api/settings/mcp-audit/stats?since=&groupBy=tool|client|error_code`，返回 n/ok/err/p50/p95/bytes。是否同时暴露成 MCP 工具见 D6。

**0c 小缺陷 B1–B3。**

### 阶段 1 — 增量观测与检索（解决「轮询 63%」）

**1a `changes`（只读，`cloudcli:read`）。** 一个工具，用 `projects` 参数覆盖 workspace 和 project 两种作用域，不拆成两个工具。
```
input:  { cursor?: string, since?: ISO8601, projects?: string[] , kinds?: ("session"|"run"|"interaction"|"quay_task"|"quay_gate"|"commit")[], limit?: 1..200 (default 50) }
output: { cursor: string, generatedAt, bootId, complete: boolean,
          events: [{ kind, project:{id,title}, at, signal:"liveness"|"progress"|"blocked",
                     ref:{ sessionId?|runId?|taskId?|commit? }, summary: string,      // 不含消息正文
                     source:{ type:"db.sessions"|"mem.runs"|"mem.approvals"|"quay.cache"|"git", observedAt, ageMs } }],
          gaps: [{ kind, reason }] }   // 例：bootId 变化 → 此前内存中的 run/approval 变化不可见
```
语义：
- 游标是不透明的 `{v, watermark, bootId, perProjectHead}`；投递语义为 **at-least-once**，可能重复，调用方按 `(kind, ref, at)` 去重。
- 不触发全量 `synchronizeSessions`，只读 watcher 维护的数据库，因此存在 watcher 延迟，会在 `source.ageMs` 里如实暴露。
- 会话查询用 `WHERE updated_at > ? ORDER BY updated_at LIMIT ?`，需要给 `sessions.updated_at` 加索引。
- Quay 部分只读缓存，冷缓存时不 spawn CLI，返回 `gaps:[{kind:"quay_task", reason:"cache cold"}]`。

**1b `session_search` 增强**（全是可选参数）：
- `since` / `until`：在 ripgrep 之前按 `sessions.updated_at` 预过滤；
- 结果增加 `turnIndex`（与 outline 的 `#index` 对齐）；
- 游标改为键集 `(lastActivity, sessionId)`，旧的 skip 游标仍然接受；
- 若不带任何 project/since 时扫描超过 N 个文件，返回 `truncated` 并提示收窄范围，**不再静默跑 25 秒**（是否启用见 D5）。

**1c `session_read` 结构化**（可选 `format:"structured"`）：
- 输出 `messages[]`，每条为 `{id, role, at, turnIndex, text, truncated, toolSummary?}`；
- 文本模式的 latest/around 行也带上 id；
- 新增 `afterId`：返回该 messageId 之后的消息，基于持久化 id，**不用 run seq**，因为 run seq 重启即丢；
- Codex 的 id 不稳定，结果里标 `idStable:false`。

### 阶段 2 — 来源与关联

- **2a Quay freshness**：所有 Quay 投影统一带 `{source:"quay-cli"|"cache"|"worker-round.jsonl", observedAt, ageMs}`。
- **2b `task_trace`**：先在 Quay 立项导出接口（不属于本仓库），CloudCLI 侧做透传；过渡期用 git 提交标题，并标注为启发式。契约草案见下。

**2b′ Quay 导出接口契约草案（D3，供在 Quay 仓库立项用；本仓库不实现 Quay 侧）**

两个只读 CLI 动词，与 Quay 已有的 `task list --json` 同一族。CloudCLI 的 `quay-process.ts` 白名单只需各加一条。

```
quay task trace <task-id> --json [--root <path>]
quay task log --since <ISO8601|cursor> [--until <ISO8601>] [--limit <n>] --json [--root <path>]

TaskTransition = {
  taskId, at,                       // 迁移发生的时间（写入 store 的时间）
  from, to,                         // status 迁移；非状态事件时 from=to
  event: "status" | "ac_tick" | "gate" | "fan_in" | "worker_start" | "worker_exit" | "needs_human",
  actor: { kind: "promotion-driver" | "worker-driver" | "goal-driver" | "cli" | "mcp" | "human", id?: string, sessionId?: string },
  evidence?: { gate?: string, verdict?: "pass"|"fail", treeSha?: string, commit?: string, logPath?: string },
  source: "statusLog" | "gate-events.jsonl" | "worker-round.jsonl" | "git"   // 事实出处，必填
}
trace 输出: { taskId, status, transitions: TaskTransition[], generatedAt }
log   输出: { transitions: TaskTransition[], nextCursor, complete: boolean, generatedAt }
```

约束：
- `source` 必须是 Quay 自己的结构化记录。**提交标题不是合法 source**；Quay 若只能从提交标题回推，必须标 `source:"git"` 并加 `inferred: true`。
- `actor.sessionId` 对应 `cloudcli-ai-manager.md` 的 G1（谁改的状态），是可选字段，Quay 能拿到才填。
- CloudCLI 侧只做透传，外加 `{source:"quay-cli", observedAt, ageMs}`，不做任何推断。

在 Quay 导出落地之前，CloudCLI 的变化流（AC-335）对 Quay 进展只报两类事实：
1. 缓存快照里任务 `status/updatedAt` 的差异（`source:"quay.cache"`）；
2. 可选的提交标题解析，必须带 `heuristic:true` 并降级为 `signal:"progress?"`。是否启用这一项，在 AC-335 激活前再定。
- **2c correlationId**：写工具（`session_send` / `session_create` / `ui_*` / `approval_answer`）增加可选参数 `correlationId`，记入 run 元数据和审计；`changes`、`sessions_list`、审计统计都支持按它过滤。有了它，「每个意图的调用数」才能精确计量。

### 阶段 3 — 仅在证据支持时

持久化事件 journal（SQLite append-only，30 天）、FTS5 索引、语义检索、批量调用、`fields`/`compact`。前提：0b 的 `response_bytes` 证明体积确实是问题。

## 5. 分阶段验收（每阶段都要真服务 DoD，不只看单元测试）

| 阶段 | 验收指标 | 可复现方式 |
|---|---|---|
| 0a | `sessions_list(project="quay")` 成功；歧义仍然拒绝且列出候选和路径 | 单测 fixture + 真服务调用 |
| 0b | 7 天后 `sessions_list` 错误按 `error_code` 可拆分；有 p50/p95 统计 | stats 路由读数 |
| 1a | 头部调用方「两次写之间的读调用」p50 从 5 降到 ≤2、p90 从 22 降到 ≤8；`session_read` 占比 < 30% | 审计统计前后对比（同一客户端，≥3 天窗口） |
| 1a | 正确性：在受控场景（造会话消息、翻 Quay 任务、制造审批）中，`changes` 在 ≤ watcher 延迟 + 1 次调用内看到全部事件；重启后报 `gaps` | 集成测试（debug-agent fixture） |
| 1b | 带 `since=7d` 的检索 p95 < 3s；游标翻页不重复、不遗漏 | 基准脚本 + 单测 |
| 2c | 带 correlationId 的意图可以精确算出调用数 | 审计统计 |

## 6. 决策点（待外部 Agent / 人决定）

| id | 问题 | 选项 | 推荐 |
|---|---|---|---|
| D1 | 子串唯一命中在**写工具**上是否仍然自动解析？ | a) 维持现状（读写都接受）；b) 写工具只接受 id/路径/精确标题，子串只给读工具用 | **b**：写操作的误命中代价远高于多一次调用；但会改变 AC-246 的已验收行为，需要新 AC |
| D2 | 精确标题是否不区分大小写 | 区分 / 不区分 | 先区分、再不区分（两层） |
| D3 | 变化流里 Quay 进展的来源 | a) 读 git 提交标题（启发式，现在就能做）；b) 等 Quay 导出 `task log --json` | 先 a 并标注 heuristic，同时在 Quay 立项 b |
| D4 | Operation 的形态 | a) 只做 correlationId 标签；b) 一等 Operation 实体（CRUD + 关联） | **a**；b 会变成第二个调度器 / 状态源 |
| D5 | 检索：无范围的全量扫描如何处理 | a) 维持；b) 默认时间窗（如 30 天）+ 显式 `since:null` 才全量；c) 建 FTS5 索引 | 先 b；c 另行讨论保留与删除传播 |
| D6 | 遥测聚合是否暴露为 MCP 工具 | HTTP 路由 / MCP 工具 / 两者 | 两者，MCP 工具只返回本 token 或本用户的聚合，不含参数 |
| D7 | 立项落点 | 新开一个 goal / 并入草稿 GOAL-027 | P2 的分页与输出 schema 并入 GOAL-027；P0-1、changes、遥测各开新 AC |

### 6.1 暂定裁定（外部 Agent，2026-10-11 第二轮）

| id | 裁定 | 落点 |
|---|---|---|
| D1 | 写操作只允许 UUID、规范化完整路径或唯一精确名称；子串只用于只读发现，不得默默执行。兼容现存错误码，检视 AC-246 回归风险 | AC-333（拒绝时沿用 `TARGET_AMBIGUOUS` + `details.reason="exact_target_required"`）。回归面已 grep：只有 `mcp-resolve-target.test.ts:563` 的正向对照需改为精确标题，断言强度不降 |
| D2 | 精确名称先区分大小写，再唯一不区分大小写 | AC-333 (d)，含 `Quay` 与 `quay` 的对照 |
| D3 | task_trace 先设计 Quay 导出契约；不得把提交标题推测包装成事实，临时推测必须标 heuristic | §4 2b′ 契约草案；尚未在 Quay 立项（待确认，见 §6.2） |
| D4 | 第一阶段只做可选 correlationId，保留未来实体化的可能，不重复 Quay 调度 | AC-337（草稿） |
| D5 | 搜索优先按项目与时间剪枝和分页，不默认建隐私敏感的全量索引；无时间范围时要有合理上限和 hasMore，不得静默漏掉历史 | AC-336（草稿）：两道扫描上限（文件数、耗时）+ `hasMore` + `nextCursor` + `scannedThrough`，沿游标翻页最终覆盖全部历史 |
| D6 | 提供只读聚合统计工具，禁止暴露参数正文，做权限校验 | AC-334（草稿）：只聚合本用户的行，需要 `cloudcli:read`，带「标记串搜不到」的取假断言 |
| D7 | 原则上并入 GOAL-027 或已有任务，但先核验已有 AC、精确去重 | 核验结论见 §9：GOAL-027 的 AC-298..302 与本讨论**没有重叠**（它管 run_get、runId、sessions_list 分页、send 状态、outputSchema），所以第 1 阶段另立草稿 GOAL-040，并在其非目标里显式排除 GOAL-027 的范围 |

### 6.2 仍待裁决

- **E1**（✅ 已按推荐执行，2026-10-11 第四轮）激活 GOAL-040 的顺序：AC-334 先行并已派发；AC-336/AC-337 低风险一并派发（337 technically depends on 334）；AC-335 定稿但维持 draft，见 §9d。
- **E2** 2b′ 契约是否在 Quay 仓库立项（会写入另一个项目的任务库，属对外动作，需要确认）。**仍待确认，本轮未执行**。
- **E3** AC-335 是否启用 heuristic 的提交标题解析（D3 允许，但默认关闭更稳妥）。**仍待确认**（AC-335 本身也还在 draft，这条决策随它一起延后）。
- **E4**（✅ 已拍板，2026-10-11 第四轮）AC-336 的两道扫描上限：单次调用最多 200 个会话文件，或墙钟 3000ms，先触顶者生效；已写入 `gap-mcp-session-search-time-pruning-and-stable-cursor` 的任务体。
- **E5**（新增）AC-335 是否与 334/336/337 同批立即派发，还是按 §9d 的推荐等三者落地后再派发——本会话推荐后者，等待明确裁决。

## 7. 风险

- **性能**：`changes` 不得触发全量同步或冷启动 Quay CLI（冷 `quay_snapshot` 的 p95 是 3.8s，max 14.6s）。会话查询要有 `updated_at` 索引；检索要设上限。
- **正确性**：内存态（run / approval / host）重启即丢，所以变化流只能**诚实声明 gaps**，不能假装完整。watcher 不处理 unlink，因此删除的会话不会出现在流里。
- **兼容**：P0-1 改变的是已验收的解析行为（只放宽：以前歧义报错，现在精确标题可以解析）。客户端唯一可能受影响的场景是：原来依赖报错去发现候选列表。
- **数据保留 / 隐私**：遥测只存元数据（工具、耗时、结果、错误码、字节数、关联标签），继续保持 `args_digest` 的做法。任何新索引（FTS / 向量）都是转录副本，必须有保留期，并且原文件删除后索引要跟着删。
- **权限**：没有按项目的 ACL，跨项目聚合等同于全量读权限（见 R7）。

## 8. 进度日志

- **2026-10-11** 开会话。完成三路只读审计（网关工具面、存储与事件底座、任务库与既有讨论）和审计表基线（§1）。没有改代码：P0-1 的修复会改变已验收的 AC-246 行为，且没有现成任务，按约定先讨论（D1/D2）。没有立项：待 D7。
- **2026-10-11（第二轮）** 收到 D1–D7 暂定裁定（§6.1）。本账本以 `5c69e7d2` 入库并推进到 develop。立项见 §9：
  - GOAL-039（active）+ AC-333（active，已观测红先行：`缺判据文件`）+ 任务 `gap-mcp-resolve-target-exact-precedence-and-strict-writes`（已被 promotion-driver 晋升为 ready）；
  - B1/B2/B4 任务 `gap-mcp-session-get-past-recents-page-and-small-envelope-defects`（todo，`depends_on` 上一条，因为两者 Touches 重叠，串行以免并行冲突）；
  - 第 1 阶段草稿 GOAL-040 + AC-334..337（draft，不派发）。
  
  B3 撤回。基线口径固定（§1.1）。实现交给 worker-driver 在独立工作树里完成并经机械 fan-in 合入，**本会话不直接改实现代码**。这是为了遵守「功能工作先 GOAL/AC/task、由 driver 执行」的既有约定，并避免与 driver 派发同一任务时在同名分支上冲突。worker 并发槽当时被 3 个 voice/gate 任务占满（round 984，`filtered-empty`），所以 P0-1 在排队。

- **2026-10-11（第二轮，续）P0-1 落地并独立复核。** worker 实现提交 `af7009bb`（`feat(mcp-gateway): resolve MCP targets by precedence and require exact targets for writes`），机械 fan-in 后标记完成 `2d8d9f67`。AC-333 门控在 develop 上 pass，GOAL-039 被 goal-driver 自动翻为 achieved（`edc5d866`）。本会话在 develop `ff15c01d` 上独立复核：
  - **判据与回归**：AC-333 判据 exit 0；10 个文件逐个串行运行（tsx runner + memory cap），共 81 个用例全部通过：resolve-target 8、precedence 9、session-lifecycle 15、write-notification 5、error-envelope 7、english-only 10、tool-annotations 5、invalid-argument 4、read-tools 7、quay-test-script 11。`npm run typecheck` exit 0。
  - **真服务 DoD**：worker 完成记录**缺这一节**，由本会话补做，读数已追加进任务记录（`d9e5b089`）。临时实例（端口 9851），7 次调用全部符合预期：`project=quay` 在 `sessions_list` 与 `quay_snapshot` 上都能解析；写工具遇到唯一子串返回 `exact_target_required` 且不建会话；同名 `app` 报歧义并列出两个 `path`。
  - **复核发现的后续缺陷**：路径层对相对串执行 `path.resolve`，裸名会按服务 cwd 补全，可能静默命中 `<cwd>/<name>`，并因 `matchType:path` 而被写工具放行。用纯函数探针复现；现网 cwd 下没有子目录项目，所以无实际误命中。已立任务 `gap-mcp-resolve-target-path-layer-resolves-relative-names-against-server-cwd`（ready），修法是只对绝对路径启用路径层。
  - **流程观察**（应反馈给 Quay）：机械 fan-in 在完成记录缺真服务 DoD 的情况下也会标记完成，goal-driver 随后按判据通过翻 achieved。DoD 的执行目前没有机械约束，需要讨论方或人复核。

- **2026-10-11（第二轮，续 2）后续两项落地并复核。**
  - **路径层修复** `4fd31dcb`（done `4e95a3b6`）：一行守卫 `kind==='project' && path.isAbsolute(query)`。worker 完成记录**含**真服务 DoD：裸名 `app` 命中标题为 app 的项目，绝对路径命中 cwd 下那个。复核：precedence 判据 10 个用例全部通过。
  - **B1/B2/B4** `2d65c107`（done `ac7b1115`）：9 个相关文件全部通过，typecheck exit 0。worker 记录**缺完成记录与 DoD**，由本会话补跑真服务（读数见任务记录 `011849e8`）。B2、B4 通过；B1 的「最近一页外的会话能读到」通过，**但发现回归**：生产装配 `createMcpGatewayModule`（`mcp-gateway.transport.ts:562-564`）整体覆盖 `readTools.projects`，丢掉了新加的 `getProjectIdByPath`，导致 `session_get`/`ui_last_opened_session` 的 `projectId` 对**所有**会话变成 `null`（同实例 `sessions_list` 给出正确 id）。单测夹具不经过该覆盖，所以全绿。已立 `gap-mcp-session-get-projectid-null-under-production-gateway-assembly`。运行中的服务仍是旧代码，**在该修复落地前不应把服务重启到 develop**。

- **2026-10-11（第三轮）projectId 回归修复落地并独立复核；发现生产正在跑回归态。**
  - 修复提交 `ec07411f`（done `1cf74582`）：`createMcpGatewayModule` 的 `projects` 字面量补上 `getProjectIdByPath`（整袋重填，不做部分合并，理由见完成记录——该模块有意独占这一袋）；`McpReadToolDeps.projects.getProjectIdByPath` 改为必填，7 个夹具同步；`mcp-production-session-wiring.test.ts` (e) 腿新增回归断言，驱动的是生产同款装配（带 `readSessionById`）而非 recents 兜底。
  - 复核（本会话）：12 个相关判据文件独立逐一运行，`ℹ tests` 合计 81、`fail 0`；`npm run typecheck` exit 0。另起一个与 worker 探针不同参数（210 个会话、不同项目名）的真服务探针，4 条断言全部通过，`session_get` 的最新与最近页外两个会话 `projectId` 均正确且与 `sessions_list` 一致。
  - **⚠️ 生产服务（`claudecodeui-server.service`，端口 3001）当前跑的正是回归态，不是修复态。** 比对 `dist-server/server/modules/mcp-gateway/mcp-gateway.transport.js` 与各提交的源文件 md5：该编译产物与 `af7009bb`/`2d65c107`/`4fd31dcb`（含路径层修复与 B1/B2/B4，**不含** `ec07411f`）逐字节相同；三读取器字面量里没有 `getProjectIdByPath`。`systemctl --user status claudecodeui-server.service` 显示该实例 19:18:04 CST 启动（单条 `Started` 日志，非崩溃重启），比 `ec07411f` 的提交时间（19:10:38）晚约 7 分钟，但构建产物没有这个提交——即构建发生在这次启动之前、取自 `ec07411f` 落 develop 之前的某次 checkout 状态。本会话未执行任何构建或重启命令（`npm run build`、`systemctl restart` 均未调用），这次启动的来源未知,不是本会话所为。**现网 `session_get`/`ui_last_opened_session` 现在确实对所有会话返回 `projectId:null`**，与外部 Agent 本轮报告的现象一致。本仓库的 `npm run build`（`tsc -p server/tsconfig.json && tsc-alias -p server/tsconfig.json`，供参考，未执行）加 `systemctl --user restart claudecodeui-server.service` 会把修复带上生产，但**本会话不会自行执行**，等待裁决。

- **2026-10-11（第四轮）** 外部 Agent 要求：(1) 复核 ec07411f 真服务 DoD 并给出安全发布步骤/影响/回滚；(2) 把 AC-334 推进到 driver 可执行、AC-335..337 排好依赖并定稿契约；(3) 解释构建/部署竞态根因并建最小检测任务；(4) 不干扰 Live Voice。本轮未执行任何构建/重启/发布动作。

## 9. 第四轮：发布复核、GOAL-040 推进、构建竞态根因

### 9a. ec07411f 复核结论（不变，重新确认）

`dist-server/server/modules/mcp-gateway/mcp-gateway.transport.js` 仍与 `af7009bb`/`2d65c107`/`4fd31dcb` 逐字节相同（`getProjectIdByPath` 出现次数 0），develop 当前 HEAD（`aac82240`）包含 `ec07411f`。**生产仍跑在回归态**，没有变化。`claudecodeui-server.service` 自 19:18:04 未重启（同一 Main PID 3322018）。

**精确时间线（纠正上一轮「可能是用了旧 checkout」的猜测——现在有更精确的证据）：** `ec07411f` 19:10:38 只提交到它自己的任务分支；机械 fan-in 真正把它 fast-forward 进 develop 发生在 19:19–19:22 之间（`b0e5886a` 19:19:09 之后、`1cf74582` 19:22:39 之前）。dist-server 的编译产物 mtime 是 19:17，服务启动是 19:18:04——**两者都早于修复落到 develop 的时刻**。所以这不是「构建读了过期 checkout」，而是「构建发生的那一刻，develop 确实还没有这个修复」，构建本身是忠实的。真正的缺口在 9c。

### 9b. 安全发布步骤 / 影响 / 回滚（供人裁决，本会话未执行）

**现网活性读数（本轮核实）：** `sessions` 表里 `lifecycle_mode='resident'` 的非归档行 205 条；查询时刻（13:39:47 UTC）前 25 秒内有真实 MCP 调用（`session_get`/`run_get` 等），且有 resident 会话的 `updated_at` 在查询前几秒内刚刷新——**现在就有活跃使用**，不是空闲窗口。

**发布步骤（在 `/data/home/yale/work/claudecodeui` 这个与 systemd 单元 `WorkingDirectory=` 相同的 checkout 里）：**
1. 确认 `git status` 干净、`HEAD` 等于打算发布的 commit（现在是 develop 的 `aac82240`，已含 `ec07411f` 及本轮前三个已落地任务）。
2. `npm run build`——`build:server` 已有 `prebuild:server`（清 `dist-server.next`）→ `tsc`/`tsc-alias` → `postbuild:server`（`scripts/promote-dist-server.mjs`，原子地把 `dist-server.next` 换上 `dist-server`，旧的先挪到 `dist-server.old` 再在成功后删除——这套「暂存-原子换入」机制是现成的，本轮不需要新建）。
3. （`gap-mcp-deploy-freshness-build-sha-health-check` 落地后）`cat dist-server/build-info.json`，确认 `gitSha` 等于第 1 步确认过的 commit，再决定是否重启——这一步不需要先重启就能核验构建对不对。
4. `systemctl --user restart claudecodeui-server.service`。
5. `curl /health`（落地后应看到 `buildSha` 吻合）；观察 `server.log` 与 `mcp_audit_log` 几分钟内有没有调用方的错误潮。

**影响：**
- resident 会话：`SIGTERM` 触发 `shutdownRuntimeServices`，先关 host（EOF 优雅退出，`SESSION_HOST_SHUTDOWN_TIMEOUT_MS=5000`，超时才强杀），再停 scope——这是「CLI 该怎么退出」的设计路径，不是异常崩溃。
- 正在进行的 `session_send`/run：连接被重置，客户端需要重试；run 状态本来就只活在内存（5 分钟留存，重启即丢），`run_get` 已有 `RUN_NOT_FOUND{reason}` 的降级读数，行为良好的客户端不会卡死。
- 已连接的外部 MCP 客户端：连接断开需自行重连，这是传输层标准行为，服务端不代为协调。
- 数据不丢：任务/目标/会话元数据都落在 sqlite 与 git；受影响的只是已知从不跨重启存活的内存态（run/approval/host）。

**回滚：** 不是「还原一份缓存的二进制」——`dist-server.old` 只在原子换入的瞬间存在，成功后立刻删除，不是多版本保留。真正的回滚是 `git checkout <上一个已知良好的 commit>` → `npm run build`（同一套暂存换入）→ `systemctl --user restart`。

**附带发现（不在本轮任务范围，仅记录）：** `scripts/promote-dist-server.mjs recover`（修复「换入中途被打断」）挂在 `preserver`（`npm run server` 的前置钩子），但生产 systemd 单元的 `ExecStart` 直接 `node dist-server/server/index.js`，不经过 `npm run server`，所以这个自愈钩子在生产路径上**不会**被自动触发。影响面很窄（只在「构建换入中途被杀 + 紧接着 systemd 重启」同时发生时才触发），不建议现在就改 `ExecStart`（那是发布基建变更，值得单独讨论），先记在这里。

### 9c. 构建/部署竞态的根因（解释，供下面的检测任务引用）

Quay driver 的机械 fan-in 几分钟就会有新提交落到 develop（本轮一小时内就有几十个任务提交）；而生产部署是人工、某一时刻点状的 `npm run build && systemctl restart`，中间没有任何机制在「之后又有新提交落到 develop」时触发重新构建。结果是：**部署几乎必然在完成的那一刻起就开始落后，而且不会自愈**，落后多久纯粹取决于下一次人工部署什么时候发生。这与「用错了 checkout」或「构建工具链有 bug」无关——9a 的精确时间线已经证明这次构建本身是忠实的。

旁证：`server/modules/system/system.service.ts` 的 `/update` 端点 `git checkout main && git pull && npm install`——checkout 的是 `main` 而不是 `develop`（本仓库今天的 MCP 工作全部在 develop），且 `npm install` 不会触发 `npm run build`（`postinstall` 只跑 `scripts/fix-node-pty.js`）。这个端点即使被调用也帮不上忙，但这是一个更大范围的发布策略问题，本轮不改它的行为，只做检测（见下）。

**最小检测任务已筛过无重复**（`grep -il "buildSha\|build-info\|deploy.*stale" tasks/*.md` 命中 0 条）：`gap-mcp-deploy-freshness-build-sha-health-check`（见 §10）。

### 9d. GOAL-040 第 1 阶段：AC-334 已推进、336/337 已定序低风险推进、335 维持草稿待最终点头

**裁决与推进（本轮执行，不是征询）：**
- **AC-334（遥测）**：GOAL-040 与 AC-334 均 draft→active；任务 `gap-mcp-usage-stats-tool-and-audit-telemetry-columns` 已建，`ready`，已被 worker 拾取（round 1042 in_flight）。
- **AC-336（检索剪枝/分页）**：独立于 334，低风险（只在既有工具加参数+上限，不新建索引），按「在既有裁定范围内可先推进」一并激活+派发；任务 `gap-mcp-session-search-time-pruning-and-stable-cursor`，`ready`。**E4 默认值已拍板**：单次调用最多扫 200 个会话文件或墙钟 3000ms，先触顶者生效（写进工具描述，日后按真实基准调整不算破坏性变更）。复核中额外发现 `sessions` 表没有 `updated_at` 索引，已追加进该任务的 Touches（同一次改动顺带补，不另开任务）。
- **AC-337（correlationId）**：(c) 腿要求 `mcp_usage_stats` 支持按它过滤——这是对 AC-334 的**硬技术依赖**，不是排序偏好。任务 `gap-mcp-correlation-id-write-tools-and-filters` 已建，`depends_on` AC-334 的任务，当前 `todo`（AC-334 落地后由 promotion-driver 自动晋升）。已激活。
- **AC-335（changes 增量流）**：**未立项、未派发任务**，这是本会话的刻意决定（见下）。⚠️ 其 `status` 字段在 13:53:34 被 **goal-driver 自己的 triage 逻辑机械翻成了 `active`**（statusLog：`actor: goal-driver, reason: "triage: activate"`），是 GOAL-040 一旦 active 之后，其下任意 draft AC 的自动行为，**不是**本会话或任何人的决策，也不代表「已批准推进」——它只是让 AC-335 的判据开始被例行 gate（现在正确地红：`缺判据文件：…mcp-changes.test.ts`，与 334/336/337 当初激活时一样）。**真正的决策点只有一个：是否要 `task_write` 一个实现任务让 worker 去做**，而这一步我没有做。契约本身在上一轮已经定稿（§4 的 (a)–(f) 读数、取假形态），本轮没有新改动；之所以暂不立项，是因为它是四者里唯一一个新建工具、涉及 signal 分类正确性与 gaps 语义判断的——这恰好是外部 Agent 本轮原话点名的风险（「不要新建第二调度器」），所以留到 334/336/337 落地验证「按需计算、不新建索引/事件总线」这套做法确实可行之后再上，且它能借 AC-334 的统计工具测出自己把轮询次数降了多少。**若认为应该与其他三条同批立项派发，请明确说一声，我可以立即 `task_write`。**

依赖图：AC-334 → AC-337（硬依赖，task 已 `depends_on`）；AC-334、AC-336 相互独立，均已立项派发；AC-335 已是 active（driver 机械 triage，非决策），推荐在以上三者落地后再立项（`task_write`）。

## 10. 立项索引（去重结论）

| 主题 | 既有 | 本讨论新增 | 去重说明 |
|---|---|---|---|
| 项目/会话解析 | AC-246（achieved）、`gap-ac246-…`、`gap-mcp-resolve-deps-production-wiring`（done） | GOAL-039 / AC-333 / `gap-mcp-resolve-target-exact-precedence-and-strict-writes` | AC-246 的判据文件保持不变且继续通过；新读数放在新判据文件里 |
| session_get 窗口、quay_snapshot 参数错误分类、审计回看耗时 | 无 | `gap-mcp-session-get-past-recents-page-and-small-envelope-defects` | sessions_list 分页明确留给 GOAL-027 AC-300 |
| 调用遥测聚合 | AC-244、AC-304（done：审计行、回看接口） | AC-334（active）/ `gap-mcp-usage-stats-tool-and-audit-telemetry-columns`（ready/worker 拾取中） | 在既有审计表上加列，不另建表 |
| 变化流 | AC-193（浏览器活动坞的 rev 协议，非 MCP） | AC-335（active，契约已定稿；推荐待 334/336/337 落地后再派发，见 §9d） | 可复用活动协议的 `bootId` 与 rev，不另造 |
| 检索 | `gap-mcp-session-search`、`gap-mcp-cross-project-session-aggregation`（done） | AC-336（active）/ `gap-mcp-session-search-time-pruning-and-stable-cursor`（ready） | 只加剪枝与分页，不改匹配语义；顺带补 `sessions.updated_at` 索引 |
| 关联标签 | AC-299（draft，runId 处处可用） | AC-337（active）/ `gap-mcp-correlation-id-write-tools-and-filters`（todo，`depends_on` AC-334 的任务） | 互补：runId 指一次运行，correlationId 指一个意图 |
| task_trace | 无 | §4 2b′ 契约草案 | 属于 Quay；E2 待确认 |
| 待处理交互、UI 导航 | 多个 done 任务 | 不新增 | 剩余缺口（messageId 存在性校验、按 turn 定位）优先级低，暂不立项 |
| 发布新鲜度检测 | 无（`grep -il "buildSha\|build-info\|deploy.*stale" tasks/*.md` 命中 0） | `gap-mcp-deploy-freshness-build-sha-health-check`（ready，无 goal_ac——纯运维检测，不属于 GOAL-040 的观测面范围） | 只做 `/health` 暴露 `buildSha`/`builtAt` + 人工比对脚本，不建调度器 |
| changes × Quay 缓存（D1–D5） | AC-335（achieved）/ `gap-mcp-changes-on-demand-event-stream`（done）；`gap-quay-tab-cold-snapshot-serial-cli-spawns`、`gap-cloudcli-quay-snapshot-inflight-tasks`（done，均不覆盖 D1–D5） | GOAL-042：AC-347 ①、AC-348 ②（修订 AC-335 (e)）、AC-349 ③ | 无开放任务重叠；②依赖①、③依赖② |

## 11. 第五轮（2026-10-12）：changes × Quay 缓存的实际问题与修复立项

### 11a. 状态核实（只读，14:39 CST）

GOAL-040 与 AC-334..337 均为 achieved。生产服务 PID 80749（12:57:03 CST 启动），`/health` 的 `buildSha` 为 `7e801687`，包含全部实现提交；`7e801687..develop` 之间 `server/` 没有任何改动。在隔离实例上运行同一份 `dist-server`，真实 `tools/list` 返回 31 个工具，包括 `changes`、`mcp_usage_stats`、`session_search{since,until}` 与 `correlationId`。

ChatGPT 侧只显示 21 个工具：DCR 客户端 `f5464e2b` 注册于 10-07 18:31 CST，当时 develop（`8bf129ed`）恰好是 21 个工具；之后该客户端只做过 refresh_token，从未调用过新工具。`/mcp` 是无状态 HTTP，服务端声明了 `listChanged:true`，但没有可推送的通道，因此需要在 ChatGPT 侧刷新或重连连接器，服务端无需任何动作。

**更正上一轮的两处读数**：`listChanged` 实际已声明；工具数应为 31，不是测试钉的 27/28。

### 11b. 实测读数与代码路径

外部 Agent 实测：三个项目首次调用均为 `complete=false`、Quay cache cold；`quay_snapshot refresh` 之后 `complete=true`、`gaps=[]`，下一次读取 `events=[]`。小样本延迟：changes p50 约 3ms，session_read 约 56ms，quay_snapshot 约 1028ms。

- **为什么是 cold**：`quayService` 是模块级单例，其中的 `snapshotCache`（`quay.service.ts:1077`）由 UI 面板、`quay_snapshot`、`overview`、`changes` 共用，与 MCP 会话或传输无关。缓存只在 `getQuaySnapshot` 时懒填充，重启即清空。TTL 为 30s（`quay.module.ts:10`），过期后 `getCachedSnapshot` 直接返回 `null`（`quay.service.ts:1466-1470`），于是 30s 后又会报 cold。stale 与 cold 无法区分。
- **D1 覆盖率**：`readCachedTasks` 读取的是 `snapshot.tasks.recent`（`index.ts:401`），而 `recent` 被截断为前 10 条（`QUAY_RECENT_LIST_LIMIT=10`，`quay.service.ts:109,600`）。排名 10 名之外的任务迁移不可见，却仍返回 `complete=true`；一个任务首次进入前 10 时被误报为新任务。
- **D2 初始化即事件**：`previous===undefined` 时直接发出 progress 事件，`at` 取观测时刻，`ageMs` 取 now 与 updatedAt 之差（`mcp-changes.ts:566-588`）。首次观测、真实迁移、数据时间、观测时间四者混为一谈；且同一迁移每次 `at` 都不同，按 `(kind,ref,at)` 去重会失效。
- **D3 session 分页漏读**：`getSessionsUpdatedSince` 使用 `DESC LIMIT`，且为全局查询（`sessions.db.ts:1128-1139`），窗口内较早的行被截掉。恰好返回 `limit` 行时 `truncated=false`，水位直接跳到 now；即便被判定截断，水位也已越过那些未读的较早行。项目过滤在 LIMIT 之后才于 JS 中执行。
- **D4 游标体积**：所有在作用域内的项目都写 head（58 个项目、全空时已约 4.2KB），任务只增不删，单项目 672 个任务时约 51KB；切换作用域会丢失其他项目的 head。
- **D5 complete 近乎恒为 false**：作用域内 8 个 Quay 项目，只要任意一个超过 30s 未被访问就会出现 gap。

### 11c. 裁定（外部 Agent，2026-10-12）

| id | 裁定 |
|---|---|
| E1 | bootstrap 默认只建立 baseline，不发 progress 事件；需要显式快照时走独立接口；响应明确标出 bootstrap 与 coverage |
| E2 | 采用 B′：changes 可以触发非阻塞、去重、最小间隔 60s 并带资源预算的异步状态索引加载，但不得同步等待，也不得执行完整快照 CLI。cold 或失效要明确报告。**这一条修订了 AC-335 (e)**，须经新 AC 合规变更（见 AC-348），并在 AC-335 记录上注明修订来源 |
| E3 | 暂不引入 fs.watch，先拿到真实负载读数 |
| E4 | 原则同意把 `task list --json --no-body` 纳入精确只读白名单，前提是确认执行环境、参数白名单且没有写副作用；以后再加 flag 需另行审查 |

### 11d. E4 前置核实（2026-10-12 14:49，只读）

对 5 个带 bin 的 Quay 项目（插件版本 0.19.0、0.17.0（cantus）以及 quay 仓库的 dev 插件）逐一执行 `.quay/plugin/bin/quay task list --json --no-body`：全部 rc=0，输出无 body，每行都有 `updatedAt`。

| 项目 | 耗时 | 输出 | 任务数 |
|---|---|---|---|
| quay-fleet | 216ms | 15KB | 34 |
| claudecodeui | 253ms | 294KB | 672 |
| quay | 405ms | 1.36MB | 2729 |
| archguard | 223ms | 45KB | 116 |
| cantus | 251ms | 25KB | 65 |

**写副作用检查**：以 marker 文件配合 `find -newer` 检查，命令执行前后只有 `.quay/anchor.json` 变化。空闲 40s、不调用 CLI 的对照中，它也会自行刷新（driver anchor 心跳），因此不归因于 CLI。`claudecodeui` 与 `quay` 两个项目在调用前后没有任何文件变化。

**执行环境**：沿用现有 runner，即项目内 `.quay/plugin/bin/quay`；无 bin 的项目走 bare-PATH 回退并打出 warn。只读白名单是逐字精确匹配（`quay.service.ts:486,499-505`），本次只新增 `['task','list','--json','--no-body']` 这一条。

**注意**：quay 仓库 2729 个任务、1.36MB，是索引内存与解析成本的上界参考。

### 11e. 立项（见 §10 追加行）

- ① D3：`gap-mcp-changes-session-keyset-asc-paging-no-loss`，AC-347。低风险、独立，最先落地。
- ② D1/D2/D5 + E2：`gap-mcp-changes-quay-status-index-async-bootstrap`，AC-348（修订 AC-335 (e)）。`depends_on` ①，原因是两者都改 `mcp-changes.ts` 与 `server/index.ts` 的接线，串行可避免冲突。
- ③ D4：`gap-mcp-changes-cursor-bounded-rebase`，AC-349。`depends_on` ②。

所属 GOAL-042。三项共同的硬约束：服务重启、游标丢失或服务端索引清空时，必须给出 gap 或 rebase/bootstrap，不得宣称 complete；旧字段语义保持兼容，只做增量扩展。
