---
id: gap-resident-pending-capped-text-not-retired
title: resident 待发行 cap 文本永不退休：>400 字消息在会话开头重复一条截断 user 气泡（MCP 创建的 resident 会话）
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

### 背景 / 现象

MCP 浏览器打开 `https://cloudpit.lrfz.com/session/10d533ec-8b33-4acf-acfc-ab6e260ff69d` 时，会话开头有两条连续的 user 消息，第一条不完整。该会话由 Cloudpit MCP 的 `session_create` 创建（`mcp_audit_log` id 172760，message 长度 3319，provider `claude`，会话 `lifecycle_mode=resident`）。

在同一机制上现场复现（同样 MCP 创建、仍在运行的 resident 会话 `843a5612-96b1-4bcc-b3e4-e46d19e09f23`）：

- `session_create` 的 message 长度 440（`mcp_audit_log` id 172939）。
- activity 快照 `deliveries[]` 中该 delivery 为 `state=started`、`source=mcp`、`text.length=400`，文本截止 `…从TF主动SSH发起push到Clou`。
- 页面开头实际渲染的客户端 `chatMessages`：`[{type:'resident_pending', state:'started', len:400}, {type:'user', len:440}, …]`；截图 `tmp/dup-both-messages.png`（第一条带 `Started processing`，第二条完整）。
- 用户会话的 3319 字开场消息同理：pending 行是 400 字前缀，持久化 user 行是全文。turn 结束后 delivery 进入 `completed` 不再画行，所以现象只在 turn 运行期间可见。

### 根因（代码核实，2026-11-19）

1. resident delivery 的快照投影把存活 delivery 的文本截到 400 字：`server/shared/types/delivery.ts:38`（`DELIVERY_TEXT_MAX_CHARS = 400`）、`server/modules/providers/list/claude/lifecycle/resident-deliveries.ts:349`。
2. 前端从快照派生 pending 行并保留 `queued`/`started` 的文字：`src/modules/chat-session/hooks/useSessionStore.ts:1108-1120`；`PendingResidentMessage` 只要 content 非空就画气泡（`src/modules/chat/transcript/PendingResidentMessage.tsx:92`）。
3. pending 行的退休判据要求“服务端持久化 user 行与它**全文严格相等**”：`src/modules/chat-session/hooks/useSessionStore.ts:905`（`(candidate.content || '').trim() !== text`）。400 字前缀 vs 440/3319 字全文永远不等 ⇒ 不退休。
4. 同一文件里“浏览器自己发送的乐观行”抑制 delivery 行时已经用前缀匹配：`src/modules/chat-session/hooks/useSessionStore.ts:816`（`candidateWords.startsWith(words)`），上方注释明确说明 cap 会让长消息以 PREFIX 到达。MCP 发送没有浏览器端 `local_` 乐观行，于是只走严格相等的退休路径，暴露此缺口。
5. pending 行 timestamp = `enqueuedAt`（发送时刻），持久化行是 CLI 落盘时刻；排序后不完整的那条排在前面，形成“两条连续 user 消息、第一条不完整”。

### 要交付

1. 把 `retireDeliveredResidentPending` 的匹配改为前缀匹配（`candidateWords.startsWith(text)`），保留现有一对一认领与 `RESIDENT_PENDING_ECHO_FLOOR_SKEW_MS` 时间窗；<=400 字行为不变。若把“cap 造成的 prefix”与“乐观行抑制”的语义收敛到一个共享 helper，先确认不新增模块环、不超出本任务 Touches；超出则先经 task_write 补 Touches 再改。
2. 在 `src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx` 增加回归用例（真实 `useSessionStore` + 真实 `PendingResidentMessage`，jsdom）：
   - 服务端页含 440 字 user 行；activity 快照 delivery `state=started`，`text` = 该行前 400 字；合并后恰好 1 条 user-facing 行且是持久化全文（无 `resident_pending` 行）。
   - 400 字及以下消息仍正常退休（正对照）。
   - 一对一 + 时间窗不被放宽：两条同前缀/同词消息不会互相认领（至少一条负控）。
3. DoD 真实页面：按 AGENTS.md 的 UI 验证规则，在 worktree dev server（代理 live 实例）或隔离实例上打开一个 resident 会话，消息 >400 字且 delivery 处于 `queued`/`started`，确认只显示一条完整 user 气泡；截图存 `tmp/` 并贴入任务 Evidence。若执行时没有活的 delivery，需明确说明，并用真实 store + 组件的读数补足，不得只贴代码。

### 非目标 / 已核实不成立

- **不立“MCP session_send 不可见”任务**：04:02:27/43/58 的三条 `session_send` 在 jsonl 中只有 `queue-operation enqueue`，但 04:12:09 的三条 `dequeue` 把它们合并成一条 599 字 user 行（jsonl 第 650 行，uuid `0ace0c0a-75d4-49c5-b810-3b989a0669cc`），历史/outline/transcript 均可见；不是丢失，不在本任务范围。
- `PendingResidentMessage` 的文档注释说 `started` 不画气泡，但实现与既有测试（`pendingDeliveriesSnapshot.test.tsx` 的 “`started` must not empty the row”）都画；行为是既有设计，本次只修退休判据，注释漂移另行处理。
- 不改服务端 `DELIVERY_TEXT_MAX_CHARS`（400 是有意的有界传输），不改 activity 快照形状，不改 `completed`/`cancelled` 的显示规则。

## AC

- [ ] AC1 新回归判据：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx --maxWorkers=1` 退出 0；新用例先打印读数 `deliveryTextLen=400 persistedLen=440 pendingRowsAfterMerge=0 userRowsAfterMerge=1` 再断言。红态记录：在未修实现上同一条用例红在 `pendingRowsAfterMerge=1`（贴逐字失败读数与命令）。
- [ ] AC2 正对照：<=400 字消息的 pending 行仍被持久化行退休（`pendingRowsAfterMerge=0`），且 400 字边界通过；读数与命令贴出。
- [ ] AC3 负控（改完即还原）：把 `startsWith` 还原成严格相等 ⇒ AC1 新用例红且 AC2 仍绿；记录 diff、失败行、恢复命令。
- [ ] AC4 既有客户端判据不回退：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx src/modules/chat/tests/sessionMessageReconciliation.test.ts src/modules/chat/hooks/tests/useSessionStoreCommandLifecycle.test.tsx --maxWorkers=1` 退出 0；`npm run typecheck`、`npm run lint` 退出 0。
- [ ] AC5 真实页面（DoD 第 3 条）：截图路径与读数写入 Evidence。

## DoD

- 退休判据只依赖“持久化 user 行文本以 pending 行文本为前缀 + 时间窗 + 一对一”，不依赖全局 `runId`/`turnId`，不放宽到跨 turn 认领。
- 修改只落在 `useSessionStore.ts` 的退休函数（及必要的共享 helper）与判据文件；若新增/改动其它文件，先经 task_write 补 Touches 再改。
- 遵守 `$frontend-module-standards`（`@/` 导入、`import type`、测试放 `src/modules/chat/tests/`）。
- 真实页面上，capped delivery 的待发行不再与持久化行并排；截图存 `tmp/` 并贴入任务。
- 不改服务端 cap、快照形状或既有 `completed`/`cancelled` 行为。

## Touches

- src/modules/chat-session/hooks/useSessionStore.ts
- src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx
- tasks/gap-resident-pending-capped-text-not-retired.md
