---
id: gap-mcp-pending-interaction-visibility-and-idempotent-answer
title: 补齐 MCP pending-interaction 可见性（session_get/sessions_list）与
  approval_answer 幂等审计——区分 AskUserQuestion/ExitPlanMode
  交互型请求与普通权限审批，覆盖竞态/幂等/过期/权限/resident-session 端到端判据
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

真实事故：一个 Claude Code 常驻（resident）会话因 `AskUserQuestion` 弹出选项题而挂起，外部 MCP 客户端（通过 CloudCLI）用 `session_get` 反复查询该 sessionId，只看到 `host.state==='busy'`、`idleForMs`、`leases`——没有任何字段提示"正在等人选选项"，于是把一个正常挂起误判成"运行停滞"。用户最终在浏览器 UI 里手动点了选项才恢复。本任务把已经调查清楚的机制缺口补上。

### 已核实现状（带证据，不是推测）

- `session_get`/`sessions_list`（`server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 的 `buildSessionDetail`/`toSessionReading`，AC-245）只读 `host.state`（枚举 `'starting'|'idle'|'busy'|'lingering'|'closing'|'closed'`，`server/shared/types.ts:2576`，没有 `awaitingPermission` 这个值）、`idleForMs`、`leases`、`run.lastSeq`——从不读已经注入 `McpReadToolDeps` 的 `deps.activity`（turn-phase）或审批源，完全没有"有人在等待回应"这个读数。这是本次误判复现的直接原因。
- `overview`（`mcp-overview-tools.ts`，AC-247，done）已有 `awaitingPermission[]`（基于 `activityStore.snapshot(sessionId).turn.phase==='awaitingPermission'`，`claude-turn-phase.service.ts:51`），但只给 `sessionId`/`project`/`title`/`phase`，没有 `requestId`/问题内容/是否会自动超时；一个只查具体 sessionId 的客户端不会自然想到去调这个全工作区的工具。
- `approvals_list`/`approval_answer`（`mcp-approvals.ts`，AC-274，done）已经能展开 `AskUserQuestion` 的 `questions`/`options` 并以 `allow`+`answers`（转发为 `updatedInput`）应答——和 UI 的 `AskUserQuestionPanel.tsx` 提交时发的 `{allow:true, updatedInput:{...input, answers:{...}}}` 走同一个 `resolveToolApproval`（`claude-runtime.provider.ts:338`）。但调用方必须**已经知道要调这个独立工具**才能看到问题内容——这正是本次事故里没发生的一步。
- 两类弹窗是同一通路、不同超时：`TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion','ExitPlanMode'])`（`claude-runtime.provider.ts:215`）命中时 `waitForToolApproval` 的 `timeoutMs:0`（永久等待，`claude-runtime.provider.ts:403-404`）；其它（Bash/Write 等普通权限）退回 `TOOL_APPROVAL_TIMEOUT_MS`（默认 55000ms）自动拒绝。`approvals_list`/`approval_answer` 当前**不区分**这两类，调用方无法仅凭返回值判断"这个请求会一直挂着"还是"55 秒内会自动结束"。
- `answerApproval`（`chat-control.service.ts:824`）对"已被别的客户端（例如 UI 里的人类）抢先解决"和"从未发出过"两种情况，都归到同一个 `APPROVAL_EXPIRED_OR_NOT_FOUND`（`classifyMissingApproval` 只能分 `expired`/`never_issued`，`claude-runtime.provider.ts:159`）——MCP 调用方无法确认自己刚才的 answer 是否真的生效，也无法安全判断重试。
- 默认（不传 `session`）扫描口径不对齐：`approvals_list` 默认走 `chatRunRegistry.listRunningRuns()`（`chat-control.service.ts` 的 `approvalSessionIds` 默认）；`overview.awaitingPermission` 走全部最近会话的 `turn.phase` 扫描（`mcp-overview-tools.ts:436`）。两个工具在同一时刻可能给出不一致的"有没有待审批"答案。

### 方案

在已有依赖（`deps.activity`、`deps.control`）基础上做四处最小扩展，不新建审批机制、不改变超时策略、不新增 scope——纯粹把已经算出来的状态多输出一份，并给已有的决议结果补一条短期审计记录：

1. `session_get`/`ui_last_opened_session` 输出新增 `pendingInteraction: {requestId, toolName, interactive, autoTimeoutMs, waitedMs, questions?} | null`（复用 `mcp-approvals.ts` 已有的 `extractApprovalQuestions`/`summarizeApprovalInput`，不建第二套展开逻辑）；`sessions_list` 新增布尔 `awaitingUser`，`state` 枚举增补 `'awaiting_user'` 档位。
2. `approvals_list`/`approval_answer` 的每条记录新增 `interactive: boolean`（= `TOOLS_REQUIRING_INTERACTION.has(toolName)`）与 `autoTimeoutMs: number | null`（非交互型给 `TOOL_APPROVAL_TIMEOUT_MS` 实际值，交互型给 `null`）。
3. `resolveToolApproval`（`claude-runtime.provider.ts`）写一条短期（进程内存，有限容量，仿 `heldApprovalLedger` 的做法）决议账本 `{requestId → {decidedAt, decidedBy, allow}}`；`answerApproval` 命中"已被别的调用方解决"时返回新 code `ALREADY_DECIDED`（带 `decidedBy`/`decidedAt`），不再和"从未发出过"共用 `expired`/`never_issued`。
4. `approvals_list`（不传 `session` 时）的默认候选会话集合，与 `overview.awaitingPermission` 的扫描口径对齐（都覆盖"有挂起请求"的会话，不只是 `listRunningRuns()` 的子集）。

<!-- dedup-ref -->本任务与 `gap-voice-realtime-popup-observability-investigation`（AC-313，ready）机制不同：后者是语音专项、只读、不实现任何应答能力的调查任务（人 yale 明确要求"调查但不强制阻塞"），本任务是面向所有 MCP 外部调用方（例如本次事故里的 CloudCLI 客户端，与语音完全无关）的通用可见性与应答硬化。二者互不依赖、互不阻塞，互不覆盖对方的 Touches。本任务也不与 GOAL-031 的非目标冲突——GOAL-031 明确要求语音层"完全复用 Claude Code 自己已有的机制……不插手、不重复、不新建第二套"；本任务做的正是强化那套被复用的既有机制本身（`session_get`/`approvals_list`/`approval_answer`），不新建审批/确认层，不改变 55 秒超时策略，不新增鉴权 scope（新字段挂在既有 `cloudcli:read`/`cloudcli:approve` 上）。机械去重：`grep -rli "pendingInteraction\|ALREADY_DECIDED\|awaitingUser" tasks/*.md` 立案时零命中；`grep -rln "^goal_ac: *AC-274" tasks/*.md` 只命中已 done 的 `gap-ac274-mcp-approvals`（它建了 `approvals_list`/`approval_answer` 本体，未触及 `session_get`/`sessions_list` 暴露或决议幂等账本）。`task-granularity-advice.js` 对本任务 Touches 的查询 `peers: []`——当前没有其它 todo/ready 任务声明同一批文件。

## AC

- [ ] AC1 判据红态基线：`test -f server/modules/mcp-gateway/tests/mcp-pending-interaction.test.ts || { echo "缺判据文件：server/modules/mcp-gateway/tests/mcp-pending-interaction.test.ts" >&2; exit 1; }` 在实现前退出码 1，逐字输出该缺文件提示。
- [ ] AC2 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-pending-interaction.test.ts` 退出 0，写下 `# tests`/`# pass`/`# fail` 读数。
- [ ] AC3 (a) 可见性：对一个挂起 `AskUserQuestion` 的会话，`session_get(session).pendingInteraction` 非空，其 `requestId`/`toolName`/`questions` 与同一时刻 `approvals_list({session})` 对应条目逐字一致；`sessions_list` 同会话行 `awaitingUser===true`；另一个无挂起的干净会话两者分别读 `null`/`false`（正例对照）。逐字写出两侧返回。
- [ ] AC4 (b) 区分交互型与普通权限：挂起一个普通 `Bash` 权限请求，`pendingInteraction.interactive===false`、`autoTimeoutMs` 等于注入的 `TOOL_APPROVAL_TIMEOUT_MS`；挂起 `AskUserQuestion`/`ExitPlanMode`，`interactive===true`、`autoTimeoutMs===null`；`approvals_list` 对应条目同步带这两个字段。逐字写出四条读数。
- [ ] AC5 (c) 竞态与幂等：对同一 `requestId` 并发两次 `approval_answer`（一次 `allow:true`、一次 `allow:false`），断言 `resolveToolApproval` 对该 `requestId` 恰好被调用一次（先到者生效），另一次返回新 code `ALREADY_DECIDED` 并带 `decidedBy`/`decidedAt`——不再归到 `APPROVAL_EXPIRED_OR_NOT_FOUND`。逐字写出两次返回与调用计数。
- [ ] AC6 (d) 过期/不存在不回归：`gap-ac274-mcp-approvals` 既有的 `server/modules/mcp-gateway/tests/mcp-approvals.test.ts` 不改一字仍逐字通过（过期 `expired`/从未发出 `never_issued` 两条路径行为不变）。
- [ ] AC7 (e) 权限不被新字段绕过：仅 `cloudcli:read` 令牌可读 `session_get`/`sessions_list`/`approvals_list` 的新字段（读路径不变）；仅 `cloudcli:approve` 令牌的 `approval_answer` 调用才能产生新的决议账本记录，没有 approve scope 的调用被拒、不产生决议记录、`mcp_audit_log` 新增一行 `denied`。逐字写出三类令牌各自的返回与审计行。
- [ ] AC8 (f) 默认扫描口径对齐：`approvals_list({})`（不传 `session`）得到的待审批会话集合，与 `overview().awaitingPermission` 的会话集合相等；一个无挂起请求的会话不出现在任一侧。逐字写出两侧集合。
- [ ] AC9 (g) resident-session 端到端：扩展既有 `server/modules/providers/tests/claude-resident-permissions.test.ts`（AC-168 判据，不新建文件、既有四个用例不改一字），新增一个用例——在同一个生产驱动、同一个 resident host/pid 上，`AskUserQuestion` 挂起后经控制服务 `answerApproval`（`approval_answer` 背后同一动词）应答，断言：应答后该会话不再处于 `awaitingPermission`、`resolveToolApproval` 对该请求恰好调用一次、host id 与 pid 全程不变（不触发重启）；并发第二次应答得到 `ALREADY_DECIDED`、host/pid 仍不变。既有四个用例逐字通过不变。
- [ ] AC10 取假形态必须红（先提交实现再变异，记录变异 diff、逐字失败行、恢复命令）：让决议账本不生效（`answerApproval` 对已解决的 `requestId` 仍调用 `resolveToolApproval` 而非返回 `ALREADY_DECIDED`）⇒ AC5 必须红；恢复后重跑全绿。
- [ ] AC11 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无新增 `: error `；AC-245 判据 `mcp-read-tools.test.ts`、AC-247 判据 `mcp-overview.test.ts`、AC-274 判据 `mcp-approvals.test.ts`、AC-168 判据 `claude-resident-permissions.test.ts` 不改既有用例仍逐字通过；跨模块只经 barrel；遵守 `$backend-module-standards`。
- [ ] AC12 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标 ` (new)`）；若被迫写 Touches 之外的文件，先用 `task_write` 加入 `## Touches` 再写。

## DoD

- `pendingInteraction`/`awaitingUser` 真的从已存在的 `deps.activity`/`deps.control` 读出，不是伪造或另起一套状态；与 `approvals_list` 同一时刻的读数逐字一致（结构性保证，不是两份手抄）。
- `interactive`/`autoTimeoutMs` 真的反映 `TOOLS_REQUIRING_INTERACTION` 与 `TOOL_APPROVAL_TIMEOUT_MS` 的真实值，不是写死的常量。
- `ALREADY_DECIDED` 真的基于一条决议账本（能分辨"刚被别的调用方决定过"与"从未发出过"/"已超时"），不是猜测或吞掉第二次调用。
- resident 端到端用例真的在 AC-168 既有的生产驱动 + scripted 流程上跑通，不是另起一个与生产代码路径不同的假运行时。
- 不改变 55 秒超时策略、不新增鉴权 scope、不新建第二套审批/确认机制——呼应 GOAL-031 对"语音层复用既有机制、不新建第二套"的非目标约束，也不扰动已 achieved 的 GOAL-022。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释）与 AGENTS.md。

## Touches

- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-approvals.ts
- server/modules/websocket/services/chat-control.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/providers/list/claude/claude-runtime.provider.ts
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/providers/index.ts
- server/shared/types.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-pending-interaction.test.ts (new)
- server/modules/providers/tests/claude-resident-permissions.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-pending-interaction-visibility-and-idempotent-answer.md (self)

## Notes

- 事故背景（Cantus 常驻会话 `80742fbc-d8a6-4877-8635-a8ff927a9ff6`）与架构调查结论来自本次对话的只读分析；本任务是该分析得出的最小可行修复集合，优先级排序见对话记录：P0=AC3（session_get/sessions_list 可见性）、P1=AC4（区分交互型）、P2=AC5/AC9（幂等账本与 resident 端到端）。
- 不在本任务范围：调整 `TOOL_APPROVAL_TIMEOUT_MS` 本身、给交互型请求加超时、新建推送/事件通道（轮询现有读工具已够用）、语音层的 AskUserQuestion 应答实现（那是 AC-313 调查结论之后才可能另外立案的范围）。
