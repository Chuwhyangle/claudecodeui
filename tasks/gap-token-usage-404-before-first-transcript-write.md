---
id: gap-token-usage-404-before-first-transcript-write
title: 全新 Claude 会话首轮写入 transcript 前 token-usage 返回
  404（SESSION_FILE_NOT_FOUND），计数器空白——会话行存在而文件未建时返回空用量 200
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

### 现象（2026-10-11 操作者 console，2026-10-12 复核）

页面加载时 `GET /api/providers/sessions/79d7515b-24b8-409c-b434-f4669105373b/token-usage` → **404**。
- DB（`~/.cloudcli/auth.db` 表 `sessions`）：该行 `provider=claude`、`lifecycle_mode=resident`、`created_at=2026-10-11 15:37:53`，现映射 `provider_session_id=c5b83422-48b1-4160-bdad-5eb84099e54a`，`jsonl_path=/data/home/yale/.claude/projects/-data-home-yale-work-claudecodeui/c5b83422-48b1-4160-bdad-5eb84099e54a.jsonl`。
- 该 transcript 文件的诞生时间（`stat %w`）是 2026-10-11 15:38:09.765Z，首条记录 `timestamp` 为 15:38:09.610Z——即首轮写入时才被创建，比会话行晚约 16 s。
- 同一端点现在返回 200（used 95348）：映射本身没问题，404 只发生在「行已建、文件未建」的窗口里。
- 触发路径：Live Voice 在新会话里先经 session gateway 分配会话行、立即进入 `/session/<id>`（`src/modules/chat/ChatInterface.tsx:415-447`，`handleSessionEstablished` 于 `:439`），页面在这 16 s 窗口内拉 token usage。任何全新 Claude 会话都可能命中（文字 composer 的窗口只是更短）。

### 现状（2026-10-12 逐文件复核，develop `bd89d597`）

- 路由：`server/modules/providers/provider.routes.ts:890-897` 直接把 `providerTokenUsageService.getSessionTokenUsage` 的 `AppError` 交给 `asyncHandler`。
- 服务：`server/modules/providers/services/provider-token-usage.service.ts:479-484` Claude 分支 `!dependencies.fileExists(sessionFilePath)` ⇒ 抛 `SESSION_FILE_NOT_FOUND` 404。会话行不存在时是 `:372-378` 的 `SESSION_NOT_FOUND` 404；被取代会话（`:386-396`）返回 `{ used:0, inputTokens:0, outputTokens:0, breakdown:{input:0,output:0} }`。
- 客户端：`src/modules/chat/hooks/useChatSessionState.ts:1928-1950` 的初始拉取对非 2xx `setTokenBudget(null)`，且只在 `selectedSession?.id` 变化时重拉；之后只有 `src/modules/chat/hooks/useChatRealtimeHandlers.ts:599-604` 的实时 `token_budget` status 帧或整页刷新才填回 ⇒ token/context 计数器在这段时间空白。

### 修法

Claude 分支：会话行存在、但 transcript 文件尚不存在时，返回空用量（与被取代会话分支同形的 `{ used:0, … }`；若实施者希望计数器显示总窗口，可改用 `summarizeClaudeTokenUsage([], getClaudeContextWindow(), modelRow)` 得到带 `total` 的零值，二选一在完成记录里写明）。真正未知的会话仍 404 `SESSION_NOT_FOUND`。`:456-459`（既无 `jsonl_path` 也无 `project_path`）与 `INVALID_SESSION_PATH` 400 不在本任务范围、保持原样。Codex 分支 `:436-437` 的 `CODEX_SESSION_FILE_NOT_FOUND` 有同形窗口，但本次无实测证据，不在本任务范围（如实施者顺手同改，须补对应 AC 并在完成记录说明）。客户端不需要改：200 的零值即可让计数器显示，随后实时 `token_budget` 帧照常覆盖。

### 关联 / 粒度

<!-- dedup-ref --> 机制去重（2026-10-12 实测）：open 任务对 `token-usage` / `SESSION_FILE_NOT_FOUND` / `provider-token-usage` / `tokenBudget` 均 0 命中；`task-granularity-advice.js` 对本任务 Touches 报 `peers: []`：none found。规模小（预计 <100 行），但无同文件 open 任务可并，按操作者要求单独立案。

## AC

- [ ] AC1 已知会话、transcript 未建 ⇒ 200 空用量（**取假形态，排在判据文件该组最前**）：`server/modules/providers/tests/provider-token-usage.service.test.ts` 新增用例，`getSessionById` 返回一个 `provider:'claude'`、带 `jsonl_path` 的行，`fileExists` 返回 false ⇒ `getSessionTokenUsage` 不抛错、返回 `used === 0` 且 `inputTokens === 0`、`outputTokens === 0`；另一例为不带 `jsonl_path`、仅带 `project_path` 的行（推导路径分支）同样返回零值。在未修复的树上该用例必红（实施者记一次红读数：`SESSION_FILE_NOT_FOUND`）。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-token-usage.service.test.ts` 退出 0。
- [ ] AC2 未知会话仍 404（负控）：同文件既有用例 `token usage reports SESSION_NOT_FOUND for an unknown app session id`（`:181`）保留且仍断言 `code === 'SESSION_NOT_FOUND'`，并补断言 `statusCode === 404`。判据同 AC1 命令退出 0。
- [ ] AC3 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：在真实运行的服务上新建一个 Claude 会话（Live Voice 入口或 composer 均可），在其首轮写入 transcript **之前**（可先确认 `~/.claude/projects/<encoded>/<providerSessionId>.jsonl` 尚不存在），用浏览器或带真 JWT 的 `curl` 请求 `GET /api/providers/sessions/<id>/token-usage` ⇒ 200 且 `data.used === 0`；首轮完成后再请求 ⇒ 200 且 `used > 0`；对一个不存在的 session id 请求 ⇒ 404。证据落在本任务 `## 验证记录`：会话 id、三次请求的状态码与 body、文件不存在时刻的 `ls` 读数，以及页面 token/context 计数器在首轮前不再空白的截图。须确认被测服务跑的是含修复的产物（比对 dist-server 与提交）。仅有单元测试不算 done。

## Touches

- server/modules/providers/services/provider-token-usage.service.ts
- server/modules/providers/tests/provider-token-usage.service.test.ts
- tasks/gap-token-usage-404-before-first-transcript-write.md (self)