---
id: gap-mcp-outputschema-drift-overview-and-error-envelope
title: MCP gateway outputSchema 结构错配：overview 占位符未更新 + 错误信封撞成功态 schema（客户端报 -32602）
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

诊断（已核实代码，行号均为诊断时的实际行号）：两个独立的 outputSchema/真实结构错配 bug，叠加表现为 MCP
客户端报 `-32602 Structured content does not match the tool's output schema`。<!-- dedup-ref -->
与已落地的 `gap-ac247-overview-quay-cache-readonly`（overview/quay_snapshot 的功能本体）和
`gap-ac284-mcp-error-envelope`（统一错误信封）不是同一机制：那两个任务做的是"把功能/信封建对"，
本任务修的是它们落地之后才出现的"声明（outputSchema）与真实运行时结构（handler 返回 / 错误信封）
脱钩"的回归，不构成重复立案，仅作溯源标注。

Bug 1 — `overview` 的 outputSchema 从 AC-247 占位符起从未随真实 handler 更新：
`server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 的 `TOOL_BODIES.overview.outputSchema`
仍是 `{ overview: z.unknown().optional() }`，但 `registerMcpReadTools` 在
`overviewDeps` 已 wired（生产环境恒为 wired，见 `server/index.ts`）时，会用这份占位 outputSchema
去注册 `mcp-overview-tools.ts` 里的真实 handler `buildOverview`，其真实返回是
`OverviewPayload { running, awaitingPermission, aborted, hosts, quay }`
（字段定义见 `mcp-overview-tools.ts:130-189` 的
`McpOverviewRunning`/`McpOverviewAwaiting`/`McpOverviewAborted`/`McpOverviewHost`/`McpOverviewQuayEntry`，
其中 `quay` 是按 `status` 判别的联合：`no_quay_config` / `unknown` / `cached` 三支，`cached` 支还带
`tasks`/`driver`/`suite` 三个可空子对象）。这是恒定复现的 bug，与是否传 `project` 参数无关——裸调用
`overview {}` 同样会报错，因为校验永远是"真实字段集合"对"占位字段集合"。

修复：把 `TOOL_BODIES.overview.outputSchema` 改成精确匹配 `OverviewPayload` 的 zod 形状，
`quay` 字段用 `z.discriminatedUnion('status', [...])` 逐支精确声明三个分支，不用宽松的
`z.unknown()`/`z.any()` 兜底，否则会在某个分支上产生新的 additional-properties 错配。

Bug 2 — 工具报错时，统一错误信封撞上成功态 outputSchema：`mcp-error-envelope.ts` 的
`McpErrorEnvelope`（`code`/`message`/`retryable`/`details?`）经 `mcpErrorResult`/`toMcpErrorResult`
统一产出，且按 `mcp-gateway.audit.ts` 的设计意图，每条错误路径都会把它放进 `structuredContent`
（`isError: true` 的同时也带 `structuredContent`）。而 `node_modules/@modelcontextprotocol/sdk`
（当前 1.29.0）的客户端 `dist/*/client/index.js` 在 `callTool` 里对 `structuredContent` 的校验只判断
"是否存在"，没有按它自己的注释"跳过 error 情况"去判断 `isError`，于是任何工具只要报错
（例如 `sessions_list({project:"quay"})` 经 AC-246 目标门 `resolveInputTargets` 解析
`project` 失败时 throw 的 `PROJECT_NOT_FOUND`/`TARGET_AMBIGUOUS`），其错误信封就会被拿去校验
成功态 outputSchema（如 `sessions_list` 的 `{sessions, total}`），必然因"缺 sessions/total、多出
code/message/retryable/details"而报同一个 -32602，真正的业务错误码被这层客户端校验吞掉、
看不到了。

修复（采用方向 a'，不采用"错误路径不发 structuredContent"的方向 b'——那会破坏
`details.candidates`/`details.fields` 等既有机器可读字段，影响面更大）：从
`mcp-error-envelope.ts` 导出 `MCP_ERROR_ENVELOPE_SHAPE`（`z.ZodRawShape`，`code`/`message`/
`retryable`/`details` 四个字段全部 `.optional()`，带 Consumers 文档注释指向
`mcp-gateway.audit.ts` 的 `withMcpAudit`），然后在 `withMcpAudit` 组装 `outputSchema` 的唯一入口
（当前 `registration.outputSchema === undefined ? {} : { outputSchema: registration.outputSchema }`
那一行）改成 `{ outputSchema: { ...registration.outputSchema, ...MCP_ERROR_ENVELOPE_SHAPE } }`，
这是唯一一处拼接点，不在 19 个 `TOOL_BODIES` 条目里逐一重复。

granularity 说明：`task-granularity-advice.js` 对本任务的 Touches 报告两个共享
`mcp-gateway.read-tools.ts` 的 `ready` 态同根任务（`gap-mcp-cross-project-session-aggregation`、
`gap-mcp-draft-get-set-submit`），决定 separate——两者是不同机制（跨项目会话聚合 /
draft get-set-submit），且均已 `ready` 即将被调度执行，本任务是独立的窄范围 schema 缺陷修复，
合并不省工只会增加相互等待。

**Design note (from a lost prior attempt, unverified)**：单纯把 `MCP_ERROR_ENVELOPE_SHAPE` 拼进
`outputSchema` 可能不足以修好 Bug 2——工具自身声明的成功字段（如 `sessions`/`total`）若不是
`.optional()`，JSON Schema 的 `required` 列表仍会包含它们，错误信封不带这些字段，依旧会被判
"缺 required 属性"。先前一次（已丢失、未验证）的尝试发现：需要先把 `registration.outputSchema`
的每个字段都变成 `.optional()`（模块私有 `toOptionalOutputShape`），再拼接错误信封字段，使
JSON-schema `required` 整体清空。实现时请自行重新验证。

Completion record retreated 2026-10-09: no implementation found in repo; human instructed re-dispatch.

## AC

- [x] `grep -n "overview: {" -A3 server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 显示的
  `outputSchema` 不再是 `{ overview: z.unknown().optional() }` 字面量。
- [x] 新增/扩展 `server/modules/mcp-gateway/tests/mcp-overview.test.ts` 中的用例，用真实
  `buildOverview()` 的返回值（而非手写 fixture）驱动
  `z.object(TOOL_BODIES.overview.outputSchema).strict().safeParse(result).success === true`，
  且分别覆盖 `quay` 判别联合的 `no_quay_config`/`unknown`/`cached` 三个分支各一次；
  `node --import tsx --test server/modules/mcp-gateway/tests/mcp-overview.test.ts` 退出码 0。
- [x] `server/modules/mcp-gateway/mcp-error-envelope.ts` 导出 `MCP_ERROR_ENVELOPE_SHAPE`
  （`code`/`message`/`retryable`/`details` 均 `.optional()`），`grep -n
  "MCP_ERROR_ENVELOPE_SHAPE" server/modules/mcp-gateway/mcp-error-envelope.ts
  server/modules/mcp-gateway/mcp-gateway.audit.ts` 两个文件都命中，且只有
  `mcp-gateway.audit.ts` 的 `withMcpAudit` 一处把它拼进 `outputSchema`（不在
  `TOOL_BODIES` 的任何条目里重复出现）。
- [x] 新增单测：对 `sessions_list` 和 `overview` 各构造一次会触发
  `PROJECT_NOT_FOUND`/`TARGET_AMBIGUOUS` 的 `project` 取值，断言返回的
  `structuredContent`（`{code,message,retryable,details}`）能被"拼接后的 outputSchema"
  （`z.object({...toolOutputSchema, ...MCP_ERROR_ENVELOPE_SHAPE}).strict().safeParse`）
  校验通过；`node --import tsx --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
  server/modules/mcp-gateway/tests/mcp-audit.test.ts
  server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts` 退出码 0。
- [x] 既有覆盖 `details.candidates`/`details.fields` 等错误信封字段的测试保持通过（证明本次
  改动没有走方向 b'、没有从错误路径移除 structuredContent 的任何既有字段）。
- [x] `npm run typecheck` 退出码 0。

## DoD

真实落地，不是"测试绿了就算"：用这个仓库里已经在跑的 MCP gateway（`server/index.ts` 挂载的
`/mcp`，`resolveDeps`/`overviewDeps` 均按生产配置 wired），构造一次真实的
`tools/call overview {}`（不带 `project`）和一次 `tools/call sessions_list {project:"<一个不存在的
项目名/子串>"}`，用真实的 `@modelcontextprotocol/sdk` 客户端（本仓库 node_modules 里已装的那份）
发起调用并读取其返回：前者不再因 schema 不匹配报错而是能读到 `running`/`awaitingPermission`/
`aborted`/`hosts`/`quay` 五个字段；后者不再被客户端的 `-32602` 校验错误吞掉，而是能读到真实的
`PROJECT_NOT_FOUND`/`TARGET_AMBIGUOUS` 业务错误码。完成记录里要写清这两次真实调用各自读到的
原始返回（或至少其 `structuredContent`/错误码），不能只贴单测通过的截图。

## Touches

- server/modules/mcp-gateway/mcp-gateway.read-tools.ts（Bug1：TOOL_BODIES.overview.outputSchema 改成真实 OverviewPayload 形状）
- server/modules/mcp-gateway/mcp-overview-tools.ts（Bug1：新增导出 overviewOutputSchema —— 与 OverviewPayload 一一对应的五个顶层字段，quay 用 discriminatedUnion 逐支声明 no_quay_config/unknown/cached 三支）
- server/modules/mcp-gateway/mcp-error-envelope.ts（Bug2：新增 MCP_ERROR_ENVELOPE_SHAPE 导出）
- server/modules/mcp-gateway/mcp-gateway.audit.ts（Bug2：withMcpAudit 拼接 outputSchema 的唯一入口）
- server/modules/mcp-gateway/index.ts（按需导出 McpReadToolRegistration，供 mcp-overview.test.ts 读回 outputSchema 的录制 seam 使用）
- server/modules/mcp-gateway/tests/mcp-overview.test.ts（Bug1 单测：真实 buildOverview 输出过 schema）
- server/modules/mcp-gateway/tests/mcp-audit.test.ts（Bug2 单测：withMcpAudit 拼接行为本身）
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts（Bug2 单测：warm-cache 客户端重放探针）
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts（可选：仅在需要时扩展回归用例）
- tasks/gap-mcp-outputschema-drift-overview-and-error-envelope.md（本任务自身）

## Completion record

**DoD (a) — a WARM `tools/call overview {}`.** The harness mounts the production
`mountMcpGateway` (`resolveDeps`/`overviewDeps` wired) and drives it with the real
`@modelcontextprotocol/sdk` `Client`, which runs `tools/list` FIRST (warm cache). Raw return:
`isError=false`, `text={"running":[{"sessionId":"overview-fixture-busy","projectId":"812ba57d-1752-4ff6-9819-4bdd65ca0321","project":"overview-main","title":"Busy overview session","phase":…,"elapsedMs":…}, …`; the `structuredContent` carries all five keys
`running`/`awaitingPermission`/`aborted`/`hosts`/`quay`, and the `quay` entries' statuses read
`["cached","no_quay_config","unknown"]` (all three arms). No `-32602`.
`z.object(overviewOutputSchema).strict().safeParse(<the real reading>).success === true`.

**DoD (b) — a WARM `tools/call sessions_list {project: …}`.** Same warm client. Raw returns:
- `sessions_list({project:"zzz-no-such-project"})` → `isError=true`, `structuredContent.code="PROJECT_NOT_FOUND"`, text `No project has a title containing "zzz-no-such-project".`
- `sessions_list({project:"shared"})` → `isError=true`, `.code="TARGET_AMBIGUOUS"`, text `2 projects have a title containing "shared"; name exactly one — the gateway will not pick for you.`, `.details.candidates` present.
- `overview({project:"zzz-no-such-project"})` → `.code="PROJECT_NOT_FOUND"`; `overview({project:"shared"})` → `.code="TARGET_AMBIGUOUS"`.

Each returned envelope validates against the outputSchema read back off `tools/list`, via the SDK's
own ajv validator (`@modelcontextprotocol/sdk/validation/ajv`) — i.e. the gateway's real code reaches
the caller instead of being swallowed by `-32602`.

**AC1/AC2.** `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-overview.test.ts` → exit 0, 10/10 pass. Leg (i) drives a real `buildOverview()` reading through `z.object(overviewOutputSchema).strict()`, exercising all three `quay` arms.

**AC3.** `MCP_ERROR_ENVELOPE_SHAPE` is exported from `mcp-error-envelope.ts`; `grep` hits `mcp-error-envelope.ts` (definition, all four fields `.optional()`) and `mcp-gateway.audit.ts` (import + the SINGLE splice at `withMcpAudit`'s registration line); it appears in no `TOOL_BODIES` entry.

**AC4.** `mcp-overview.test.ts` leg (j) constructs `PROJECT_NOT_FOUND`/`TARGET_AMBIGUOUS` for `sessions_list` and `overview` and validates each returned `{code,message,retryable,details}` against the advertised merged schema. `mcp-read-tools.test.ts` + `mcp-audit.test.ts` + `mcp-error-envelope.test.ts` → exit 0, 19/19 pass.

**AC5.** `mcp-error-envelope.test.ts` (the `details.candidates`/`details.fields` coverage) stays green: direction b' was not taken and no existing envelope field was removed from the error path.

**AC6.** `npm run typecheck` → exit 0.

**Falsification (both bugs load-bearing).** Reverting the `withMcpAudit` splice → leg (j) red with
`MCP error -32602: Structured content does not match the tool's output schema: data must have required property 'sessions', data must have required property 'total', data must NOT have additional properties, …` (leg (i) stays green). Reverting only Bug 1 to the placeholder → leg (i) red with `data must NOT have additional properties` (×5) (leg (j) stays green). Both reverts restored; the committed tree is the fixed code.
