# MCP Gateway / Tool 架构提案 —— contract 叶子、领域工具包、registry 注入

状态：设计提案（2026-10-20），未实现；待评审/裁定
决策输入：人 yale 2026-10-20 的抽象架构讨论；F6 worktree 的实测；archguard 新 build 复测
关系：建立在 `docs/proposals/mcp-gateway-SPEC.md` 之上；只改内部包结构与依赖方向，**不改** MCP 协议、鉴权语义或工具行为。

---

## 0. 决策请求

请先裁定方向，而不是先选一个 AC 例外：

1. MCP 子系统采用「contract 叶子 + 领域工具包 + gateway 只做 host + composition root 装配」的四层结构；
2. read/write 从**包边界**降为**逐工具元数据**：read/write 由既有 `readOnlyHint` 表达、授权由既有 `requiredScopes`（`ACCESS_TOKEN_SCOPES` 的 token）表达，**不新造 scope 枚举**；
3. F6 当前分支不按原样落地，re-scope 为「抽 `mcp-contract` + gateway 接收 `ToolRegistry`」；
4. AC-394 本体不变、不抬基线；MCP 子树新增一条依赖方向判据（R1–R5），SCC 只作为后果。

---

## 1. 背景与实测

### 1.1 F6 想做什么

`gap-mcp-gateway-tool-registration-extract` 把工具实现从 `server/modules/mcp-gateway/` 搬到两个新包：

- `server/modules/mcp-tools-read/`（11 files / 6,981 LOC）
- `server/modules/mcp-tools-write/`（12 files / 3,845 LOC）

收益是真实的：`mcp-gateway` 从 41 files / 17,308 LOC 降到 20 / 6,966；fanOut 332 → 158。

### 1.2 但包图变坏了，而且比「加了两个新包」更严重

F6 worktree（`/data/home/yale/work/claudecodeui-worktrees/gap-mcp-gateway-tool-registration-extract`）实测（AC-394 扫描器逐成员输出）：

- 基线 G1（develop 上，F3 端口之后）是 **8** 成员：
  `projects, projects/services, providers, providers/list/claude, providers/services, voice, websocket, websocket/services`。
- F6 worktree **static-only SCC = 11** 成员：
  `mcp-gateway, mcp-tools-read, mcp-tools-write, projects, projects/services, providers, providers/list/claude, providers/services, session-hosts, websocket, websocket/services`
  —— 相对 G1：去掉 `voice`，**加回 `mcp-gateway`、`session-hosts` 和两个新包**。
- F6 worktree **static+dynamic SCC = 13** 成员：在 11 之上又加回 `voice`、`voice-realtime`。

也就是说 F6 不是「把两个新包加进环」，而是**把 F3 端口工作已经摘出 SCC 的 `mcp-gateway` 和 `session-hosts` 重新拉回了环**（净 +5 成员），部分撤销了 F3 的解耦成果。

环的成因不是扫描器噪声，而是真实的 intra-split 双向 import：

- `mcp-tools-read/**` / `mcp-tools-write/**` import `@/modules/mcp-gateway/index.js`，用于 `MCP_ERROR_CODES`、`McpToolError`、`McpToolInputSchema`、`McpPrincipal`、`McpApprovalDeps`、`registerMcpApprovalTools`；
- `mcp-gateway/index.ts` 又 re-export 这两个新包；
- `mcp-tools-read` 与 `mcp-tools-write` 之间也互 import（`mcp-gateway.resident-tools.ts`、`mcp-session-background.ts`）。
- 由此闭合 `mcp-tools-read → mcp-tools-write → mcp-gateway → mcp-tools-read`，并经 gateway 的既有 session-hosts/providers/websocket 边把整个旧 SCC 又拉回来。

### 1.3 拆分没有引入新的外部耦合

把新包的外部模块 import 与原 `mcp-gateway` 对比：

| 范围 | 外部 `@/modules/*` import |
|---|---|
| 原 `mcp-gateway` | `database`, `notifications`, `oauth`, `projects`, `providers`, `quay`, `session-hosts`, `shared`, `websocket` |
| `mcp-tools-read` | `mcp-gateway`, `mcp-tools-write`, `oauth`, `providers`, `quay`, `shared`, `websocket` |
| `mcp-tools-write` | `mcp-gateway`, `mcp-tools-read`, `oauth`, `providers`, `shared` |

新包相对原集合**多出来的只有 intra-split 边**（`mcp-gateway` / `mcp-tools-read` / `mcp-tools-write`）。也就是说，F6 不是「新增外部依赖」，而是「把一个已有 SCC 成员拆成三个互相引用的节点」。AC-394 当前规则把任何新增 SCC 成员都判红，无法区分「新增外部耦合」与「内部拆包」。

### 1.4 一个相邻但独立的环

server 当前还有一个真实的 `G3 = [".", "modules/browser-use"]` 环：`server/index.ts:87,91,140` import browser-use，而 `server/modules/browser-use/browser-use-mcp.ts:4` import `../../load-env.js`（server 根）。它已由 `gap-server-root-browser-use-cycle-relocate-mcp-entry` 单独处理，**不在本提案范围内**。

---

## 2. 问题陈述

### 2.1 read/write 是权限轴，不是领域轴

读工具和写工具共享同一批领域逻辑：session 控制、approval、project、UI、quay。按 read/write 切包，必然产生跨包的领域依赖（read 里的 resident-tools 需要 write 的 reconfigure/cancel；session-background 需要 write 的 `McpControlCaller` 类型）。**这个切法本身就会制造环**；不是实现没写好。

### 2.2 gateway 现在是 re-export hub

`mcp-gateway/index.ts` 同时承担 transport、auth、audit、dispatch、session-host-control、approvals、工具定义、工具转出口。工具搬出去之后，它仍然是「工具包的公共入口」，于是新包又回头 import 它。依赖方向没有变，只是文件位置变了。

### 2.3 SCC 预算只是代理指标

AC-394 的「SCC 只许缩小」是有价值的守卫，但它守住的是**结果**，不是**原因**。当前 F6 的冲突说明：只要依赖方向仍然是双向的，拆包就会让 SCC 变大；给基线加例外只是把症状按下去。正确的做法是先让依赖方向单向，SCC 自然会缩小。

---

## 3. 目标架构

### 3.1 四层

```
composition root (server/index.ts)
   ├── mcp-gateway          ← transport / auth / audit / dispatch / approval runtime
   ├── mcp-tools/<domain>   ← sessions / projects / ui / approvals / quay / search / run ...
   └── domain services      ← providers / session-hosts / projects / websocket ...
             ↓ 都只依赖
        mcp-contract       ← errors / types / input schemas / principal / domain port 接口 / ToolDefinition / ToolRegistry
```

### 3.2 依赖规则

| 规则 | 内容 |
|---|---|
| R1 | `mcp-contract` 是叶子：只 import `server/shared` 的基础类型与 node builtins，不 import 任何 `modules/**` |
| R2 | `mcp-tools/<domain>` 只 import `mcp-contract` + 既有 `server/shared/ports` + `server/shared/types`（都是 `server/shared/**`）；不 import `mcp-gateway`，不 import 兄弟工具包，也不 import 任何其它 `modules/**` |
| R3 | `mcp-gateway` 只 import `mcp-contract` + 接收注入的 `ToolRegistry`；不 import 任何具体工具包 |
| R4 | composition root 是唯一同时 import gateway、工具包、具体 domain services 的地方 |
| R5 | read/write 是逐工具元数据：`readOnlyHint` 表达读写、`requiredScopes` 表达授权（`ACCESS_TOKEN_SCOPES`）；不是包边界，也不新造 scope 枚举 |

**domain port 接口复用既有 `server/shared/ports/`**：F3 已经把 `session-host-control.port.ts`、`chat-run-registry.port.ts`、`connected-clients.port.ts`、`provider-registry.port.ts`、`voice-rules.port.ts` 放进 `server/shared/ports/`。**不新建 `mcp-contract/ports/`**——`mcp-contract` 只放 MCP 机制契约，domain ports 直接 import `server/shared/ports`（仍属 `shared/**`，工具包 import 它照样是叶子）。port **实现**留在领域模块，由 composition root 注入。R2 之所以要求工具包不 import 任何 `modules/**`，正是因为 AC-394 的叶子规则（见 §6.2）规定新 `server/modules/**` 目录出边只许指向 `server/shared/**` 与自身——若 port 类型放在领域模块里，工具包 import 它就不再是叶子，会重蹈 F6 覆辙。

**类型 import 计入依赖方向**：R1–R5 的判据把 `import type` 当作一条边（与 AC-394 扫描器的口径一致，它同样把 `import type` 计入静态边）。F6 的环一部分就是 `import type { McpToolInputSchema }` 这种类型边，不允许靠「类型边不算」来绕过。

### 3.3 Contract 的形状（草案）

```ts
// server/shared/mcp-contract/
export interface McpToolDefinition<Deps = unknown> {
  name: string;
  inputSchema: McpToolInputSchema;
  requiredScopes: string[];        // 沿用 ACCESS_TOKEN_SCOPES 的 token（'cloudcli:read' / 'cloudcli:session:control' …）
  annotations: McpToolAnnotations; // readOnlyHint / destructiveHint / idempotentHint / openWorldHint（沿用 MCP_TOOL_ANNOTATIONS 四标注）
  handler(ctx: McpToolContext, deps: Deps): Promise<McpToolResult>;
}

export interface McpToolModule<Deps = unknown> {
  domain: string;
  tools: McpToolDefinition<Deps>[];
}

export interface McpToolRegistry {
  get(name: string): McpToolDefinition | undefined;
  all(): McpToolDefinition[];
}
```

**读写与授权的表达不新造轴**：read/write 由 `annotations.readOnlyHint` 承担（`mcp-tool-annotations.ts` 已按工具声明，且明确是「DECLARATIVE METADATA，不是 authorization」）；授权由 `requiredScopes` 承担（现有 `ACCESS_TOKEN_SCOPES` 的真实 token）。`McpToolDefinition` 不引入 `McpToolScope` 之类的枚举——它是第三套与既有机制重复且冲突的轴。

Domain port 接口**复用既有 `server/shared/ports/`**（F3 已就位，见 §3.2），实现由领域模块提供、composition root 注入：

```ts
// server/shared/ports/session-host-control.port.ts（F3 已存在，本提案不改它的家）
export interface SessionHostControlPort {
  start(selection: SessionLaunchSelection): Promise<HostControlOutcome>;
  close(sessionId: string, opts: CloseOptions): Promise<HostControlOutcome>;
}
// 若 readSessionTurn / approvals 需要 port，优先挂进既有的 provider-registry.port / 新 port 也放 shared/ports，不放 mcp-contract/ports。
```

工具包只 import 这些 port **类型**；具体实现从 composition root 传入，工具包不 import 领域模块。

**阶段 2 拆出的工具包要成为叶子，阶段 1 就必须先把这些符号收进 contract**。以下是 F6 分支实测的新包对领域模块的完整依赖清单（develop 上工具还在 `mcp-gateway` 里，拆包发生在阶段 2；这张表是阶段 2 工具包必须**不再出现**的 import 集合，阶段 1 负责把它们提前落进 contract/shared）：

| 来源模块 | 符号 | 形态 | 处置 |
|---|---|---|---|
| `oauth` | `ACCESS_TOKEN_SCOPES`（×3） | 值（常量） | 常量移到 contract（或经注入传入） |
| `providers` | `readSessionTurn`（register-write-tools.ts:45） | 值（函数） | 收进 `SessionTurnPort`，实现留在 providers、组合根注入 |
| `providers` | `ControlStopTaskOutcome`、`providerCapabilitiesService`、`providerModelsService` | 类型 | 类型移到 contract / port 类型 |
| `websocket` | `UiStateRequestOptions`、`ActivityProtocolSnapshot`、`ChatRunLookupResult` | 类型 | 类型移到 contract |
| `quay` | `QuaySnapshot` | 类型 | 类型移到 contract |

此外，`mcp-tools-read` ↔ `mcp-tools-write` 之间的 5+5 处互 import（`McpControlCaller`、`McpControlSeam`、`McpRunReader`、`McpSessionReconfigureDeps`、`registerMcpSessionCancelQueuedTool`、`registerMcpSessionReconfigureTool` 等）也必须拆掉：共享类型/注册器放到 `mcp-contract` 或独立的 `mcp-tool-kit` 叶子（§3.6 末尾同一条规则），而不是「read 包 import write 包」——否则两个工具包彼此成为对方叶子规则的入边，AC-394 照样红。

`mcp-gateway` 的 26+32 处 import（errors/types/schema/principal/approval deps/`registerMcpApprovalTools`）是另一大块，同样收进 contract——这既是 F6 环的成因，也是阶段 1 的主要工作量。**阶段 1 只要求这些符号已进 contract、原消费者改 import 路径；「工具包里不再出现这些符号」是阶段 2 拆包后的退出证据**（develop 上阶段 1 还没有工具包），阶段 2 必须逐项贴「该符号已不在工具包里出现」。

### 3.4 Gateway 的形状（草案）

```ts
// server/modules/mcp-gateway/
export function createMcpGateway(opts: {
  registry: McpToolRegistry;
  auth: McpAuth;
  audit: McpAudit;
  transport: McpTransport;
}): McpGateway;
```

Gateway 不再知道任何具体工具；它只做协议、鉴权、审计、分发、审批运行时。

### 3.5 Composition root

```ts
const registry = new ToolRegistry([
  sessionTools({ sessionHosts, approvals }),
  projectTools({ projects }),
  uiTools({ ui, tasks }),
  quayTools({ quay }),
  searchTools({ search }),
]);

const gateway = createMcpGateway({ registry, auth, audit, transport });
```

### 3.6 领域切分（建议，待讨论）

| 工具包 | 主要工具 |
|---|---|
| `mcp-tools/sessions` | `session_start/close/send/interrupt/cancel_queued/reconfigure/background`、`run_get` |
| `mcp-tools/projects` | `projects_list`、`session_get`、`session_search` 的 project 侧读 |
| `mcp-tools/ui` | `ui_open_task`、`ui_show_diff`、`ui_visible_context`、`ui_clients_list`、`ui_open_session` |
| `mcp-tools/approvals` | `approvals_list`、`approval_answer` |
| `mcp-tools/quay` | `quay_overview`、`quay_snapshot` |
| `mcp-tools/search` | `session_search` |
| `mcp-tools/run` | `run_get`（如果不想放 sessions） |

跨工具共用的小工具（resident tools、错误包装、correlation id）放 `mcp-contract` 或一个独立的 `mcp-tool-kit` 叶子；不要靠「read 包 import write 包」解决。

### 3.7 session-host-control / approvals 的归属

`mcp-gateway` 目前同时持有 `mcp-session-host-control.ts` 和 `mcp-approvals.ts`。按职责，它们更像 **session-hosts 领域**（或一个 `mcp-control` 领域）的 adapter，而不是 MCP transport 的一部分。建议：

- 把 session/approval 的**领域逻辑**放进 `session-hosts`（或 `mcp-control`），以 port 形式暴露；
- `mcp-tools/sessions` / `mcp-tools/approvals` 只做 MCP 参数 schema 与结果格式化；
- gateway 只保留 transport/auth/audit/dispatch。

这是开放问题（见 §7），需要和 `session-hosts` 现有边界一起评审。

---

## 4. F6 的处理

当前 F6 分支是一个**部分移动**：工具实现确实搬出去了，但 gateway 仍然是 re-export hub，工具包仍 import gateway。**不建议按原样落地**，也不建议为了它抬 AC-394 基线。

建议：

1. 保留 F6 分支的代码作为素材（fanOut/LOC 收益是真的）；
2. 把 F6 re-scope 为「阶段 1 + 阶段 2」：抽 `mcp-contract`，gateway 改接收 `ToolRegistry`；
3. `mcp-tools-read` / `mcp-tools-write` 的包名与 read/write 边界不进入最终形态；领域重组另开任务（阶段 3–4，可选）；
4. AC-394 在当前阶段不新增例外；F6 的 SCC 读数在阶段 2 完成后应自然下降（develop 上 `mcp-gateway` 本就不在 G1，阶段 2 让工具包成为叶子、网关继续只做 host）。

**F6 任务记录与 worktree 的处置（需在评审时一并裁定）**：

- 任务 `gap-mcp-gateway-tool-registration-extract` 现为 `needs-human`。裁定本提案后，把它 **retreat**，理由写「被本提案阶段 1+2 取代；原分支的 read/write 切法撤销，fanOut/LOC 收益并入阶段 1+2 交付」，而不是继续让它停在 needs-human 等 worker 重试（它的结构 AC 与 AC-394 定义上冲突，重试不会变绿）。
- 若希望保留「god package 已拆」这一成果，可在 retreat 的 reason 里注明 F6 的包体读数（41/17,308 → 20/6,966 等）作为阶段 1+2 的目标值。
- worktree `/data/home/yale/work/claudecodeui-worktrees/gap-mcp-gateway-tool-registration-extract` 在 retreat 后**不要手删**（清理按 worktree 生命周期规则走）；其代码只作为阶段 1+2 的参考实现，不直接合入 develop。

---

## 5. 迁移阶段

**范围划分：阶段 1+2 是本提案的承诺范围；阶段 3+4 是可选后续，在阶段 2 完成后重新决策，不预先承诺。** §1.3 的「无新增外部耦合」说明 F6 的问题只在 intra-split 双向 import；develop 上 `mcp-gateway` 已被 F3 摘出 G1（G1=8 不含它），阶段 2 让新工具包成为叶子、网关只做 host 之后，SCC 不增大、AC-394 保持绿；领域重组（阶段 3）是优化，不是修复，可以等阶段 2 的读数验证后再决定要不要做。

| 阶段 | 内容 | 退出证据 |
|---|---|---|
| 0 | 评审/接受本提案 | 人裁定本文件方向 |
| 1 | 抽 `server/shared/mcp-contract`（纯 MCP 契约：errors / types / input schemas / principal / approval deps / `ToolDefinition` / `ToolRegistry`）；把 §3.3 符号表里的 `ACCESS_TOKEN_SCOPES`、`readSessionTurn` port、websocket/quay/provider 类型别名提前收进 contract / `shared/ports` / `shared/types`；domain ports 复用既有 `shared/ports` | `typecheck` / `lint` 绿；mcp-gateway + oauth + providers 的 scoped 测试绿；AC-394 绿（contract 是 leaf、SCC 不变）；`server/shared/mcp-contract` 注册进 `directoryManifest` + `MANIFEST_PIN` + `nodeCount` 上移（见 §6.2） |
| 2 | 把工具实现从 `mcp-gateway` 拆到 `server/modules/mcp-tools/`（先单个叶子，领域切分留 stage 3）；工具包只 import `mcp-contract` + `shared/ports` + `shared/types`；`mcp-gateway` 接收 `ToolRegistry`、删除对工具实现的 re-export；composition root 装配 | **R1–R5 依赖方向判据（§6.1 的新测试文件）落地并绿**：`mcp-gateway/**` ↛ `mcp-tools/**`，`mcp-tools/**` ↛ `mcp-gateway/**`，工具包之间无 import；工具包是真叶子（§3.3 符号表逐项「已不在工具包出现」）；AC-394 的 server SCC 不增大（贴前后读数）；typecheck/lint + mcp-gateway 工具契约测试绿；`server/modules/mcp-tools` 注册 manifest + MANIFEST_PIN + nodeCount |
| 3 | （可选）按领域重组工具包；read/write 由 `readOnlyHint` 表达 | 每个工具包只 import `mcp-contract`；`mcp-tools-read/write` 退役；`session-hosts`/`providers` 的 F3 端口解耦**不被撤销**（见 §7 开放问题 1） |
| 4 | （可选）本子树的环组真正缩小时，AC-394 按 shrink 方向降组 | AC-394 基线只降不升；既有全量套件绿 |

每个阶段都应保持 MCP 协议、鉴权、工具名、输入/输出 schema 不变。

---

## 6. 判据演进

### 6.1 新增 MCP 子树依赖方向判据（阶段 2 强制退出证据）

用 TypeScript AST 扫描（与 AC-394 的扫描器同源）：

- R1：`server/shared/mcp-contract/**` 对 `server/modules/**` 的 import 为 0；
- R2：`server/modules/mcp-tools/**` 对 `server/modules/mcp-gateway/**` 的 import 为 0；工具包之间无 import；
- R3：`server/modules/mcp-gateway/**` 对 `server/modules/mcp-tools/**` 的 import 为 0；
- R4：只有 `server/index.ts` 可以同时 import gateway 与 tools；
- R5：read/write 由 `readOnlyHint`、授权由 `requiredScopes` 表达；grep 不出现按 read/write 分包的 import，也不出现新造的 scope 枚举。

### 6.2 AC-394 的角色与落地机制

- **§6.1 的 R1–R5 是一个新增测试文件**（照 `server/shared/tests/composition-root-wiring.test.ts` / `server-import-cycle-budget.test.ts` 的先例），**不是对 AC-394 扫描器的修改**。AC-394 没有「子树」概念，它继续扫整个 `server/`。
- AC-394 本体只在某个环组**真实退役**时按 shrink 方向降为 `[]`（保留槽位，见 `ac394-retired-cycle-group-lowered-to-empty`）；**永不**为容纳拆分而抬基线、加成员、放宽叶子规则。
- **新目录的落地手续**（`ac394-new-leaf-dir-needs-manifest-plus-pin`）：
  - `server/shared/mcp-contract`（阶段 1）与 `server/modules/mcp-tools`（阶段 2，以及阶段 3 若再按领域拆出的每个子包）都是新目录，必须同时注册进 `directoryManifest` 与 `MANIFEST_PIN` 常量，并把 `nodeCount` 上移（测试断言 `nodeCount === directoryManifest.length`）。
  - `server/modules/**` 新目录必须满足叶子规则：出边只许 `server/shared/**` 与自身；入边只许目录 `.`（`server/index.ts`）。这正是 R2（工具包不 import 任何 `modules/**`）与 R3（gateway 不 import 工具包）要同时保证的——两条缺一，叶子规则的出边/入边半臂就会红。
- 阶段 1 只把 `mcp-gateway` 的 contract 依赖换成 `mcp-contract`、却不搬空 §3.3 符号表（含 read↔write 互 import），阶段 2 的工具包就仍不是叶子（还 import gateway/oauth/providers/websocket/quay 或彼此）——所以阶段 2 的退出证据必须同时贴 AC-394 的 SCC 读数与叶子规则读数，不能只贴 §6.1 的依赖方向读数。

---

## 7. 非目标与开放问题

**非目标**

- 不在本提案里解决 `server/` 更大的 8 成员 SCC（projects / providers / websocket / voice）；同样的 port + composition-root 方法适用，但那是另一个工作面。
- 不改 MCP 协议、OAuth、scope 语义、工具名或工具行为。
- 不引入动态插件式工具注册；仍用静态 registry。

**开放问题**

1. `mcp-session-host-control` / `mcp-approvals` 是留在 gateway，还是迁到 `session-hosts` / 新的 `mcp-control`？需要和 `session-hosts` 现有边界一起评审。
2. 跨工具共用代码（resident tools、correlation id、错误包装）放 `mcp-contract` 还是独立 `mcp-tool-kit` 叶子？
3. 领域切分是否按 §3.6 的七个包？`run_get` 放 sessions 还是独立 run 包？
4. registry 是否需要在启动时做重复名/scope 校验？建议做，失败即启动失败，不静默覆盖。

（原「类型-only import 是否计入」已移到 §3.2，作为决定处理：计入，与 AC-394 口径一致。）

---

## 8. 证据附录

- F6 worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-mcp-gateway-tool-registration-extract`
- AC-394 在 worktree 的读数：静态 `[11,2,2]`，静态+动态 `[13,2,2]`；G1 基线 8（`projects, projects/services, providers, providers/list/claude, providers/services, voice, websocket, websocket/services`）。F6 worktree 的 static SCC = G1 去掉 `voice`、加回 `mcp-gateway` / `session-hosts` / `mcp-tools-read` / `mcp-tools-write`（11）；dynamic 再加 `voice` / `voice-realtime`（13）——`mcp-gateway` 与 `session-hosts` 被重新拉回 SCC，部分撤销了 F3 的端口解耦。
- 新包 import gateway 的符号：`MCP_ERROR_CODES`、`McpToolError`、`McpToolInputSchema`、`McpPrincipal`、`McpApprovalDeps`、`registerMcpApprovalTools`。
- 外部模块 import 子集：见 §1.3；唯一超出原 `mcp-gateway` 外部集合的是 intra-split 边。
- F6 包体读数：`mcp-gateway` 41 files / 17,308 LOC → 20 / 6,966；`mcp-tools-read` 11 / 6,981；`mcp-tools-write` 12 / 3,845；fanOut 332 → 158。
- AC-394 基线：`server/shared/tests/server-import-cycle-budget.baseline.json`；G1 8、G2 `[]`、G3 `[".", "modules/browser-use"]`；note 明确写 “Never raise”。
- archguard 新 build 复测（2026-10-20）：`get_dependencies(edge-list)` 从 494k–550k chars 降到 3,181 chars；`get_package_metrics.cycleCount` 与 package SCC 同源；package cycle 带 `{from,to,specifier,file,line}` 边证据；`scopeInfo.staleness` 带 HEAD。memo/forwardRef 的 default-export 形态仍缺 22 个，已由 `gap-ts-parser-export-default-hoc-entities` follow-up。
