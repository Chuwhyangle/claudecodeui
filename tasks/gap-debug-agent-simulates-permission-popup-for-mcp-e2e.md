---
id: gap-debug-agent-simulates-permission-popup-for-mcp-e2e
title: 调试 Agent（fake provider）补上可复现的人机弹窗能力：runtime 加 permissions
  面（listPending/resolve/classifyMissingApproval/readApprovalDecision）+ 场景新增
  permission-request 步（经注入缝发帧并喂 Turn Tracker），并用它对 MCP pendingInteraction →
  approval_answer → resume 做会话级端到端判据
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

### 立案实测（立案前在本仓跑的一次性探针，探针已删）

在真实装配上（`initializeDatabase()` + 真 `providerRegistry` + 真 `createProviderRuntimeService`，`DEBUG_AGENT=on`、fixture HOME、临时 `DATABASE_PATH`）读到的三条原始读数：

```
provider id: debug
runtime members: run, abort, stopTask, backgroundTask
has permissions face: false
armed session: 2f46f490-3dd8-4ff7-9391-dae23188d6c3
getPendingApprovalsForSession -> []
classifyMissingApproval(random) -> never_issued
readApprovalDecision(random) -> null
```

再走一个含 `{op:'tool-call', name:'AskUserQuestion', input:{questions:[…]}}` 的场景：

```
frame kinds emitted: ["tool_use","complete"]
permission_request emitted: false
pending AFTER walking an AskUserQuestion tool-call -> []
```

结论：**调试 Agent 今天无法模拟 AskUserQuestion/权限弹窗。** 它的 runtime 只有 `run/abort/stopTask/backgroundTask`，没有 `permissions` 面；`providerRuntimeService.getPendingApprovalsForSession` 对它是 `provider.runtime.permissions?.listPending(...) ?? []`，因此恒为 `[]` —— 一个 debug 会话上无论走多少 `tool-call`，`approvals_list`/`session_get.pendingInteraction`/`overview.awaitingPermission` 都看不见任何东西，`approval_answer` 也只会回 `never_issued`。

### 为什么值得做（不是为测而测）

`gap-mcp-pending-interaction-visibility-and-idempotent-answer`（done）的判据已经覆盖了「真 MCP 客户端 → 真网关 → 真控制面 → 真 claude runtime 的 `requestClientToolDecision` → 挂起 → `approval_answer` → resolver 被调用」这条链，但它是**缝级**的：挂起由测试直接调 `requestClientToolDecision` 装上去，背后没有一个会**恢复**的轮次。用真 provider 做「恢复」这一段的代价是真实模型 + 真实 CLI + 真实 55s 超时，不可重复、不稳定（这正是本任务要避免的「误用真实 provider 的不可控弹窗替代可重复测试」）。调试 Agent 补上这个面之后，「挂起 → 被 MCP 看见 → 被 MCP 回答 → **轮次继续走下去**」可以变成一条完全不依赖真实模型/真实二进制的确定性判据，同时覆盖 debug 这一条非 claude 的 provider 扇出。

### 硬约束（先写出来，否则会烧掉一轮）

`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`（ADR-003 决策 7 的静态守卫）规定调试 Agent **自己的 `*.ts` 源码里不得出现线缆帧/事件名**，`permission_request`/`permission_resolved`/`permission_cancelled` 都在禁止表里。所以本任务**不能**在 debug 模块里手写 `kind: 'permission_request'`；发帧与喂 Turn Tracker 必须走**注入缝**（构造点在 `server/modules/providers/provider.registry.ts:105`，已在注入 `forwardFrames: forwardNormalizedFrames`，同处再注入一个审批播报缝即可）。守卫判据本身必须不改一字仍通过。

### 方案（最小）

1. **调试 Agent 的 runtime 获得 `permissions` 面**（`debug-agent.provider.ts` 的 `createDebugAgentRuntime`）：`listPending(sessionId)` / `resolve(requestId, decision, decidedBy)` / `classifyMissingApproval(requestId)` / `readApprovalDecision(requestId)`，由模块内两张表支撑——一张 pending 表（含 `sessionId`/`toolName`/`input`/`receivedAt`），一张有界「曾持有」账本 + 一张决议账本。语义对齐 claude runtime 的同名缝：**曾经持有后消失 = `expired`，从未发出 = `never_issued`**；已决议的再次查询返回决议（`decidedBy`/`decidedAt`/`allow`）。
2. **场景新增一步 `permission-request`**（进 `DEBUG_AGENT_OPS` 闭集）：携带工具名与 input（例如 `AskUserQuestion` 带 `questions`，或 `Bash` 带 `command`），可选「是否挂住整条 walk」。走这一步时：登记一条 pending 条目；经**注入缝**播报（喂 Turn Tracker 的 `awaitingPermission`，并按产品自己的词汇表发帧）——模块内不出现任何线缆字面量。
3. **恢复可观测**：被 `approval_answer` 解决后，walk 继续写下后续步骤的行（这是「resume」的读数），且 `session_get.pendingInteraction` 回到 `null`。
4. **判据** `server/modules/debug-agent/tests/debug-agent-permission-popup.test.ts`（新）：在真实装配 + 真 MCP 客户端上，对一个 debug 会话跑完整 E2E（见 AC3–AC5），并附一条「同一个 debug 会话上 `approvals_list({})` 的集合 == `overview()` 的 `awaitingPermission` 集合」的一致性断言。

<!-- dedup-ref -->去重：`grep -rli "permissions face\|listPending\|permission-request" tasks/*.md` 立案时只命中 `gap-ac274-mcp-approvals`（done，覆盖的是 MCP 审批工具与真 claude runtime，不碰调试 Agent 的 provider 能力），以及本对话上一轮已 done 的 `gap-mcp-pending-interaction-visibility-and-idempotent-answer`（MCP 可见性，不碰 provider）。全部 `tasks/gap-debug-agent-*.md`（14 条，均 done）逐条核对：`engine-and-scenario-ops`（产出引擎与场景步）、`host-driver`（AC-160 宿主驱动）、`no-second-vocabulary-guard`（本任务必须遵守的守卫）、`synthetic-provider-adr`（只落设计）——**没有任何一条覆盖「调试 Agent 能挂起一个人机请求」这个机制**。`task-granularity-advice.js` 对下列 Touches 返回 `peers: []`。

## AC

- [ ] AC1 判据红态基线逐字记录：实现前跑本任务命令，`test -f server/modules/debug-agent/tests/debug-agent-permission-popup.test.ts || { echo "缺判据文件：server/modules/debug-agent/tests/debug-agent-permission-popup.test.ts" >&2; exit 1; }` 退出码 1 并逐字输出该提示；同时逐字记录「立案实测」那四条读数在**改动前**的复现（`runtime members` 无 `permissions`、`getPendingApprovalsForSession -> []`、走完 AskUserQuestion 的 `tool-call` 后 `permission_request emitted: false`）。
- [ ] AC2 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-permission-popup.test.ts` 退出 0，写下 `# tests`/`# pass`/`# fail` 读数。
- [ ] AC3 弹窗真的被 MCP 看见：对一个走 `permission-request` 步而挂住的 debug 会话，`session_get(session).pendingInteraction` 非空，其 `requestId`/`toolName` 与同一时刻 `approvals_list({session})` 的同一条目逐字一致；`AskUserQuestion` 的 `questions[].options` 逐条展开；同一个会话上 `approvals_list({})` 的待审批会话集合与 `overview()` 的 `awaitingPermission` 集合相等（debug 会话必须**同时**出现在两侧——这条同时证明新面把 Turn Tracker 喂到了）。逐字写出三侧读数。
- [ ] AC4 回答后**轮次恢复**：`approval_answer({requestId, allow:true, answers:{…}})` 成功后，(i) walk 继续，`permission-request` 步之后的那一步的行真的落进转录（逐字给出该行的 `uuid`/内容），(ii) 该会话的 `session_get.pendingInteraction` 回到 `null`，(iii) `overview` 不再把该会话列进 `awaitingPermission`。逐字写出三侧读数。
- [ ] AC5 幂等与三种「不在册」互不混淆：对同一 `requestId` 再答一次得到 `ALREADY_DECIDED` 且带 `decidedBy`/`decidedAt`（**不是** `APPROVAL_NOT_FOUND`）；一个场景里被丢弃/超时的 `requestId` 得到 `expired`（`details.reason` 逐字）；一个从未发出的 id 得到 `never_issued`。逐字写出三次返回。
- [ ] AC6 无第二套词表：`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts` **不改一字**仍逐字通过（证明新能力没有在 debug 模块源码里写任何线缆帧/事件字面量）。
- [ ] AC7 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无新增 `: error `；`mcp-pending-interaction.test.ts`、`mcp-approvals.test.ts`、`claude-resident-permissions.test.ts`、`debug-agent-*` 既有判据不改成语仍逐字通过；新增的 server 判据文件按既有惯例（`gap-voice-realtime-connection-resilience` 的先例）**同时**追加 `scripts/suite-duration-baseline.tsv` 一行并更新 `server/shared/tests/quay-test-script.test.ts` 的计数 pin，使 AC7 的 90% 覆盖地板仍有余额（逐字写出更新后的 `covered/collected` 读数）；跨模块只经 barrel。
- [ ] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标 ` (new)`）；被迫写 Touches 之外的文件先用 `task_write` 加入再写。

## DoD

- 弹窗是**调试 Agent 自己**挂起来的：`runtime.permissions.listPending` 真的能读出它、`resolve` 真的被 `approval_answer` 走到、`classifyMissingApproval`/`readApprovalDecision` 真的由它自己的账本回答——不是把真 claude runtime 的 pending 表借来充数。
- 「resume」是真的：录制行数的增量发生在 `approval_answer` **之后**，而不是场景一开始就把所有行写完（判据要在回答前后各取一次转录行读数，并断言增量归因于回答）。
- 全链不依赖真实模型、真实 claude 二进制与真实 55 秒超时；时间由场景的 `at` 与注入时钟决定，可重复。
- 不新增任何 MCP 工具、不改 MCP 工具字段、不改 55 秒超时策略、不新增 scope；`permission_request` 等线缆字面量不出现在 debug 模块源码里（守卫是判据）。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释）与 AGENTS.md；不引入新依赖。

## Touches

- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.scenario.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/index.ts
- server/modules/providers/provider.registry.ts
- server/modules/debug-agent/tests/debug-agent-permission-popup.test.ts (new)（判据）
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-debug-agent-simulates-permission-popup-for-mcp-e2e.md (self)

## Notes

- 探针方法照 `real-half-ac-via-real-control-service-over-debug-fixture` 的做法：env 先设、动态 import、一次性脚本、退出前删除、不入库。立案实测的场景文档形状（本仓当前闭集）：`{version:1, dialect:'claude', home:'gate', transcript:{mode:'per-row-jsonl'}, seed:{title,userText}, steps:[{at,...}], expect:{rows:{delta:N}, content:{mustContain:[]}}}`。
- `provider.registry.ts` 是唯一能同时看到 providers 模块与 debug 模块的构造点（`createDebugAgentProvider` 在那里被调用，`forwardNormalizedFrames` 已从那里注入），因此审批播报缝也应当从那里注入。
- 若实现时发现「喂 Turn Tracker」与「发帧」两件事必须分开注入，按最小原则只做能通过 AC 的那一半，并在 Notes 里如实登记另一半的缺口，不要顺手扩大。
- 与 `gap-debug-agent-no-second-vocabulary-guard` 的关系：那条任务建了守卫，本任务是被守卫约束的第一条扩展，AC6 就是为了让这条约束在判据上成立而不是靠自觉。
