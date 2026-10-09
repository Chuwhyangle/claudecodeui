---
id: gap-mcp-session-send-reports-pending-interaction-it-queued-behind
title: session_send 排队进一个正卡在 AskUserQuestion/权限审批上的会话时，返回里如实带出 blockedBy（挂起请求的
  requestId/toolName/interactive/autoTimeoutMs/waitedMs），工具描述写明"排队消息不会回答待审批，请用
  approval_answer"
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

- [x] AC1 判据红态基线：在实现前，`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 中新增的 blockedBy 用例失败（或以 `test -f` 形式的缺判据提示退出 1），逐字记录失败行。
- [x] AC2 判据绿：同一命令退出 0，写下 `# tests`/`# pass`/`# fail` 读数。
- [x] AC3 有挂起请求：常驻会话忙且挂着一个 `AskUserQuestion` 时，`session_send` 返回 `queued:true` 且 `blockedBy` 非空，其 `requestId`/`toolName`/`interactive===true`/`autoTimeoutMs===null` 与同一时刻 `approvals_list({session})`、`session_get(session).pendingInteraction` 逐字一致；逐字写出三侧读数。
- [x] AC4 正例对照：会话忙但无挂起请求时 `blockedBy===null`；会话空闲直接开新轮（`queued:false`）时 `blockedBy===null`。逐字写出两条读数。
- [x] AC5 描述：`tools/list` 中 `session_send` 的 description 含 `approval_answer` 且无 CJK（`mcp-english-only.test.ts` 不改一字仍通过）。
- [x] AC6 取假形态必须红：让 `buildSessionSend` 恒返回 `blockedBy:null` ⇒ AC3 必须红；记录变异 diff、逐字失败行、恢复命令，恢复后重跑全绿。
- [x] AC7 不回归：`npm run typecheck` 退出 0；`npm run lint` 无新增 `: error `；`mcp-pending-interaction.test.ts`、`mcp-approvals.test.ts`、`mcp-english-only.test.ts` 不改既有用例仍逐字通过；若语音桥镜像测试因新字段变红，同步镜像后通过；跨模块只经 barrel；遵守 `$backend-module-standards`。
- [x] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；被迫写 Touches 之外的文件先用 `task_write` 加入再写。

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
- server/modules/voice-realtime/tests/voice-realtime-live-executor.false-forms.test.ts (AC-310 false form: its mutant literal mirrors the shipping session_send payload)
- server/shared/tests/quay-test-script.test.ts (develop-side regression from AC-315: bump the pinned server-test file count)
- scripts/suite-duration-baseline.tsv (develop-side regression from AC-315: append its new server test's duration row)
- src/modules/chat/tests/forkFromAssistantReply.test.tsx (develop-side regression from AC-315: tokenless useAuth double for the mounted voice hook)
- src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx (same)
- tasks/gap-mcp-session-send-reports-pending-interaction-it-queued-behind.md (self)

## Evidence

实现提交：`2800d404`（branch `task/gap-mcp-session-send-reports-pending-interaction-it-queued-behind`）。

### AC1 红态基线（实现前，逐字）

```
✖ (h) a queued send reports the pending request blocking it, byte-identical to approvals_list and session_get
  AssertionError [ERR_ASSERTION]: a send that is not queued is never blocked
  + actual - expected
  + undefined
  - null
tests 8 / pass 7 / fail 1   EXIT=1   (test file line 824)
```

即：判据先成、`buildSessionSend` 尚未回 `blockedBy`，`payload.blockedBy===undefined`。

### AC2 绿（同一命令）

`# tests 8 / # pass 8 / # fail 0`，EXIT=0。

### AC3 三侧逐字一致（同一次绿色运行，同一时刻）

```
session-send (h) blockedBy={"requestId":"ac-h-blocker","toolName":"AskUserQuestion","inputSummary":"{\"questions\":[{\"question\":\"Which route should the run take?\",\"header\":\"Route\",\"options\":[{\"label\":\"A\",\"description\":\"the direct route\"},{\"label\":\"B\",\"description\":\"the scenic route\"}]}]}","interactive":true,"autoTimeoutMs":null,"waitedMs":50,"questions":[{"question":"Which route should the run take?","options":[{"label":"A","description":"the direct route"},{"label":"B","description":"the scenic route"}],"header":"Route"}]}
session-send (h) approvals_list entry={"requestId":"ac-h-blocker","session":"…","toolName":"AskUserQuestion","inputSummary":"{…}","interactive":true,"autoTimeoutMs":null,"waitedMs":50,"questions":[{…,"header":"Route"}]}
session-send (h) session_get pendingInteraction={"requestId":"ac-h-blocker","toolName":"AskUserQuestion","inputSummary":"{…}","interactive":true,"autoTimeoutMs":null,"waitedMs":50,"questions":[{…,"header":"Route"}]}
```

`blockedBy` 与 `session_get.pendingInteraction` deepEqual；后者与 `approvals_list` 该条去掉 `session` 后 deepEqual。`requestId=ac-h-blocker`、`toolName=AskUserQuestion`、`interactive===true`、`autoTimeoutMs===null`（交互型永久挂起）。三点同一投影、同一时刻（readTools/writeTools/residentTools 共用 `now: () => clock.value`）。

该挂起是**真**请求：`approval_answer({requestId:'ac-h-blocker'})` 经运行时自己的 resolver 成功（`(h) approval_answer requestId=ac-h-blocker ok=true`）——网关只报告，不代答。

### AC4 两条正例读数

```
session-send (h) idle-open queued=false blockedBy=null            // 空闲开新轮
session-send (c) busy-no-pending blockedBy=null                    // 忙但无挂起（该发送 queued=true）
```

### AC5 描述

`tools/list` 的 `session_send.description`（= 注册用的常量 `SESSION_SEND_DESCRIPTION`）：

```
"Send a message to a session, returning the run id at once. A queued message does not answer a pending approval; use approval_answer to answer it."
contains approval_answer = true ; contains CJK = false
```

`mcp-english-only.test.ts` 一字未改：`# tests 10 / # pass 10 / # fail 0`，EXIT=0。

### AC6 取假形态（逐字）

变异 diff：

```
-  const blockedBy =
-    result.queued && deps.approvals
-      ? toPendingInteraction(deps.approvals.pendingForSession(input.session), deps.approvals.now())
-      : null;
+  const blockedBy = null; // FALSIFICATION: always null
```

失败行：

```
✖ (h) a queued send reports the pending request blocking it, byte-identical to approvals_list and session_get
  AssertionError [ERR_ASSERTION]: a queued send must name the pending request it is parked behind
tests 8 / pass 7 / fail 1   EXIT=1
```

恢复命令：`cp /tmp/mcp-session-send.ts.bak server/modules/mcp-gateway/mcp-session-send.ts`（备份于变异前）。恢复后重跑：`# tests 8 / # pass 8 / # fail 0`，EXIT=0。

### AC7 不回归

- `npm run typecheck`：三份 tsconfig（root / server / scripts）全过，EXIT=0。
- `npm run lint`：`: error ` 计数 = 0；Touches 内文件零告警。
- `mcp-english-only.test.ts` 10/10、`mcp-pending-interaction.test.ts` 5/5、`mcp-approvals.test.ts` 6/6，均 EXIT=0、既有用例一字未改。
- 语音桥镜像：新增输出字段被 `voice-realtime-tools.ts` 的 `session_send` 镜像同步（`blockedBy: pendingInteractionShape.nullable()`），`voice-realtime-bridge.test.ts` 6/6（含 AC2 逐字段比对）、`voice-realtime-bridge.false-forms.test.ts` 4/4，EXIT=0。
- 跨模块只经 barrel（`../index.js` 取 `MCP_STAGE4_WRITE_TOOLS`/`buildRunGet` 等；`McpApprovalReader` 为 type-only，运行时擦除，无环）；错误经 `mcp-error-envelope.js`，未新增错误码。

### AC8 diff 与 Touches

实现提交 `2800d404`：

```
 server/index.ts                                    |  19 ++
 .../modules/mcp-gateway/mcp-gateway.write-tools.ts |  16 +-
 server/modules/mcp-gateway/mcp-session-send.ts     |  90 +++++++++-
 .../mcp-gateway/tests/mcp-session-send.test.ts     | 194 ++++++++++++++++++++-
 ...oice-realtime-live-executor.false-forms.test.ts |   6 +-
 .../modules/voice-realtime/voice-realtime-tools.ts |   8 +-
 6 files changed, 321 insertions(+), 12 deletions(-)
```

develop 回归修复提交（见下节）：

```
 scripts/suite-duration-baseline.tsv                      | 7 +++++--
 server/shared/tests/quay-test-script.test.ts             | 4 ++--
 src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx | 6 ++++++
 src/modules/chat/tests/forkFromAssistantReply.test.tsx   | 6 ++++++
 4 files changed, 19 insertions(+), 4 deletions(-)
```

两提交合计 10 条与 `## Touches` 前 10 条逐条对应；第 11 条（本任务文件）经 `task_write` 单独提交，不在实现 diff 内。无 Touches 之外的文件。

### 跨任务联动：AC-310 反形随新字段同步（Touches 第六条）

本任务无条件向 `SessionSendPayload` 新增 `blockedBy`（未排队 / 无读取缝时为 `null`），
使 `server/modules/voice-realtime/tests/voice-realtime-live-executor.false-forms.test.ts`
（AC-310，`gap-voice-realtime-live-session-send-wiring` 已 done）的 AC1 反形红：该反形把
`session_send` 换成硬编码 payload，其前提是「变异 payload 与真实 payload 值相等」；
真实 payload 现在多带 `blockedBy: null`，硬编码字面量少了该键，`deepEqual` 失败：

```
AssertionError [ERR_ASSERTION]: the mutant is crafted to return an equal payload
+ actual - expected
  {
-   blockedBy: null,
      queued: false, queuedMessageUuid: null, runId: 'run-1', source: 'mcp'
  }
```

修复：只把该反形的硬编码字面量补上 `blockedBy: null`，与真实 payload 的字段集一致，
「值相等」前提恢复；委派读数（`baseSends===1` / `mutSends===0`）不变，仍可红。
复跑该文件 `npx tsx --tsconfig server/tsconfig.json --test <该文件>`：
`tests 3 / pass 3 / fail 0`，EXIT=0。该文件先经 `task_write` 加入 `## Touches` 再改。

### 跨任务联动（续）：develop 侧 AC-315 落地带来的两处确定性红

`19ed0cb2`（AC-315，经 `gap-ac315-voice-upload-orphaned-never-merged` 合并进 develop，
merge `94547fab`）在 develop 上留下两处与本任务无关的**确定性**红。该任务只跑了它自己的
scoped 命令 + typecheck/lint，未跑全量 suite（`gap-voice-realtime-upload-audio-and-protocol-simulation`
与 `gap-ac315-voice-upload-orphaned-never-merged` 均 `status: done`，无遗留修复任务）。
fan-in 只在全绿时落地，故本任务依 AC8「被迫写 Touches 之外的文件先用 `task_write` 加入再写」
一并修掉：

1. `server/shared/tests/quay-test-script.test.ts` AC2/AC3：AC-315 新增
   `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`
   未同步 test-count 钉（dispatch 行 `known=`/`unknown=`）。磁盘实际 server 测试文件数 264
   （develop HEAD 与本分支 HEAD 经 `git ls-tree -r` 逐字一致），钉里为 263。改
   `unknown=260→261`（AC2，`known=3`）、`unknown=262→263`（AC3，`known=1`）。
   隔离复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts`：
   `tests 11 / pass 11 / fail 0`，EXIT=0（修前 2 fail）。

2. `src/modules/chat/tests/forkFromAssistantReply.test.tsx`、`src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx`：
   AC-315 给 `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 加了
   `const { token } = useAuth();`；这两个用例渲染 `ChatInterface`（`isActive` →
   `ChatInterface.tsx` 挂 `VoiceRealtimeControl`），却不提供 `AuthProvider`，红在
   `Error: useAuth must be used within an AuthProvider`（栈：voice-realtime → `AuthContext.tsx:101`）。
   按仓库既有约定（`src/modules/oauth-consent/tests/oauthConsentPage.test.tsx:59`、
   `src/modules/task-master/tests/projectUpdateBroadcast.test.tsx:42`）在
   `vi.mock('@/modules/task-master', …)` 前加
   `vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }))`。
   隔离复跑 `npx vitest run <两文件>`：`Test Files 2 passed / Tests 3 passed`，EXIT=0（修前 3 fail）。
   客户端文件 `src/modules/chat/voice-realtime/` 与 `src/modules/auth/` 经 `git diff develop..HEAD` 确认与本分支逐字一致——红来自 develop，不是本任务。

3. `scripts/suite-duration-baseline.tsv` 补 AC-315 新测的时长行（1320ms，按 duration 降序插在
   1313 与 1310 之间），头部数据计数 238/263 → 239/264 并注明来源。

**不修**的红：`server/modules/session-hosts/tests/resident-server-restart.test.ts` 的
`swept nothing in 3 attempt(s) (swept=0)` 是已知的 host-wide-sweep 泳道竞态
（隔离复跑 `tests 4 / pass 4 / fail 0`，EXIT=0），交由 fan-in 的重跑裁决。