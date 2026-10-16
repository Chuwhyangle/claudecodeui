---
id: gap-ac386-run-get-dual-id-delivery-wait
title: AC-386 S3 API 翻转：run_get 同时认 runId 与 deliveryId（互斥，同时给出为参数错误；两个 uuid
  空间互不相交、解析无歧义）——waitSeconds>0 等的是 delivery 终态（completed|cancelled）并带回其 turn
  的最终助手消息与 phase、pendingTool；折叠的两条 delivery 各返回自己的终态、共享同一条最终消息；cancelled 的
  delivery 返回 outcome=cancelled 与 reason；未知 id ⇒ RUN_NOT_FOUND 信封、details 含
  idKind；上限仍为 MCP_RUN_GET_MAX_WAIT_SECONDS 且等待只经注入的
  now/sleep（假时钟下数字断言「早于满额预算返回」）；交付
  server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts（含取假形态：把
  deliveryId 当 runId 解析 ⇒ (a) 红）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac382-run-is-turn-resident-init-minted-run
  - gap-ac383-delivery-activity-snapshot-channel
  - gap-ac384-processing-single-writer
goal_ac: AC-386
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-386' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-386' tasks/` → 只命中 `tasks/gap-ac385-send-deliveryid-runid-compat-window.md`（其正文在「也与 S3 的另一条 AC-386…」一句里提到本条，非认领）⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-386。机制词 grep：`mcp-run-get-delivery` 只命中 `docs/proposals/resident-delivery-turn-ledger-SPEC.md`（§15 判据表那一行）与 gap-ac385 的任务文件；`deliveryId` 在 `server/modules/mcp-gateway/` 下 **0** 命中；`idKind` 全库 **0** 命中 ⇒ run_get 的双 id 面尚不存在。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches server/modules/mcp-gateway/mcp-run-get.ts --touches server/modules/mcp-gateway/mcp-gateway.read-tools.ts --touches server/index.ts --touches server/shared/types.ts --touches server/modules/providers/index.ts --touches server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts --json`）报 `peers: [gap-ac382-run-is-turn-resident-init-minted-run (todo, 共享 server/index.ts)、gap-ac383-delivery-activity-snapshot-channel (todo, 共享 server/shared/types.ts)、gap-ac385-send-deliveryid-runid-compat-window (todo, 共享 mcp-gateway.read-tools.ts / server/shared/types.ts)]`。判定 **separate**：那三条各有自己的判据文件与独立验收（S2 的 run=turn / delivery 状态通道 / 单一写者，S3 的 send 返回 deliveryId），本条是 SPEC §8.2 的 run_get 双 id，判据文件 `mcp-run-get-delivery.test.ts` 与它们全不同；调度器对 Touches 重叠的任务本就按 Touches 串行，合并省不下并行度却把两条 AC 的验收搅在一起。本条对 S2 出口三条的先后已在任务层以结构化 `depends_on` 声明（SPEC §12：后一阶段任务不得先于前一阶段出口 AC 落地），正文不复述这层关系。

### 机制（SPEC §4.1、§4.2、§5.2、§5.3、§8.2、§8.3、§15）

现状（即 S2 止步处）`run_get` 只认一个 id，且钉死是 runId：

- `McpRunGetInput = { runId: string; waitSeconds?: number; session?: string }`，`readRunGetInput`（`server/modules/mcp-gateway/mcp-run-get.ts:222`）对空 runId 直接抛 `"runId" is required and must be a non-empty string.`。
- `McpRunGetDeps`（`:138`）= `{ runs: { getRunById, getRunBootId }, activity: { snapshot }, sessions: { fetchHistory }, now, sleep, bootId }`——**没有**任何 delivery 读数缝。
- `McpRunGetOutcome = 'settled' | 'awaitingPermission' | 'timeout'`（`:80`）——**没有** `cancelled`。
- 等待路径 `buildRunGet`（`:340`）等的是 run 的终态（`completed | aborted`，`:365`）或 turn 停在 `awaitingPermission`（`:369`）；`buildHit`（`:241`）只在 `outcome === 'settled'` 时取会话最后一条助手消息（`fetchHistory`，取最后一条 `role === 'assistant'`）。
- miss 路径 `buildMiss`（`:298`）抛 `RUN_NOT_FOUND`，`details` = `{ runId, reason, bootId, fallback }`（`:314`）——**没有** `idKind`。
- 注册面 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 的 body 表把 run_get 的 inputSchema 钉成 raw shape `{ runId?, waitSeconds?, session?, run?, wait? }`（`:1499`）；`registerMcpRunGetTool` 经 `isRunGetWired` 路由到真 handler（`:1706`、`:1708`）。
- 生产接线 `server/index.ts:252` 的 `mcpRunGetDeps` 从 `chatRunRegistry` / `activityStore` / `sessionsService` 装配。

SPEC §8.2 的修法（本条要落的那半）：

- **入参** `{ runId } | { deliveryId } | { session }`（**互斥**）。两个 uuid 空间互不相交，解析无歧义——`runId` 由 run 注册表给出（S2 起 run=turn，`system/init` 时铸）；`deliveryId` = `commandUuid`（host 在 send 时铸、CLI 在 lifecycle 里原样回带；非 resident 为 send 时铸的 uuid，SPEC §4.1）。同时给出两个 id ⇒ **参数错误**（不是 RUN_NOT_FOUND 信封）。
- **等待语义**：`waitSeconds > 0` 等的是 **delivery 终态**（`completed | cancelled`，其唯一定义 `isTerminalDeliveryState` 在 `server/modules/providers/list/claude/claude-host-driver.provider.ts:1793`），**不是** run 终态；返回**其 turn 的最终助手消息**与 `phase` / `pendingTool`（phase/toolName 取自 activity 快照的既有读法，`buildHit`）。调用方真正关心的是「我这句话处理完没有」，而 C-3 让 delivery 终态与 turn 的 `RESULT` 是两个独立事件（SPEC §5.3）：一个 turn 可以开着一个已终态的 delivery（折叠命令），也可以终态未到时 `RESULT` 先来。
- **折叠**：`started u` 时若 `turn.open`，u 绑**当前** turn（SPEC §5.2，C-2）⇒ 一个 turn 可绑多条 delivery（折叠）。折叠的两条 delivery **各自返回自己的终态**，但**共享同一条最终消息**（同一个 turn 的收尾助手消息）——这是「N:1 Delivery→Turn」（SPEC §4.2）在多 id 读数上的投影。
- **cancelled**：终态为 `cancelled` 的 delivery 返回 `outcome: 'cancelled'` 与 `reason`（`withdrawn | interrupt | process-exit | owed-terminal-missing | cli`，`ClaudeResidentDeliveryReason`）。
- **未知 id** ⇒ `RUN_NOT_FOUND` 信封，`details` **增加 `idKind`**（`'run' | 'delivery'`）——让调用方看出它按哪个 id 空间没找到。
- **上限与时钟**：等待上限仍为 `MCP_RUN_GET_MAX_WAIT_SECONDS`（`mcp-run-get.ts:71`），且**只**经注入的 `now` / `sleep`——判据在假时钟上以数字断言「早于满额预算返回」，不靠真实等待。

### 交付（两件，同一任务）

1. **run_get 双 id 实现**：`mcp-run-get.ts` 的输入类型放宽为 `{ runId? } | { deliveryId? } | { session? }` 并**互斥校验**（同时给出 ⇒ 参数错误）；`McpRunGetDeps` 增一个 delivery 读数缝（判据可见的形：`deliveries: { lookupById(deliveryId): { deliveryId, sessionId, turnId, state, reason, runId | null } | null }`——生产侧从 resident 账本解析；具体源与命名由实现定，新类型按 `$backend-module-standards` 进 `server/shared/types.ts` 并分组注释）；`McpRunGetOutcome` 增 `'cancelled'`；等待分支改为：按 idKind 解析出 delivery 后等它终态（`completed` ⇒ 取该 turn 的收尾助手消息 + phase/pendingTool；`cancelled` ⇒ outcome `cancelled` + reason）；`McpRunGetMiss.details` 增 `idKind`。注册面 `mcp-gateway.read-tools.ts` 的 run_get inputSchema 增 `deliveryId`；因 raw shape 表达不了 xor，按 AC-288 的先例换成**携带约束的 built schema**（`McpRunGetRegistration.inputSchema` 已是 `McpToolInputSchema`，`mcp-run-get.ts:404` 的注释即为此形）。`server/index.ts` 的 `mcpRunGetDeps` 接上 delivery 读数源。全部置于 S2 的开关之后（关态对外行为逐字节不变）。
2. **判据文件**（新文件 `server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts`，AC-386 判据）：**真实** `chat-run-registry.service` + **真实** activity store + **注入的 scripted fake 进程**（照 AC-378 的 `server/modules/providers/tests/claude-resident-ledger-invariants.test.ts` / AC-383 的 scripted 臂：真实 resident 账本经帧流驱动，全程不建真实 `WebSocket`；**不要**搬真实 `claude` 二进制臂——那是 AC-379 哨兵的地界），run_get 的 deps 在这些真实件之上注入钉死的钟与 sleeper；以 `RESIDENT_RUN_IS_TURN`（AC-382 落地时定名）开运行。

### 假形态（(e) 为什么承重）

(e) 把 `deliveryId` 当 `runId` 解析（实现里忽略 idKind、把任何 id 都送进 `runs.getRunById`）⇒ **(a) 腿红**，且红落在 (a) 的「idKind / 解析无歧义」读数上、**不是别的腿先红**（超时、更早断言、别的读数）。这正是「两个 uuid 空间互不相交、解析无歧义」被破坏的缺陷签名。还原后 (a)–(h) 恢复绿，`git diff` 最终不含该临时代码。

### 与 S3 另一条（AC-385）的边界

`session_send` / `session_create` / `draft_submit` 返回 `deliveryId`、`runId` 可空 + 兼容窗口回填、`correlationId` 归 delivery 是 AC-385 的判据（`mcp-session-send-delivery.test.ts`）；本条只落 run_get 接受 `deliveryId`、等待其终态、`RUN_NOT_FOUND.details.idKind`（SPEC §8.2），判据文件 `mcp-run-get-delivery.test.ts` 与它全不同。两条共用的落点（`server/shared/types.ts`、`mcp-gateway.read-tools.ts`）是落点，不是同一机制。

## AC

- [x] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印**双 id 解析腿**：`run_get { runId }` 命中一条在飞 run ⇒ 经 run 空间解析（`idKindRun=true`）；`run_get { deliveryId }` 命中一条在飞 delivery ⇒ 经 delivery 空间解析（`idKindDelivery=true`）；两个 uuid 空间互不相交（同一调用不可能既当 run 又当 delivery 命中，`spacesDisjoint=true`）；**同时**给出 `runId` 与 `deliveryId` ⇒ **参数错误**（不是 RUN_NOT_FOUND 信封，`bothRejected=true bothErrorKind=parameter`）。打印读数后再断言。
- [x] (b) 同一次运行内 **等待 delivery 终态腿**：(b1) `run_get { deliveryId, waitSeconds: N }`，该 delivery 在假钟第 3 秒终态 ⇒ **那时**返回（不是满额预算后），携带其 turn 的最终助手消息与 `phase`、`pendingTool`（`deliveryWaitReturns=true finalMessagePresent=true phaseFromSnapshot=true pendingToolFromSnapshot=true`）。(b2) **折叠腿**：在同一 open turn 下驱动两条 delivery 各自 `started`（C-2 折叠）与各自终态 ⇒ 两条**各自**返回自己的终态（`foldedOwnTerminal=true`），但**共享同一条**最终助手消息（`foldedShareFinalMessage=true`，两条读到的消息逐字相等）。(b3) **cancelled 腿**：一条 `cancelled` 的 delivery ⇒ `outcome === 'cancelled'` 且带 `reason`（`cancelledOutcome=true cancelledReason=<withdrawn|interrupt|process-exit|owed-terminal-missing|cli>`）。
- [x] (c) 同一次运行内 **未知 id 腿**：对两个 id 空间各取一个从未发出的 id ⇒ 都是 `RUN_NOT_FOUND` 信封，且 `details.idKind` 分别为 `'run'` / `'delivery'`（`missRunIdKind=run missDeliveryIdKind=delivery`）；信封仍是 error（`isError=true`）。
- [x] (d) 同一次运行内 **上限与时钟腿**：`run_get { deliveryId, waitSeconds: 60 }`（> 上限）⇒ 最多等 `MCP_RUN_GET_MAX_WAIT_SECONDS` 秒（判据读实现导出的同一常量，**不重打 25**），且等待**只**经注入的 `now` / `sleep`：在假钟上以数字断言「早于满额预算返回」（`waitedSleptMs <= capSeconds*1000`、`sleepCalls > 0`、未触达 60 s 的墙钟）。
- [x] (e) **取假形态可复现**：把 `deliveryId` 当 `runId` 解析 ⇒ **(a) 腿红**，且红落在 (a) 的 idKind / 解析无歧义读数上、**不是别的腿先红**。逐字红态读数、退出码与命令行抄进完成记录；用后还原、重跑 (a)–(d) 恢复绿，`git diff` 最终不含该临时代码。
- [x] (f) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量；驱动对判据 spawn 另有 120 s 硬闸）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [x] (g) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 **348**，以执行时实测为准；AC-382 / AC-383 / AC-385 也会各加一个文件，故基线随已落地者上移），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（立案读数 AC2 的 `known=3 unknown=345`、AC3 的 `known=1 unknown=347`，即 `base+…`）各 +1，并改写其上方注释里的算术（立案读数注释为 `348 - 3 = 345` / `348 - 1 = 347`）；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (h) 既有影响面判据不被悄悄变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-run-get.test.ts`（AC-248 / AC-287 的单 id 读数必须原样保留）、`... mcp-session-send.test.ts`（其 `waitSeconds` 腿经 `deps.runGet.build({ runId, waitSeconds })` 调 run_get）、`... mcp-correlation-id.test.ts`、`... mcp-cancel-queued.test.ts`、`... mcp-session-lifecycle.test.ts` 各退出 **0**；若实现上必须改动其中任一文件（例如 run_get 的 `build` 缝签名变化牵动 `mcp-session-send.ts:526`），在完成记录里**逐条列出并说明**，不得悄悄让它们变红。
- [x] (i) 遵守 `$backend-module-standards`：判据落 `server/modules/mcp-gateway/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」、也不是「字段存在」）：在交付的树上跑 `server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts`——它经**真实 chat-run-registry.service + 真实 activity store + 注入的 scripted fake 进程**（真实 resident 账本经帧流驱动），以 `RESIDENT_RUN_IS_TURN` 开运行：

(a) `run_get` 接受 `runId` 或 `deliveryId`（互斥，同时给出为参数错误），两个 uuid 空间互不相交、解析无歧义；
(b) `waitSeconds > 0` 等的是 delivery 终态，返回其 turn 的最终助手消息与 `phase`、`pendingTool`；折叠的两条 delivery 各返回自己的终态、共享同一条最终消息；`cancelled` 的 delivery 返回 `outcome=cancelled` 与 `reason`；
(c) 未知 id ⇒ `RUN_NOT_FOUND` 信封，`details` 含 `idKind`；
(d) 等待上限仍为 `MCP_RUN_GET_MAX_WAIT_SECONDS`，等待只经注入的 `now` / `sleep`（假时钟下以数字断言「早于满额预算返回」）；
(e) 假形态（把 `deliveryId` 当 `runId` 解析 ⇒ (a) 红，红落在 idKind 读数上）可复现，还原后 (a)–(d) 恢复绿——即判据有洞会被看见。

`git diff` 须只含：run_get 双 id 实现（`server/modules/mcp-gateway/mcp-run-get.ts`、`server/modules/mcp-gateway/mcp-gateway.read-tools.ts`、`server/index.ts`、`server/shared/types.ts`，以及实际承载 delivery 读数源的那一处 provider / 模块导出与 `server/modules/providers/index.ts` barrel——若实现选址在别处则改列该处）、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/modules/mcp-gateway/mcp-run-get.ts` （`McpRunGetInput` / `readRunGetInput`(:222) 增 `deliveryId` 与互斥校验；`McpRunGetDeps`(:138) 增 delivery 读数缝；`McpRunGetOutcome`(:80) 增 `'cancelled'`；`buildRunGet`(:340) / `buildHit`(:241) 的等待与收尾消息分支；`McpRunGetMiss.details`(:314) 增 `idKind`）
- `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` （run_get body 表 `inputSchema`(:1499) 增 `deliveryId`、因 xor 换成携带约束的 built schema；`description`(:151) 更新）
- `server/index.ts` （`mcpRunGetDeps`(:252) 接上 delivery 读数源）
- `server/shared/types.ts` （delivery 读数缝返回类型 / `idKind` 联合类型，按 `$backend-module-standards` 分组注释；若实现选址在账本模块则改列该模块）
- `server/modules/providers/index.ts` （deliveryId → delivery 记录的解析读数经 barrel 导出——**仅当**生产侧读数源落在 providers 模块；若落在别处则改列该模块 barrel）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （**实现上必需、立案时未列**：by-id 读数源落在账本模块本身——`lookupResidentDeliveryById` + 它的逐会话 live 读数表 `sessionDeliveryLookups`（`publishDeliveries` 里安装，与 `sessionDeliveryReadings` 同一次调用、但**不**走保留窗/上限过滤，等待中的 delivery 一终态即可读到），以及 delivery 记账本其 turn 绑定时属于哪个 run（`ResidentLedgerDelivery.runId`，在 `bindTurnRun` 里与 `turnWriter` 一起写））
- `server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts` （新：AC-386 判据文件——真实 registry + 真实 activity store + scripted fake 进程，(a)–(h) 各腿）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac386-run-get-dual-id-delivery-wait.md` （自触）
