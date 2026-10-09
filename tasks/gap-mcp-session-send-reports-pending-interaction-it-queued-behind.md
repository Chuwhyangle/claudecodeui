---
id: gap-mcp-session-send-reports-pending-interaction-it-queued-behind
title: session_send 排队进一个正卡在 AskUserQuestion/权限审批上的会话时，返回里如实带出 blockedBy（挂起请求的
  requestId/toolName/interactive/autoTimeoutMs/waitedMs），工具描述写明"排队消息不会回答待审批，请用
  approval_answer"
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

### 真实证据（Cantus 常驻会话 `80742fbc-d8a6-4877-8635-a8ff927a9ff6`，生产 `~/.cloudcli/auth.db` 的 `mcp_audit_log` 与该会话转录 `-data-home-yale-work-cantus/7a1a3362-….jsonl`，时间均为 UTC）

- 01:34:32 会话发出 `AskUserQuestion`（header「通信方式」），常驻、`permission_mode=default`，交互型请求 `timeoutMs:0` 永久挂起。
- 01:38:29 与 01:40:37，令牌 89 两次 `session_send` 到该会话（3206 / 2651 字），审计 `outcome=ok`——两条消息都**静默排队**在这个挂起的问题后面；发送方得到的只是 `queued:true`，没有任何字段告诉它"这个会话正在等人回答，你的消息在它被回答之前不会被处理"。
- 01:46:23 用户在浏览器 UI 选了选项，挂起才解除，两条排队消息随后才进入。

### 现状

`gap-mcp-pending-interaction-visibility-and-idempotent-answer`（done，`93342b27`，已部署到 :3001）已经让 `session_get.pendingInteraction` / `sessions_list.awaitingUser` / `overview.awaitingPermission` 能读到挂起请求，并新增了 `mcp-approvals.ts` 的 `toPendingInteraction`（同一投影）与 `server/index.ts` 里的 `approvals.pendingForSession` 读取缝。但 `session_send`（`server/modules/mcp-gateway/mcp-session-send.ts` 的 `buildSessionSend`）在常驻会话忙分支（`result.queued===true`）只回 `{runId, queued, queuedMessageUuid, source}`，不读挂起请求；它的工具描述也没说排队消息不会回答待审批。一个只用 `session_send` 推进会话的调用方（本次就是）不会知道自己的消息卡在了弹窗后面。

### 方案（最小）

1. `buildSessionSend` 在 `queued===true` 时，经已有的 `approvals.pendingForSession(sessionId)` + `toPendingInteraction` 读该会话的挂起请求，payload 新增 `blockedBy: McpPendingInteraction | null`（与 `session_get.pendingInteraction` 同一形状、同一投影，不另写展开逻辑）；`queued===false` 时恒为 `null`。
2. `session_send` 的 description 追加一句英文（AC-289 英文-only）：a queued message does not answer a pending approval or AskUserQuestion; when `blockedBy` is set, answer it with `approval_answer`.
3. 不改发送语义（仍然排队，不拒绝、不自动应答），不新增 scope，不新建通道。

<!-- dedup-ref -->去重：`grep -rli "blockedBy\|queued behind" tasks/*.md` 立案时零命中；母任务 `gap-mcp-pending-interaction-visibility-and-idempotent-answer` 已 done，未触及 `session_send`。若新增输出字段红了语音桥的工具镜像（`voice-realtime-tools.ts` 镜像网关 `session_send` 的 schema），同步镜像——这是已知联动，不是越界。

## AC

- [ ] AC1 判据红态基线：在实现前，`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 中新增的 blockedBy 用例失败（或以 `test -f` 形式的缺判据提示退出 1），逐字记录失败行。
- [ ] AC2 判据绿：同一命令退出 0，写下 `# tests`/`# pass`/`# fail` 读数。
- [ ] AC3 有挂起请求：常驻会话忙且挂着一个 `AskUserQuestion` 时，`session_send` 返回 `queued:true` 且 `blockedBy` 非空，其 `requestId`/`toolName`/`interactive===true`/`autoTimeoutMs===null` 与同一时刻 `approvals_list({session})`、`session_get(session).pendingInteraction` 逐字一致；逐字写出三侧读数。
- [ ] AC4 正例对照：会话忙但无挂起请求时 `blockedBy===null`；会话空闲直接开新轮（`queued:false`）时 `blockedBy===null`。逐字写出两条读数。
- [ ] AC5 描述：`tools/list` 中 `session_send` 的 description 含 `approval_answer` 且无 CJK（`mcp-english-only.test.ts` 不改一字仍通过）。
- [ ] AC6 取假形态必须红：让 `buildSessionSend` 恒返回 `blockedBy:null` ⇒ AC3 必须红；记录变异 diff、逐字失败行、恢复命令，恢复后重跑全绿。
- [ ] AC7 不回归：`npm run typecheck` 退出 0；`npm run lint` 无新增 `: error `；`mcp-pending-interaction.test.ts`、`mcp-approvals.test.ts`、`mcp-english-only.test.ts` 不改既有用例仍逐字通过；若语音桥镜像测试因新字段变红，同步镜像后通过；跨模块只经 barrel；遵守 `$backend-module-standards`。
- [ ] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；被迫写 Touches 之外的文件先用 `task_write` 加入再写。

## DoD

- `blockedBy` 真的从运行时的挂起集合读出，与 `approvals_list`/`session_get` 是同一个投影（`toPendingInteraction`），不是另一份手抄的形状。
- 一条排队进挂起会话的 `session_send` 真的让调用方在**同一个返回**里看到"被哪个请求挡住、是否会自动超时、怎么解"，不需要再猜着去调别的工具。
- 发送语义不变：仍然排队、不拒绝、不代答；不新增 scope、不新建通道、不改超时策略。

## Touches

- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/index.ts
- server/modules/voice-realtime/voice-realtime-tools.ts
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts
- tasks/gap-mcp-session-send-reports-pending-interaction-it-queued-behind.md (self)
