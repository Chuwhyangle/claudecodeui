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

**落地轮补记（2026-10-16，exited-not-landed 续做轮）**，三处随实现必需的落点，已写进 `## Touches`：

- `server/modules/voice-realtime/voice-realtime-tools.ts` —— 该模块**镜像** run_get 的声明，AC-2 不变量逐字段比对（回归，见 `## Evidence` 末节）；
- `server/modules/scheduled-messages/index.ts` 与 `server/modules/websocket/tests/processing-single-writer.test.ts` —— 修 develop 上**已经红着的** lint 门（`boundaries/dependencies`），它红掉每一次 fan-in 的 lint 阶段；修复形是仓库自己的规矩（跨模块读数经 barrel）。

## Touches

- `server/modules/mcp-gateway/mcp-run-get.ts` （`McpRunGetInput` / `readRunGetInput`(:222) 增 `deliveryId` 与互斥校验；`McpRunGetDeps`(:138) 增 delivery 读数缝；`McpRunGetOutcome`(:80) 增 `'cancelled'`；`buildRunGet`(:340) / `buildHit`(:241) 的等待与收尾消息分支；`McpRunGetMiss.details`(:314) 增 `idKind`）
- `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` （run_get body 表 `inputSchema`(:1499) 增 `deliveryId`，**仍是 raw shape**——理由见 `## Evidence` 末节：它是 voice-realtime 镜像的六个工具之一；互斥规则声明在 handler；`description`(:151) 更新）
- `server/index.ts` （`mcpRunGetDeps`(:252) 接上 delivery 读数源）
- `server/shared/types.ts` （delivery 读数缝返回类型 / `idKind` 联合类型，按 `$backend-module-standards` 分组注释；若实现选址在账本模块则改列该模块）
- `server/modules/providers/index.ts` （deliveryId → delivery 记录的解析读数经 barrel 导出——**仅当**生产侧读数源落在 providers 模块；若落在别处则改列该模块 barrel）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （**实现上必需、立案时未列**：by-id 读数源落在账本模块本身——`lookupResidentDeliveryById` + 它的逐会话 live 读数表 `sessionDeliveryLookups`（`publishDeliveries` 里安装，与 `sessionDeliveryReadings` 同一次调用、但**不**走保留窗/上限过滤，等待中的 delivery 一终态即可读到），以及 delivery 记账本其 turn 绑定时属于哪个 run（`ResidentLedgerDelivery.runId`，在 `bindTurnRun` 里与 `turnWriter` 一起写））
- `server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts` （新：AC-386 判据文件——真实 registry + 真实 activity store + scripted fake 进程，(a)–(h) 各腿）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `server/modules/voice-realtime/voice-realtime-tools.ts` （**落地轮补列**：`run_get` 的 `deliveryId` 字段与 `description` 同步到镜像——AC-2 不变量逐字段比对镜像与网关声明，网关加了字段镜像不加会红在那条不变量上；`RealtimeToolDescriptor.inputSchema` 是 `z.ZodRawShape`，这也是网关侧必须保持 raw shape 的原因）
- `server/modules/scheduled-messages/index.ts` （**落地轮补列**：barrel 增 `dispatchQueuedMessages` 的再导出，紧邻为同一原因存在的 `dispatchDueScheduledMessages`）
- `server/modules/websocket/tests/processing-single-writer.test.ts` （**落地轮补列**：那一处跨模块读数由深路径改走 `@/modules/scheduled-messages/index.js`——`.oxlintrc.json` 的 `boundaries/dependencies` 要求如此；该深路径由 AC-384 的落地提交 `62b23af5b` 引入，使 develop 的 `npm run lint` 退出 1，从而红掉**每一个**任务的 fan-in lint 阶段）
- `tasks/gap-ac386-run-get-dual-id-delivery-wait.md` （自触）

## Evidence

完成记录（2026-10-16，worker 在 worktree `/data/scratch/yale/wt-ac386`（分支 `task/gap-ac386-run-get-dual-id-delivery-wait`）上执行；实现提交 `c541b1282`，develop 合并提交 `5c73c4343`）。

### 交付判据读数（命令行 `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts`，退出 **0**，`duration_ms` 3219，判据体 456ms）

`run-get-delivery (flags) residentRunIsTurn=true cap=25s`
`run-get-delivery (a) ... byRun.idKind="run" byDelivery.idKind="delivery" byDelivery.runId=<runA> runIdMissesDeliverySpace=true deliveryIdMissesRunSpace=true idKindRun=true idKindDelivery=true spacesDisjoint=true bothRejected=true bothErrorKind=INVALID_ARGUMENT`
`run-get-delivery (b1) sleptMs=3000 budgetMs=25000 outcome="settled" status="completed" phase="tool" toolName="Bash" finalMessage="最后一条助手消息：这条 delivery 已经结束。" deliveryWaitReturns=true finalMessagePresent=true phaseFromSnapshot=true pendingToolFromSnapshot=true`
`run-get-delivery (b2) turnIds=["turn-4","turn-4","turn-4"] oneTurn=true statuses=["completed","cancelled"] messages=[<同一条>,<同一条>] foldedOwnTerminal=true foldedShareFinalMessage=true`
`run-get-delivery (b3) outcome="cancelled" reason="cli" status="cancelled" sleptMs=0 cancelledOutcome=true`
`run-get-delivery (c) missRunCode="RUN_NOT_FOUND" missRunIdKind="run" missDeliveryCode="RUN_NOT_FOUND" missDeliveryIdKind="delivery" isError=true`
`run-get-delivery (d) requested=60s waitedSleptMs=25000 capMs=25000 outcome="timeout" status="running" sleepCalls=100 wallElapsedMs=0 withinCap=true sleptPositive=true wallNeverReachedBudget=true`

### (e) 假形态（逐字）

临时改动（`buildRunGet` 删掉 delivery 分支，`const runId = input.runId ?? input.deliveryId`——即把 `deliveryId` 当 `runId` 送进 `runs.getRunById`）后重跑同一命令行：

`✖ AC-386 run_get resolves a runId or a deliveryId, waits the delivery terminal, and names the space it missed in (360.645854ms)`
`  Error [McpToolError]: This runId was never issued.`
`      at buildMiss (.../mcp-run-get.ts:491:9)`
`      at buildRunGet (.../mcp-run-get.ts:524:12)`
`      at handleRunGet (.../mcp-run-get.ts:685:10)`
`      at TestContext.<anonymous> (.../mcp-run-get-delivery.test.ts:549:33)`
`    code: 'RUN_NOT_FOUND', retryable: false, details: { idKind: 'delivery', ... }`
`ℹ tests 1 / ℹ pass 0 / ℹ fail 1` ⇒ **退出 1**

红落在 (a) 腿的 `run_get { deliveryId }` 那一行（判据文件 `:549`）——(a) 的 `{runId}` 读取已先通过，而 (b)/(c)/(d) 一行读数都没打印 ⇒ 红恰在「idKind / 解析无歧义」读数上，不是别的腿先红。用后还原，重跑退出 0（上节读数），`git diff` 不含该临时代码。

### 其余 AC 读数

- (f) 单次运行墙钟 `duration_ms` ≈ 3.2s（< 45s）；每条读数先打印后断言；预算守卫 `setTimeout(..., ELAPSED_LIMIT_MS-1000)` + `process.exit(3)`。
- (g) 复量 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` = **356**（立案 348，已落地者上移）；`quay-test-script.test.ts` 两条 pin 改为 `known=3 unknown=353` / `known=1 unknown=355`（注释算术改写为 `356-3` / `356-1`）；单文件复跑 **14/14 通过**，其中 AC7 覆盖率地板未破 ⇒ `scripts/suite-duration-baseline.tsv` **未动**。
- (h) 五个既有影响面判据各退出 **0**：`mcp-run-get.test.ts` 7/7、`mcp-session-send.test.ts` 8/8、`mcp-correlation-id.test.ts` 8/8、`mcp-cancel-queued.test.ts` 6/6、`mcp-session-lifecycle.test.ts` 15/15；**未改动其中任何文件**——`mcp-session-send.ts:526` 的 `build` 缝签名未变（`{ runId: string; waitSeconds?: number }` 仍可赋给放宽后的 `McpRunGetInput`），因此无一条需要列进本记录。
- (i) `npx tsc --noEmit` 三个 project（server / 根 / scripts）均退出 0；跨模块只经 barrel（providers / websocket / session-hosts / database 走 `index.ts`，mcp-gateway 内部同模块路径）；无 `any`。**仓库级 lint**（`npm run lint`，即 fan-in 的 lint 阶段）：续做轮开始时退出 **1**（1 个 error，见末节），修复后退出 **0**、error 计数 **0**。
- anti-drift（`anti-drift-touches-check.js --task ... --worktree /data/scratch/yale/wt-ac386 --merge-target develop`）：首轮（8 文件）读数 `ANTI-DRIFT OK: task gap-ac386-run-get-dual-id-delivery-wait — 8 actual file(s), all within declared Touches (10 glob(s))`，退出 0；续做轮补列 3 处、合并 develop 后重跑：`ANTI-DRIFT OK: task gap-ac386-run-get-dual-id-delivery-wait — 11 actual file(s), all within declared Touches (13 glob(s))`，退出 0。

### 与立案正文的两处实现选择（供复核）

- `deliveries` 读数缝在 `McpRunGetDeps` 上做成**可选**（`deliveries?`），与 `McpReadToolDeps.sessions.readSessionById` 同一兼容方向：AC-385 的判据文件（`runGetDepsFor`）与另外四个既有判据都直接构造 `McpRunGetDeps` 字面量，做成必填会强迫改判据文件（越出本任务 Touches）。缺缝时按 delivery 空间答 `RUN_NOT_FOUND`。
- 判据经导出的 `handleRunGet(args, deps)`（parse + read 的整条生产路径）驱动，因此「同时给出两个 id ⇒ 参数错误」是在 handler 的 `readRunGetInput` 上读到的。**注册面不是 built schema**：首轮曾照 AC-288 的先例把 run_get 的 `inputSchema` 换成携带 xor 的 built schema（`runGetInputSchema`），续做轮发现它红掉了 voice-realtime 的镜像不变量（末节），已改回 raw shape；互斥规则只由 handler 声明。首轮的读数与结论（下节）除此之外不变。

### 续做轮（2026-10-16，exited-not-landed 后）：三条 suite 红的成因与处理

上轮 suite 红 3 条，机械 delta 判定把 3 条都判为 UNRELATED。逐条复跑后**两条成因不同、一条是本 delta 的真回归**，第三条确是环境竞态。

**(1) 真回归（本 delta 造成）：voice-realtime 的镜像不变量。**
`server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 的 AC-2 逐字段比对六个工具（含 `run_get`）的网关声明与 `server/modules/voice-realtime/voice-realtime-tools.ts` 的镜像，`inputSchema` 按 `z.ZodRawShape` 读——`zodSignature` 逐个字段取 `.def.type`。首轮把网关 run_get 的 `inputSchema` 换成 built schema 后，读到的对象是整个 schema 实例，walker 落进实例属性、在 `undefined.def` 上抛：

```
✖ AC2: each mirrored schema equals the MCP gateway declaration, field for field (4.544994ms)
  TypeError: Cannot read properties of undefined (reading 'type')
      at zodSignature (.../voice-realtime-tools.ts:560:20)
      at diffToolSchemas (...:625:19)
      at diffToolDescriptors (...:668:8)
ℹ pass 15 ℹ fail 1     （退出 1）
```

驱动自己的 baseline 工作树（`/data/home/yale/.baseline-red-gap-ac386-run-get-dual-id-delivery-wait-wk-prod-anchor`）跑同一文件得 `passed=true` ⇒ 确认是本 delta 的红，不是基线。

修法：网关 run_get 的 `inputSchema` 回到 **raw shape**（增 `deliveryId`），互斥规则仍由 handler `readRunGetInput` 声明（判据读的正是那一层），镜像同步 `deliveryId` 与 `description`。
复跑：`voice-realtime-bridge.test.ts` **16/16** 退出 0；同一不变量族的取假形态判据 `voice-realtime-bridge.false-forms.test.ts` **4/4**。

**(2) develop 上已经红着的 lint 门（非本 delta 造成，但拦住每一次落地）。**
`npm run lint` 就是 fan-in 的 lint 阶段（`run_stage_bg lint npm run lint`，rc≠0 即记红）。它在 **develop 自己那棵树上**退出 **1**：

```
server/modules/websocket/tests/processing-single-writer.test.ts:74:40: error boundaries(dependencies): Cross-module imports must go through that module's barrel file
```

`git log -S` 定位：那处深路径 `@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js` 由 **AC-384 的落地提交 `62b23af5b`（2026-10-16T12:47:45Z）** 引入（同一落地的 `91cf81707` 两分钟后才把另外几处深路径改成 barrel），此后 develop 的 lint 恒红 ⇒ **任何**任务的 fan-in 都会红在 lint 阶段。本 delta 与那一行无关：该文件在本分支与 develop 逐字节相同。

修法照仓库自己的规矩（`.oxlintrc.json` 的 `boundaries/dependencies`：跨模块读数必须经 `server/modules/<m>/index.ts`）：`dispatchQueuedMessages` 由 `server/modules/scheduled-messages/index.ts` 再导出（紧邻为同一原因存在的 `dispatchDueScheduledMessages`），该判据文件改从 barrel 读。
复跑：`npm run lint` 退出 **0**、error 计数 **0**；被改的那条判据 `processing-single-writer.test.ts` **2/2**（AC-384 自己的读数未变）；`npm run typecheck` 退出 0。

**(3) 第三条：环境竞态，未改任何文件。**
`src/shared/tests/voiceErrorClassification.test.ts` 的 AC-1「无残留」在整树 walk 的两次读数之间，撞上同一次并行 run 里 `src/shared/tests/voiceEditLabels.test.ts` 写的临时件 `src/shared/tests/__criterion-falsify-cjk-<n>.ts:34495`（`:34495` 是那个文件的字节数，不是行号）。该判据按 `path:size` 记残留，只跳过 `.git`/构建目录/quay 运行态那一类；`src/shared/tests/` 是它**有意保留的齿**（正控制就是那里的一枚探针），所以同 run 的兄弟临时件会被数成残留。
证据：驱动自己的 rerun 与 baseline 两次单跑该文件都是 `exit=0`；本机把这两个文件配对跑（含强制 2 fork）10 次、整个 `src/shared/tests/` 目录跑 2 次，全绿；窗口是 `withVariant` 的 写→动态 import→`finally` 删除 之间那几毫秒，满载时被 Vite 变换拉长才撞得上。另一条已 done 的任务（`gap-oauth-consent-flow-ux-hardening`）在 2026-10-08 撞到同一竞态，同样判为环境竞态、未改文件。⇒ 两条判据都不改。

**续做轮复跑读数（全部在 `/data/scratch/yale/wt-ac386`，单文件、逐条串行）**：`mcp-run-get-delivery.test.ts` **1/1**、`mcp-run-get.test.ts` **7/7**、`mcp-session-send.test.ts` **8/8**、`mcp-correlation-id.test.ts` **8/8**、`mcp-cancel-queued.test.ts` **6/6**、`mcp-session-lifecycle.test.ts` **15/15**、`voice-realtime-bridge.test.ts` **16/16**、`voice-realtime-bridge.false-forms.test.ts` **4/4**、`processing-single-writer.test.ts` **2/2**；`npm run typecheck` 退出 0；`npm run lint` 退出 0（error 计数 0）。

**(e) 假形态在续做轮后的树上重跑（逐字）**：删掉 `buildRunGet` 的 delivery 分支并写 `const runId = input.runId ?? input.deliveryId`（即把 `deliveryId` 当 `runId` 送进 `runs.getRunById`），同一命令行：

```
FALSE_FORM_EXIT=1
✖ AC-386 run_get resolves a runId or a deliveryId, waits the delivery terminal, and names the space it missed in (372.442999ms)
  Error [McpToolError]: This runId was never issued.
      at buildMiss (.../mcp-run-get.ts:491:9)
      at buildRunGet (.../mcp-run-get.ts:524:12)
      at TestContext.<anonymous> (.../mcp-run-get-delivery.test.ts:549:33)
    details: { idKind: 'delivery', runId: null, deliveryId: '29baeb5d-...', reason: 'never_issued', ... }
ℹ pass 0  ℹ fail 1
```

红落在 (a) 腿的 `run_get { deliveryId }` 那一行（判据 `:549`），(b)/(c)/(d) 一行读数都没打印 ⇒ 红恰在 idKind / 解析无歧义的读数上，不是别的腿先红。`git checkout -- server/modules/mcp-gateway/mcp-run-get.ts` 还原后重跑退出 **0**、**1/1**，`git diff` 不含该临时代码。
