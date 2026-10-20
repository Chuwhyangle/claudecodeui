---
id: gap-mcp-contract-extract
title: Extract server/shared/mcp-contract from mcp-gateway
  (errors/types/schemas/principal/approval-deps + ToolDefinition/ToolRegistry +
  ACCESS_TOKEN_SCOPES + SessionTurnPort)
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-20）：`task_list search=mcp-contract` → 0 命中；`task_list search="extract MCP contract"` → 0 命中；`task_get gap-mcp-contract-extract` → no such task（id 无碰撞，无需改 slug）。相关但不同机制（none found / separate）：`gap-ac394-server-import-cycle-budget`（done）是目录图 SCC 棘轮，只数环与基线、不做符号搬迁；`gap-server-provider-websocket-init-cycle-ports`（done）是 ports 模式先例，不是本次 contract 抽取；`gap-mcp-gateway-tool-registration-extract`（superseded）已被 `docs/proposals/mcp-gateway-tool-architecture.md` 阶段 1+2 取代，本条承接其分支的 fanOut/LOC 收益与「抽 contract」方向，其 read/write 切法已被提案裁定撤销。

**这是提案 `docs/proposals/mcp-gateway-tool-architecture.md` 的阶段 1**：把 MCP 机制契约抽进新叶子 `server/shared/mcp-contract/`，使阶段 2 能把工具实现拆成 AC-394 叶子。本任务**不创建任何工具包**；develop 上工具实现仍留在 `mcp-gateway` 内。

**要搬的符号（develop 上已核实）**：

- `MCP_ERROR_CODES` + error-envelope 类型 + `McpToolError`（定义于 `server/modules/mcp-gateway/mcp-error-envelope.ts`）、`McpToolInputSchema`（`mcp-gateway.audit.ts:227`）、`McpPrincipal`（`mcp-gateway.auth.ts:51`）、`McpApprovalDeps`，以及这些文件为跨文件复用而导出的 approval/error-envelope 类型。
- 新增：`ToolDefinition`、`McpToolModule`、`McpToolRegistry`（按提案 §3.3）——带 `requiredScopes: string[]` 与 `annotations`（复用既有 `MCP_TOOL_ANNOTATIONS` 形状）。**不要发明 `McpToolScope` 枚举**（read/write 由 `readOnlyHint` 表达；授权由 `requiredScopes` 表达）。
- `ACCESS_TOKEN_SCOPES`（定义于 `server/modules/oauth/access-tokens.service.ts`）：把常量搬进 `mcp-contract`；`oauth/index.ts` 再导出它，使 oauth 的公开面不变。
- `SessionTurnPort` 接口（仅类型）加进**既有** `server/shared/ports/`（新增兄弟文件 `session-turn.port.ts` 或扩展现有 port 文件）。**不要搬 `readSessionTurn` 函数**——其实现留在 `server/modules/providers/list/claude/claude-runtime.provider.ts`；阶段 2 由 composition root 注入它。
- 工具包需要的类型别名（`UiStateRequestOptions`、`ActivityProtocolSnapshot`、`ChatRunLookupResult`、`QuaySnapshot`、`ControlStopTaskOutcome`）：**先查** `server/shared/types.ts` / `server/shared/interfaces.ts` 并复用已有者；只把真正需要且当前不在那里的搬进/别名到 `server/shared/types.ts`。

**复用既有 `server/shared/ports/`**（已含 `session-host-control.port.ts`、`chat-run-registry.port.ts`、`connected-clients.port.ts`、`provider-registry.port.ts`、`voice-rules.port.ts`）。**不要创建 `mcp-contract/ports/`**。

**不改任何 MCP 行为/协议/scope 语义**；测试断言文本一字不改，只改 import 路径。`server/shared/index.ts` **不碰**：消费者直接 `import ... from '@/shared/mcp-contract'`，shared barrel 不 re-export contract。

## AC

- [x] (a) **contract 叶子存在且全绿**：`server/shared/mcp-contract/` 存在且带 `index.ts` barrel；`npm run typecheck` 退出 0 且 `npm run lint` 退出 0。
- [x] (b) **搬走的符号可从 contract barrel import，且原定义点不再定义**：`MCP_ERROR_CODES` / `McpToolError` 等可从 `@/shared/mcp-contract` import；grep 定义点证明它们不再 DEFINED 于 `mcp-error-envelope.ts` / `mcp-gateway.audit.ts` / `mcp-gateway.auth.ts`（旧文件现在从 `@/shared/mcp-contract` import）。贴出 grep 原文。
- [x] (c) **无新 scope 枚举**：`grep -rn "McpToolScope" server --include='*.ts'` 返回 0 命中。
- [x] (d) **无 `mcp-contract/ports/` 目录**：`server/shared/mcp-contract/ports/` 不存在；domain ports 仍在 `server/shared/ports/` 下。贴出 `ls server/shared/ports` 证明。
- [x] (e) **AC-394 保持绿（scoped 跑）**：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出 0；`server/shared/mcp-contract` 同时注册进 `server/shared/tests/server-import-cycle-budget.baseline.json` 的 `directoryManifest` **和** `server/shared/tests/server-import-cycle-budget.test.ts` 的 `MANIFEST_PIN` 常量，`nodeCount` 上移到等于 `directoryManifest.length`；`cycleGroups` G1/G2/G3 与 `fileEdges` 不动。
- [x] (f) **scoped 消费方测试绿**（逐个跑，或用带并发夹的受限循环）：`## Touches` 里的 mcp-gateway 测试文件，加 `server/modules/oauth/tests/access-token-scopes.test.ts` 与 `server/modules/oauth/tests/oauth-consent-page.test.ts` 与 Touches 里的两个 voice-realtime 测试。记录 pass 数；断言文本未改（仅 import-path 编辑）。
- [x] (g) **`readSessionTurn` 仍在其实现处**：grep 函数定义，`readSessionTurn` 仍在 `server/modules/providers/list/claude/claude-runtime.provider.ts`（只往 `server/shared/ports/` 加了 port TYPE，未搬函数）。
- [x] (h) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地标准是「contract 是真叶子（只 import `server/shared/**` + builtins）且阶段 2 工具包可以依赖它」，不是「多了一个目录」。必须贴出：①AC-394 运行原样输出，显示 `shared/mcp-contract` 已注册且 SCC 组（G1/G2/G3）不变；②grep 原样输出，显示搬走符号的原定义点现在从 contract import；③typecheck / lint 退出码与 scoped 测试 pass 计数；④`server/shared/mcp-contract` 的 import 面证明它是叶子（对 `server/modules/**` 零 import）。

## Verification evidence

- **(a)** `npm run typecheck` → exit 0 (client + `server/tsconfig.json` + scripts). `npm run lint` → exit 0 (pre-existing warnings only; no new warning in the touched files). Contract barrel present: `server/shared/mcp-contract/{index,errors,types,schemas,principal,approvals,tool-definition,tool-registry}.ts`.
- **(b)** Old definition points now import/re-export from the contract:
  - `mcp-error-envelope.ts:16: export * from '@/shared/mcp-contract/errors.js';`
  - `mcp-gateway.audit.ts:41: import type { McpToolInputSchema } from '@/shared/mcp-contract/index.js';`
  - `mcp-gateway.auth.ts:37: import type { McpPrincipal } from '@/shared/mcp-contract/index.js';`
  - `access-tokens.service.ts:18: import { ACCESS_TOKEN_SCOPES } from '@/shared/mcp-contract/index.js';`
  - `grep -n "export const MCP_ERROR_CODES\|export class McpToolError\|export type McpToolInputSchema =\|export type McpPrincipal =\|export const ACCESS_TOKEN_SCOPES ="` over those four files → exit 1 (0 matches; no definitions remain).
- **(c)** `grep -rn "McpToolScope" server --include='*.ts'` → exit 1 (0 hits).
- **(d)** `ls server/shared/ports` → `chat-run-registry.port.ts connected-clients.port.ts provider-registry.port.ts session-host-control.port.ts session-turn.port.ts voice-rules.port.ts`; `ls -d server/shared/mcp-contract/ports` → No such file or directory.
- **(e)** `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` → 11 pass / 0 fail, exit 0. Readings: `(c) manifest=50 dirs, measured nodes=50`; `(d) shared->modules edges: 0`; static+dynamic SCC is the pinned 8-member G1, static-only the pinned 7-member sub-part; G2/G3 empty. `directoryManifest` contains `shared/mcp-contract` and `MANIFEST_PIN` names it; `nodeCount` 49 → 50; `cycleGroups` and `fileEdges` unchanged.
- **(f)** Scoped consumer tests (25 files, one bounded `--test-concurrency=4` run under `scripts/with-memory-cap.sh`) → **172 pass / 0 fail**, exit 0. No test assertion text was edited; no test file was changed at all (the origin barrels/modules kept their public surface).
- **(g)** `server/modules/providers/list/claude/claude-runtime.provider.ts:1191: export function readSessionTurn(...)` — unchanged. Only the type-only `SessionTurnPort` was added under `server/shared/ports/`.
- **(h)** `anti-drift-touches-check --task gap-mcp-contract-extract --merge-target develop` → `ANTI-DRIFT OK … 24 actual file(s), all within declared Touches (82 glob(s))`.
- **Leaf proof (DoD ④)** the contract's only non-self imports are `@modelcontextprotocol/sdk/types.js`, `zod` and `@/shared/types.js` — **zero** imports from `server/modules/**`.

## Touches

新文件（mcp-contract 内部文件按类别命名，实现若合并进更少文件则 actual ⊆ declared 仍成立）：

- server/shared/mcp-contract/index.ts (new)（barrel）
- server/shared/mcp-contract/errors.ts (new)（MCP_ERROR_CODES + error-envelope + McpToolError）
- server/shared/mcp-contract/types.ts (new)（ToolDefinition / McpToolModule / McpToolRegistry + 搬迁类型别名）
- server/shared/mcp-contract/schemas.ts (new)（McpToolInputSchema）
- server/shared/mcp-contract/principal.ts (new)（McpPrincipal）
- server/shared/mcp-contract/approvals.ts (new)（McpApprovalDeps + approval 类型）
- server/shared/mcp-contract/tool-definition.ts (new)
- server/shared/mcp-contract/tool-registry.ts (new)
- server/shared/ports/session-turn.port.ts (new)（SessionTurnPort 接口）

搬出定义（原定义点）：

- server/modules/mcp-gateway/mcp-error-envelope.ts
- server/modules/mcp-gateway/mcp-gateway.audit.ts
- server/modules/mcp-gateway/mcp-gateway.auth.ts
- server/modules/oauth/access-tokens.service.ts
- server/modules/oauth/index.ts

消费方（import 路径更新；断言文本不变）：

- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/mcp-approvals.ts
- server/modules/mcp-gateway/mcp-changes.ts
- server/modules/mcp-gateway/mcp-draft.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-gateway.resident-tools.ts
- server/modules/mcp-gateway/mcp-overview-tools.ts
- server/modules/mcp-gateway/mcp-resolve-target.ts
- server/modules/mcp-gateway/mcp-run-get.ts
- server/modules/mcp-gateway/mcp-session-background.ts
- server/modules/mcp-gateway/mcp-session-cancel-queued.ts
- server/modules/mcp-gateway/mcp-session-host-control.ts
- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/mcp-session-reconfigure.ts
- server/modules/mcp-gateway/mcp-session-search.ts
- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/mcp-ui-clients-list.ts
- server/modules/mcp-gateway/mcp-ui-focus-turn.ts
- server/modules/mcp-gateway/mcp-ui-navigation.ts
- server/modules/mcp-gateway/mcp-ui-open-session.ts
- server/modules/mcp-gateway/mcp-ui-open-task.ts
- server/modules/mcp-gateway/mcp-ui-show-diff.ts
- server/modules/mcp-gateway/mcp-ui-tools.ts
- server/modules/mcp-gateway/mcp-ui-visible-context.ts
- server/modules/mcp-gateway/mcp-usage-stats.ts
- server/modules/mcp-gateway/mcp-write-notification.ts
- server/modules/oauth/oauth-consent.service.ts
- server/modules/oauth/oauth-provider.service.ts
- server/modules/voice-realtime/voice-realtime-live-executor.ts

测试（仅 import-path 编辑）：

- server/modules/mcp-gateway/tests/mcp-auth.test.ts
- server/modules/mcp-gateway/tests/mcp-changes.test.ts
- server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts
- server/modules/mcp-gateway/tests/mcp-insufficient-scope.test.ts
- server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
- server/modules/mcp-gateway/tests/mcp-not-found-semantics.test.ts
- server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
- server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts
- server/modules/mcp-gateway/tests/mcp-session-create-library-model.test.ts
- server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-focus-turn.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-navigation-harness.ts
- server/modules/mcp-gateway/tests/mcp-ui-open-session.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-open-task.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-show-diff.test.ts
- server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts
- server/modules/mcp-gateway/tests/mcp-write-notification.test.ts
- server/modules/oauth/tests/access-token-scopes.test.ts
- server/modules/oauth/tests/oauth-consent-page.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts

搬进 `server/shared/types.ts` 的工具包类型别名（原定义点保留 re-export，公开面不变）：

- server/shared/types.ts
- server/modules/providers/services/claude-turn-phase.service.ts
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/websocket/services/ui-state-request.service.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/websocket/services/activity-protocol.service.ts
- server/modules/quay/quay.service.ts

AC-394 注册：

- server/shared/tests/server-import-cycle-budget.baseline.json
- server/shared/tests/server-import-cycle-budget.test.ts

自身：

- tasks/gap-mcp-contract-extract.md

## Blocker

**2026-10-20T15:25:15.637Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=9568 server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts passed=false end_ms=1792509724584
- run_id：wk-prod-anchor
- session_id：5dadba44-0b20-47fc-bc53-4953f4d9a639
