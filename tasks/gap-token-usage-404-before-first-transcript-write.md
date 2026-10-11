---
id: gap-token-usage-404-before-first-transcript-write
title: 全新 Claude 会话首轮写入 transcript 前 token-usage 返回
  404（SESSION_FILE_NOT_FOUND），计数器空白——会话行存在而文件未建时返回空用量 200
status: done
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

- [x] AC1 已知会话、transcript 未建 ⇒ 200 空用量（**取假形态，排在判据文件该组最前**）：`server/modules/providers/tests/provider-token-usage.service.test.ts` 新增用例，`getSessionById` 返回一个 `provider:'claude'`、带 `jsonl_path` 的行，`fileExists` 返回 false ⇒ `getSessionTokenUsage` 不抛错、返回 `used === 0` 且 `inputTokens === 0`、`outputTokens === 0`；另一例为不带 `jsonl_path`、仅带 `project_path` 的行（推导路径分支）同样返回零值。在未修复的树上该用例必红（实施者记一次红读数：`SESSION_FILE_NOT_FOUND`）。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-token-usage.service.test.ts` 退出 0。
- [x] AC2 未知会话仍 404（负控）：同文件既有用例 `token usage reports SESSION_NOT_FOUND for an unknown app session id`（`:181`）保留且仍断言 `code === 'SESSION_NOT_FOUND'`，并补断言 `statusCode === 404`。判据同 AC1 命令退出 0。
- [x] AC3 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：在真实运行的服务上新建一个 Claude 会话（Live Voice 入口或 composer 均可），在其首轮写入 transcript **之前**（可先确认 `~/.claude/projects/<encoded>/<providerSessionId>.jsonl` 尚不存在），用浏览器或带真 JWT 的 `curl` 请求 `GET /api/providers/sessions/<id>/token-usage` ⇒ 200 且 `data.used === 0`；首轮完成后再请求 ⇒ 200 且 `used > 0`；对一个不存在的 session id 请求 ⇒ 404。证据落在本任务 `## 验证记录`：会话 id、三次请求的状态码与 body、文件不存在时刻的 `ls` 读数，以及页面 token/context 计数器在首轮前不再空白的截图。须确认被测服务跑的是含修复的产物（比对 dist-server 与提交）。仅有单元测试不算 done。

## 验证记录

### 形态选择（Proposal 给的两个选项）

选**带 `total` 的零值**（`summarizeClaudeTokenUsage([], dependencies.getClaudeContextWindow(), modelRow)`），未选被取代会话分支那种无 `total` 的 `{ used:0, … }`。理由：

- 同一逻辑状态（会话已知、尚无用量）在「文件已存在但 transcript 里还没有 assistant 轮」这条既有路径上本来就返回 `total`（`summarizeClaudeTokenUsage` 末尾经 `resolveContextWindow` 得到），文件缺失时省掉它会自相矛盾；`emptyCodexTokenUsage()`（Codex 的「无用量」空值）也带 `total: 200_000`。
- 它让 token 面板的 `Context window` 行在首轮前不再缺席：该行的渲染条件是 `total > used`，无 `total`（或 `total: 0`）时整行不渲染（见下方截图对照）。

`modelRow` 取自 `session.model`（此时尚无 transcript 可取 `findNewestClaudeModelId`），与文件存在路径的取法一致。

### AC1：已知会话、transcript 未建 ⇒ 200 空用量（取假形态）

判据文件新增两例，位于该组最前（`createSessionRow` 之后、`token usage lookup requires only the app-facing session id for Claude` 之前），断言 `used/inputTokens/outputTokens === 0`、`breakdown` 深等 `{input:0,output:0}`、`total === 200_000`。

- **红读数**：把 service 回退到 `fbeada48^`、保留新用例，跑 AC1 命令 ⇒ 退出 1；两例均 `Error [AppError]: Session file for "app-session" was not found.`，`code: 'SESSION_FILE_NOT_FOUND'`、`statusCode: 404`（抛出点 = 回退树 `provider-token-usage.service.ts:481`）。
- **绿读数**（修复树）：同一命令 `ℹ tests 15 / ℹ pass 15 / ℹ fail 0`，退出 0（merge develop 之后再跑一次，仍 15/15/0/exit 0）。

### AC2：未知会话仍 404（负控）

既有用例 `token usage reports SESSION_NOT_FOUND for an unknown app session id` 保留，断言 `error.code === 'SESSION_NOT_FOUND' && error.statusCode === 404`——`statusCode` 断言在本次实施前就已在位，未改动，故只做了保留核对。同一命令退出 0。

### AC3：静态门

- `npm run typecheck`（`tsc --noEmit` × tsconfig.json / server / scripts 三个）退出 0。
- `npm run lint`（oxlint）退出 0（只有既有 warning，无 error）。

### DoD：真实服务

被测产物：`dist-server/`，其 `build-info.json` 的 `gitSha = fbeada489d4d7dcf69c644b85179767328c94680`（= 本分支 HEAD，构建时工作树干净），且产物里 `dist-server/server/modules/providers/services/provider-token-usage.service.js:377-382` 就是新分支（`const modelRow = session.model ? … ; return summarizeClaudeTokenUsage([], …)`）。服务用 `node dist-server/server/index.js` 起，环境为临时 `DATABASE_PATH` / `HOME`，**不设 `CLAUDE_CONFIG_DIR`**（否则 CLI 写盘目录与服务派生的 `$HOME/.claude/projects/...` 不一致），`HOST=127.0.0.1` + 随机端口。探针脚本用后即删（未入库）。

一次真跑：

- `POST /api/providers/sessions {provider:'claude', projectPath:<tmp>}` ⇒ 201，`SESSION_ID=880a51b4-e8ac-4c40-a48c-794cf3d47a03`。建行瞬间的 DB 行：`provider=claude`、`provider_session_id=null`、`jsonl_path=null`、`project_path=/tmp/token-usage-dod-11M5cj/project`（即走**推导路径**分支，正是 AC1 第二例覆盖的那一支）。
- 服务自己会解析的 transcript 路径（镜像它的解析：`provider_session_id || sessionId` + `project_path` 的 `[^a-zA-Z0-9-]→-` 编码）：`/tmp/token-usage-dod-11M5cj/home/.claude/projects/-tmp-token-usage-dod-11M5cj-project/880a51b4-e8ac-4c40-a48c-794cf3d47a03.jsonl`；`existsSync = false`，其父目录 `readdirSync` = `(dir absent)`——文件不存在时刻的 `ls` 读数是「目录都还没建」。
- **首轮之前**：`GET /api/providers/sessions/880a51b4-…/token-usage` ⇒ **200**，body `{"success":true,"data":{"used":0,"total":160000,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0,"cacheTokens":0,"breakdown":{"input":0,"output":0}}}`。
- 经 WebSocket `chat.send`（内容 `Reply with exactly: ok`）跑完一轮后：DB 行变成 `provider_session_id=deef37bc-2ec8-428f-8e46-16837377fb77`、`jsonl_path=/tmp/token-usage-dod-11M5cj/home/.claude/projects/-tmp-token-usage-dod-11M5cj-project/deef37bc-2ec8-428f-8e46-16837377fb77.jsonl`，该文件 `existsSync = true`；`GET …/token-usage` ⇒ **200**，`{"used":20499,"total":160000,"inputTokens":20497,"outputTokens":2,"cacheReadTokens":0,"cacheCreationTokens":0,"cacheTokens":0,"breakdown":{"input":20497,"output":2}}`。
- 不存在的 id：`GET /api/providers/sessions/00000000-0000-4000-8000-doesnotexist/token-usage` ⇒ **404**，`{"success":false,"error":{"code":"SESSION_NOT_FOUND","message":"Session \"00000000-0000-4000-8000-doesnotexist\" was not found."}}`。
- 探针 `VERDICT=PASS`，退出 0。

### 页面 token/context 计数器（截图对照）

同一套真服务 + 浏览器（`playwright` 库，`context.addInitScript` 把 JWT 写进 `localStorage['auth-token']` 并置 `userLanguage:'en'`；再 `UPDATE users SET has_completed_onboarding = 1` 过掉 onboarding 门），打开 `/session/<id>`，点 composer 的 token chip（`aria-label="Show token usage"`）打开 Token Usage 面板：

- **修复后**（`/tmp/tu-dod-shots/modal.png`）：页面 console 无 404（只有两条与本次无关的 403）；面板列出 `Total tokens used 0` / `Breakdown Unavailable` / **`Context window 160,000`**，PROVIDER `Claude`、MODEL `default`。
- **修复前**（把 service 回退到 `fbeada48^` 重新 `npm run build:server`，其余完全不动；`/tmp/tu-dod-shots-before/modal.png`）：页面出现一条 `404 (Not Found)` 的 `PAGE_ERROR`，面板只有 `Total tokens used 0` / `Breakdown Unavailable`，**没有 `Context window` 行**。

两张截图同一浏览器、同一视口、同一脚本，只换了服务端产物。

**诚实说明**：composer 上那枚 chip 在两种情况下**都**渲染 `0`（`TokenUsageSummary` 对 `usage === null` 与零值对象同样显示 `formatTokenCount(0) === '0'`，它只读 `used`/`inputTokens`/`outputTokens`，不读 `total`）。所以「计数器在首轮前不再空白」这一可视差异落在 token 面板的 `Context window` 行（以及页面不再有那条 404），而不是 chip 上的数字本身。这也是选带 `total` 形态的直接原因——无 `total` 的形态在页面上与修复前**完全无法区分**。

### 未纳入本任务（按 Proposal，保持原样）

- Claude 分支 `:456-459`（既无 `jsonl_path` 也无 `project_path`）仍抛 `SESSION_FILE_NOT_FOUND`；`INVALID_SESSION_PATH` 400 未动。
- Codex 分支的 `CODEX_SESSION_FILE_NOT_FOUND` 未动（本次无实测证据）。

## Touches

- server/modules/providers/services/provider-token-usage.service.ts
- server/modules/providers/tests/provider-token-usage.service.test.ts
- tasks/gap-token-usage-404-before-first-transcript-write.md (self)
