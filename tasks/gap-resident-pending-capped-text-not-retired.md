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

- [x] AC1 新回归判据：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx --maxWorkers=1` 退出 0；新用例先打印读数 `deliveryTextLen=400 persistedLen=440 pendingRowsAfterMerge=0 userRowsAfterMerge=1` 再断言。红态记录：在未修实现上同一条用例红在 `pendingRowsAfterMerge=1`（贴逐字失败读数与命令）。
- [x] AC2 正对照：<=400 字消息的 pending 行仍被持久化行退休（`pendingRowsAfterMerge=0`），且 400 字边界通过；读数与命令贴出。
- [x] AC3 负控（改完即还原）：把 `startsWith` 还原成严格相等 ⇒ AC1 新用例红且 AC2 仍绿；记录 diff、失败行、恢复命令。
- [x] AC4 既有客户端判据不回退：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx src/modules/chat/tests/sessionMessageReconciliation.test.ts src/modules/chat/hooks/tests/useSessionStoreCommandLifecycle.test.tsx --maxWorkers=1` 退出 0；`npm run typecheck`、`npm run lint` 退出 0。
- [x] AC5 真实页面（DoD 第 3 条）：截图路径与读数写入 Evidence。

## DoD

- 退休判据只依赖“持久化 user 行文本以 pending 行文本为前缀 + 时间窗 + 一对一”，不依赖全局 `runId`/`turnId`，不放宽到跨 turn 认领。
- 修改只落在 `useSessionStore.ts` 的退休函数（及必要的共享 helper）与判据文件；若新增/改动其它文件，先经 task_write 补 Touches 再改。
- 遵守 `$frontend-module-standards`（`@/` 导入、`import type`、测试放 `src/modules/chat/tests/`）。
- 真实页面上，capped delivery 的待发行不再与持久化行并排；截图存 `tmp/` 并贴入任务。
- 不改服务端 cap、快照形状或既有 `completed`/`cancelled` 行为。

## Touches

- src/modules/chat-session/hooks/useSessionStore.ts
- src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/gap-resident-pending-capped-text-not-retired.md

## Evidence

实现：`retireDeliveredResidentPending` 的认领判据由 `(candidate.content || '').trim() !== text` 改为 `(candidate.content || '').trim().startsWith(text)`；一对一 `claimed` 与 `RESIDENT_PENDING_ECHO_FLOOR_SKEW_MS` 时间窗原样保留。commit `7ab1acdd7`。

### AC1 — 新回归判据（绿）

```
cd <worktree> && bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx --maxWorkers=1
```

用例先打印后断言：

- `deliveryTextLen=400 persistedLen=440 pendingRowsAfterMerge=0 userRowsAfterMerge=1`

结果：`Test Files 1 passed (1) / Tests 15 passed (15)`，exit 0。

红态：同一用例在未修实现（严格相等）上红在 `pending.length`，`1 !== 0`（`pendingRowsAfterMerge=1`），逐字见 AC3。

### AC2 — 正对照（<=400 字仍退休）

- 400 字边界：`deliveryTextLen=400 persistedLen=400 pendingRowsAfterMerge=0 userRowsAfterMerge=1`
- 短消息：`deliveryTextLen=8 persistedLen=8 pendingRowsAfterMerge=0 userRowsAfterMerge=1`

两条均通过（同文件 `(g) … positive control` 用例）。

### AC3 — 负控（改完即还原）

把实现还原为 `(candidate.content || '').trim() !== text` 后单跑同文件：

```
× (g) a capped delivery row is retired by the persisted turn it is a prefix of > draws the persisted full message once and no pending row (a 440-char send) 6ms
  → the capped delivery row retires once its full turn is on screen
  1 !== 0
 FAIL src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx:678:12
 Test Files 1 failed (1) / Tests 1 failed | 14 passed (15)
```

AC2 的两条（400 字边界与短消息）在还原态仍绿。恢复：从备份 `cp` 回（等价 `git checkout -- src/modules/chat-session/hooks/useSessionStore.ts`）。压缩注释后 `grep -n "startsWith(text)"` 现命中第 905 行（原记录为 928 行，语义未变）。

### AC4 — 既有客户端判据不回退

```
cd <worktree> && bash scripts/with-memory-cap.sh npx vitest run \
  src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx \
  src/modules/chat/tests/sessionMessageReconciliation.test.ts \
  src/modules/chat/hooks/tests/useSessionStoreCommandLifecycle.test.tsx --maxWorkers=1
```

`Test Files 3 passed (3) / Tests 29 passed (29)`，exit 0。`npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning，无 error）。

### AC5 — 真实页面（DoD 第 3 条）

**执行时没有活的 delivery，如实说明。** 在 worktree dev server（vite `127.0.0.1:5191`，`SERVER_PORT=3001` 代理 live 实例）上，用 MCP `session_create`（项目 `/data/home/yale/work/claudecodeui`，`lifecycleMode=resident`，消息 440 字）建了两个隔离 resident 会话（`24f2080f-358e-4403-9d23-4c5fe712cb17`、`21df8d1d-f956-4a87-b4ae-c9eb176d924b`）。

- 每次 delivery 都在约 353ms 内 `queued→started→cancelled`；页面以 25ms 轮询 2597 个样本，`MAX_PENDING_TEXT_LEN=0`，delivery 行只以 `cancelled` 态出现（无文本、`data-resident-withdrawn=true`）。会话 transcript 的 assistant 行是 `Failed to authenticate: OAuth session expired and could not be refreshed` —— 本环境的 resident CLI 进程无法认证，产不出 `queued`/`started` 的真实 delivery。
- 因此**没有截到“两条连续 user 气泡”的真实页面截图**。`tmp/resident-capped-pending.png` / `tmp/resident-capped-final.png` 是上述认证失败会话（两条 454 字 user 行 + 两条已撤回 delivery 行），**不作为修复证据**。
- 用真实 store + 真实组件的读数补足（AC1）：真实 `useSessionStore` 合并后 `pendingRowsAfterMerge=0`、`userRowsAfterMerge=1` 且内容是持久化全文 440 字；真实 `PendingResidentMessage` 不渲染任何 pending 行。
- 清理：两个会话已 `session_close`；observer token 已 `revoke`（row absent，`GET /api/auth/user` → 401）；vite 已停止。

### 续做轮 2026-11-20 — ratchet 压回基线 + 一个 develop 全局时间炸弹

**1) oversize 棘轮（本轮 suite 的真红，已修）。** 上一轮 fan-in 红在 `ratchet: oversizeFiles src/modules/chat-session/hooks/useSessionStore.ts 2335→2358 — 基线内读数不得上调`。修法按等量删行的既有先例：把新增说明压回原 doc 注释的同段行数（保留前缀匹配的理由、cap 与 MCP 无 `local_` 行两点），并把拆开的两个 `if` 合回单条 `if (claimed.has(candidate) || !(candidate.content || '').trim().startsWith(text))`。读数：

- `wc -l src/modules/chat-session/hooks/useSessionStore.ts` → **2335**（= 基线，净 0 增行）。
- `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/architecture-ratchet.test.ts` → `tests 6 / pass 6 / fail 0`，exit 0。
- 行为未变：AC1/AC2/AC4 的命令在本轮压缩后重跑仍绿（见下）。

**2) `src/modules/architecture/tests/architectureTab.test.tsx` 的 `the analysis time is a relative reading`（delta 外、develop 全局红，已修）。** 该文件与本任务 delta 无交集（`git diff --stat develop -- <file>` 为空），红因是夹具时间炸弹：`GENERATED_AT = '2026-10-20T15:52:34.427Z'` 固定值；`formatRelativeTime` 用 `numeric:'auto'`，跨过 30 天月界后读数从 “… ago” 变成 “last month”，`/ago|now/i` 必红。2026-11-20 恰好第 31 天 ⇒ **任何树都红**（两个同类 ready 任务 `gap-routine-architecture-analysis-cycle-shared-types-type-only-3`、`gap-routine-architecture-analysis-file-scc-pin-scope-covers-2-of-14-directories` 的 blocker 是逐字同一条，`added=- changed=architectureTab`，即 develop 侧同红、仅签名形状不同）。修法：夹具改为滚动值 `new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()`，判据（相对读数、`dateTime` 保留 ISO、`title` 是本地精确时间）原样不动。读数：

- `bash scripts/with-memory-cap.sh npx vitest run src/modules/architecture/tests/architectureTab.test.tsx --maxWorkers=1` → `Test Files 1 passed (1) / Tests 129 passed (129)`，exit 0（修前：`2 failed | 127 passed`，`Expected /ago|now/i, Received "last month"`）。
- 该文件按 DoD 的“新增/改动其它文件先经 task_write 补 Touches”已写入 `## Touches`。

**3) 本轮复核读数（压缩后重跑）。**

- AC4 三文件：`Test Files 3 passed (3) / Tests 29 passed (29)`，exit 0。
- `npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning）。

**4) 仍在 develop 侧的 delta 外红（未自修，供 fan-in A/B 判读）。** `server/modules/providers/tests/provider-models.service.test.ts`：单跑 `AssertionError ... [gpt-6.2-astra, gpt-6.2-sol]`（curated 目录 8 项 vs 打包 CLI 目录 10 项），suite 日志里该文件首红是 `[codex-models] model/list discovery empty-or-failed visible=0`；本任务 Touches 无交集，属机器上 codex CLI 目录前进，未改动。

## 验证记录

该轴仍暗,理由:本任务只改 resident 待发行的退休判据（严格相等→前缀）与判据用例，未新增模块/依赖、未改服务端 cap 或快照形状，未做架构度量。

## Blocker

**2026-11-20T12:17:27.515Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/shared/tests/architecture-ratchet.test.ts:   AssertionError [ERR_ASSERTION]: ratchet: oversizeFiles src/modules/chat-session/hooks/useSessionStore.ts 2335→2358 — 基线内读数不得上调（此基线只允许下降） [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=server/shared/tests/architecture-ratchet.test.ts,server/shared/tests/architecture-ratchet.test.ts changed=src/modules/architecture/tests/architectureTab.test.tsx]
- run_id：wk-prod-anchor
- session_id：316b1ef7-3618-4cd9-b28a-7a52f40e4afa
- 后续：本条两条红均已在续做轮处理——ratchet 压回 2335（单跑 6/6 绿）；architectureTab 夹具时间炸弹改为滚动值（129/129 绿）。见 Evidence「续做轮 2026-11-20」。
