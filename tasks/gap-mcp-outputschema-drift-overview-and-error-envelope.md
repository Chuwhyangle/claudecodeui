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

**实现时发现并修正的一处方案偏差**：单纯按原方案把 `MCP_ERROR_ENVELOPE_SHAPE` 拼进
`outputSchema`（`{...registration.outputSchema, ...MCP_ERROR_ENVELOPE_SHAPE}`）不足以修好 Bug 2——
工具自身声明的成功字段（如 `sessions`/`total`）若不是 `.optional()`，JSON Schema 的 `required`
列表仍会包含它们，错误信封因为不带这些字段，依旧会被判"缺 required 属性"。真正落地的 `withMcpAudit`
改动因此多做一步：先把 `registration.outputSchema` 的每个字段都变成 `.optional()`
（新增的模块私有 `toOptionalOutputShape`），再拼接错误信封字段，让 `required` 整体清空。详见
`mcp-gateway.audit.ts`。

## AC

- [x] `grep -n "overview: {" -A3 server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 显示的
  `outputSchema` 不再是 `{ overview: z.unknown().optional() }` 字面量。
- [x] 新增/扩展 `server/modules/mcp-gateway/tests/mcp-overview.test.ts` 中的用例，用真实
  `buildOverview()` 的返回值（而非手写 fixture）驱动
  `z.object(TOOL_BODIES.overview.outputSchema).strict().safeParse(result).success === true`，
  且分别覆盖 `quay` 判别联合的 `no_quay_config`/`unknown`/`cached` 三个分支各一次；
  `node --import tsx --test server/modules/mcp-gateway/tests/mcp-overview.test.ts` 退出码 0。
  落地为新增的 leg (h)：不是手写 fixture schema，而是通过 `registerMcpReadTools` 的
  录制 seam 读回生产同一条 `outputSchema`，再喂真实 `buildOverview()` 的 20 项目全量输出
  （天然覆盖三支）。8/8 测通过。
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
  落地为 `mcp-error-envelope.test.ts` 新增 leg (e)（用已有的、`resolveDeps` 真实 wired 的
  mount，对 PROBE_TABLE 全部 21 个工具＋`sessions_list` PROJECT_NOT_FOUND/TARGET_AMBIGUOUS＋
  `overview` PROJECT_NOT_FOUND，全部换成"已 listTools() 热缓存"的客户端重放一次，没有一个
  再抛 `-32602`）和 `mcp-audit.test.ts` 新增 leg (f)（直接读 `tools/list` 的原始 JSON Schema，
  断言 `required` 清空、`properties` 同时含工具自身字段与四个信封字段）。三文件合计 21/21 测通过
  （`mcp-read-tools.test.ts` 本身未被修改，只是作为既有行为的回归证明一并跑绿）。
- [x] 既有覆盖 `details.candidates`/`details.fields` 等错误信封字段的测试保持通过（证明本次
  改动没有走方向 b'、没有从错误路径移除 structuredContent 的任何既有字段）。
  `mcp-error-envelope.test.ts` 原有 (a)(b)(c)(d) 四段、`mcp-not-found-semantics.test.ts`、
  `mcp-tool-annotations.test.ts`、`mcp-invalid-argument.test.ts`、`mcp-write-notification.test.ts`、
  `mcp-insufficient-scope.test.ts`、`mcp-english-only.test.ts`、`mcp-error-vocabulary.test.ts`
  全部复跑，全绿（额外的回归面排查，非 AC 原文要求但一并做了）。
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

**已验证（真实落地，非测试替代）**：没有直接扰动用户机器上正在跑的常驻 dev server（avoid
touching a process this session didn't start），而是用 `scripts/mcp-smoke.mjs` 已导出的
`bootServer`/`seedAccessToken`/`MCP_PATH` 助手，在一个独立临时目录+临时端口+真实
`server/index.ts` 子进程上，起了一个隔离但同代码路径的真实实例，播种一个真 PAT，用真实 SDK
client `listTools()` 热缓存后再 `callTool()`。探针脚本用完即删（临时写在
`scripts/__dod-probe-gap-mcp-outputschema-drift.mjs`，验证完已 `rm`，不留痕）。原始读数：

`overview {}`（无 project）→ 不抛，`structuredContent` =
`{"running":[],"awaitingPermission":[],"aborted":[],"hosts":[],"quay":[]}`（这是一个全新播种、
尚无项目/会话的隔离实例，所以五个数组都是空的——关键是校验通过、没有 schema 报错）。

`sessions_list({project:"definitely-not-a-real-project-xyz"})` → 不抛 `-32602`，`isError:true`，
`structuredContent` = `{"code":"PROJECT_NOT_FOUND","message":"No project has a title containing
\"definitely-not-a-real-project-xyz\".","retryable":false,"details":{"query":"...","kind":"project",
"candidates":[]}}`——真实的 AC-246 目标门业务错误码，不再被客户端的 outputSchema 校验吞掉。

## Touches

- server/modules/mcp-gateway/mcp-gateway.read-tools.ts（Bug1：TOOL_BODIES.overview.outputSchema 改成真实 OverviewPayload 形状）
- server/modules/mcp-gateway/mcp-error-envelope.ts（Bug2：新增 MCP_ERROR_ENVELOPE_SHAPE 导出）
- server/modules/mcp-gateway/mcp-gateway.audit.ts（Bug2：withMcpAudit 拼接 outputSchema 的唯一入口 + 新增 toOptionalOutputShape）
- server/modules/mcp-gateway/index.ts（新增导出 McpReadToolRegistration，供 mcp-overview.test.ts leg (h) 的录制 seam 使用）
- server/modules/mcp-gateway/tests/mcp-overview.test.ts（Bug1 单测：真实 buildOverview 输出过 schema，新增 leg (h)）
- server/modules/mcp-gateway/tests/mcp-audit.test.ts（Bug2 单测：withMcpAudit 拼接行为本身，新增 leg (f)）
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts（Bug2 单测：warm-cache 客户端重放全部探针，新增 leg (e)）
- tasks/gap-mcp-outputschema-drift-overview-and-error-envelope.md（本任务自身）

**未按原计划触碰**：`server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 最终未修改——
它没有 `resolveDeps` wiring，无法在不额外搭建目标门夹具的情况下构造
`PROJECT_NOT_FOUND`/`TARGET_AMBIGUOUS`；`mcp-error-envelope.test.ts` 本就有现成的、更贴近生产
的 `resolveDeps` 夹具，新增的 leg (e) 在那里做了，比在 `mcp-read-tools.test.ts` 里重新搭一套更
不重复。`mcp-read-tools.test.ts` 仍完整复跑验证无回归（见上面 AC4 的记录）。
