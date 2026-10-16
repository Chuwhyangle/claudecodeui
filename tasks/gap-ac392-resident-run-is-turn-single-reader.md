---
id: gap-ac392-resident-run-is-turn-single-reader
title: AC-392 开关单点：RESIDENT_RUN_IS_TURN 在非测试服务端代码里只有一处读取（位于
  server/shared/utils.ts，调用时读取），driver、registry、chat-websocket 三处 import
  都指向该谓词、registry 不再转出口；交付
  server/shared/tests/resident-run-is-turn-single-reader.test.ts（AST 扫描 + 负对照 +
  调用时读取 + 取假形态）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac386-run-get-dual-id-delivery-wait
goal_ac: AC-392
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-392' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-392' tasks/` → **0** 命中 ⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-392。机制词 grep：`residentRunIsTurn` 命中 `tasks/gap-ac383`、`gap-ac384`、`gap-ac385`（各在正文里提到该谓词——AC-385 把它经 websocket barrel 转出口给判据打印，AC-383/AC-384 在装配里打印它），三条均已 **done**；`RESIDENT_RUN_IS_TURN` 另命中 `gap-ac382`（done）与 `gap-ac386`（ready）。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches server/shared/utils.ts --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/websocket/services/chat-run-registry.service.ts --touches server/modules/websocket/services/chat-websocket.service.ts --touches server/modules/websocket/services/chat-control.service.ts --touches server/modules/websocket/index.ts --touches server/shared/tests/resident-run-is-turn-single-reader.test.ts --json`）报 `peers: [gap-ac390-resident-reconcile-observability (todo, 共享 claude-host-driver.provider.ts / chat-run-registry.service.ts)]`、`mentions: [gap-ac386 (ready), gap-ac388 (todo)]`。判定 **separate**：AC-390 是对账与可观测（S5：reconcile 的日志与关闭动作），AC-392 是开关单点（把两处同名读取收敛到一个求值叶子），机制与判据文件都不同；两者共享的两个文件由调度器按 Touches 串行，合并省不下并行度却把两条 AC 的验收搅在一起。本条对 AC-386 的先后已在任务层以结构化 `depends_on` 声明（见「时序」）。

### 机制（SPEC §4.4 I6、§12、§14；GOAL-045 里 S2「run 即 turn」的开关面）

现状：`RESIDENT_RUN_IS_TURN` 在**非测试服务端代码**里有两处读取，两处各自带一份同名谓词——这就是缺陷面（「一个开关两个拼写」迟早漂移）：

- `server/modules/providers/list/claude/claude-host-driver.provider.ts:758` 的局部 `function residentRunIsTurn()`，读取在 `:759`。
- `server/modules/websocket/services/chat-run-registry.service.ts:50` 的 `export function residentRunIsTurn()`，读取在 `:51`。

消费者四处：driver 用自己的局部副本（`:4423`、`:4553`、`:4866`、`:4950`、`:5042`）；`chat-run-registry.service.ts` 的 `:540`/`:1052`/`:1088` 用自己的；`chat-websocket.service.ts:28` 与 `chat-control.service.ts:9` 从 `chat-run-registry.service.js` 深引；`server/modules/websocket/index.ts:50` 把 registry 那份经 barrel 转出口（AC-385 的判据 `mcp-session-send-delivery.test.ts` 经它打印旗标）。

那份重复不是疏忽：providers 模块**不能** import websocket 模块，否则会闭合 `providerRegistry → claude.provider → websocket barrel → chat → providers barrel → provider-models.service.js` 这条环，而该模块体在注册表求值期间读 `providerRegistry`，触发 TDZ（`ReferenceError: Cannot access 'providerRegistry' before initialization`）——见 `claude.provider.ts:150–165` 的文档化注释（该注释正是 SPEC 里说的「providers 与 websocket 之间有文档化的 ESM 求值顺序约束」）。两处同名正是被这条求值顺序约束逼出来的。

修法（AC-392 要落的那半）：谓词是**求值叶子**，搬到 `server/shared/utils.ts`——它只 import `@/shared/frontmatter.js` 与 `@/shared/types.js`（`grep "from '@/" server/shared/utils.ts` 证实无 providers、无 websocket），因此 driver 与 websocket 两侧都能 import 它而不闭合任何环。搬到那里之后：

- 非测试服务端代码里 `process.env.RESIDENT_RUN_IS_TURN` **只剩一处读取**，在 `server/shared/utils.ts`，且**调用时读取**（不是模块加载时常量——判据在自己的函数体里设变量，模块级常量会在设之前求值，读数就落在关态）。
- `residentRunIsTurn` 由 `server/shared/utils.ts` 导出（按 `$backend-module-standards` 带消费者注释）。
- driver、registry、chat-websocket 三处的 import 声明都指向它；registry **不再**转出口。

### 交付（两件，同一任务）

1. **单点实现**：把 `residentRunIsTurn` 的定义搬到 `server/shared/utils.ts`（调用时读 `process.env.RESIDENT_RUN_IS_TURN === '1'`，带消费者注释）；删掉 `claude-host-driver.provider.ts:758` 与 `chat-run-registry.service.ts:50` 两份局部副本，两处（以及 `chat-websocket.service.ts:28`、`chat-control.service.ts:9`）改为从 `@/shared/utils.js` import；`server/modules/websocket/index.ts:50` 的转出口改从 `@/shared/utils.js` re-export（AC-385 判据仍经 barrel 打印旗标，读数不变）。旗标语义与关态行为逐字节不变（仍只有恰为 `'1'` 才为真）。
2. **判据文件**（新文件 `server/shared/tests/resident-run-is-turn-single-reader.test.ts`，AC-392 判据）：用 TypeScript compiler API（`ts.createSourceFile`，照 `server/modules/websocket/tests/chat-control-wiring.test.ts` 的语法树扫描先例）扫 `server/` 下全部非测试代码（排除任何 `/tests/` 目录段与 `*.test.ts`），统计对 `process.env.RESIDENT_RUN_IS_TURN`（PropertyAccessExpression）与 `process.env['RESIDENT_RUN_IS_TURN']`（ElementAccessExpression + 字符串字面量）的**读取**（注释与字符串里的名字不计）；同一扫描器再喂两份内存源码做负对照；AST 核对三处 import 声明指向 `@/shared/utils.js` 且 registry 不再导出它；导入谓词后按 (c) 改环境变量读三次。

### 假形态（(e) 为什么承重）

(e) 在任一非测试文件里**临时加第二处读取**（例如在 `server/shared/utils.ts` 里再写一行 `const mirror = process.env.RESIDENT_RUN_IS_TURN;`）⇒ **(a) 腿红**（`flagReaders=2`），且红落在 (a) 的读数上、**不是别的腿先红**。还原后 (a)–(d) 恢复绿，`git diff` 最终不含该临时代码。这正是「一个开关两个拼写」的缺陷签名。

（(d) 的负对照防的是扫描器空转：若扫描器压根不匹配，则「1 处」是假绿——只在注释里提到该名字的源码必须数出 0，含两处真实读取的源码必须数出 2。）

### 时序（SPEC §12）

本条排在 AC-385 与 AC-386 的任务落地之后（它们的 Touches 含 `chat-run-registry.service.ts`，与本条重叠）。已在任务层以结构化 `depends_on` 声明（AC-385 已 done；AC-386 尚在 ready）。正文不复述这层关系。

## AC

- [ ] (a) `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/resident-run-is-turn-single-reader.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印 **AST 扫描腿**：用 TypeScript AST（不是文本 grep；注释与字符串里的名字不计）扫描 `server/` 下全部非测试代码（排除 `/tests/` 目录与 `*.test.ts`），统计对 `process.env.RESIDENT_RUN_IS_TURN`（含 `process.env['RESIDENT_RUN_IS_TURN']`）的读取 ⇒ 读数 `flagReaders=1 at=server/shared/utils.ts:<line>`（立案时实测基线为 **2** 处：`claude-host-driver.provider.ts:759` 与 `chat-run-registry.service.ts:51`）。打印读数后再断言。
- [ ] (b) 同一次运行内 **导入面腿**：`residentRunIsTurn` 由 `server/shared/utils.ts` 导出（AST 核对 export 声明，且带消费者注释）；`claude-host-driver.provider.ts`、`chat-run-registry.service.ts`、`chat-websocket.service.ts` 三处的 import 声明（AST 核对）都指向它（`@/shared/utils.js`），`chat-run-registry.service.ts` **不再导出**它（该谓词的 export 声明全库只此一处，在 utils）。读数 `predicateAtUtils=true importDriver=true importRegistry=true importWebsocket=true registryNoReexport=true`。
- [ ] (c) 同一次运行内 **调用时读取腿**：导入谓词后把 `process.env.RESIDENT_RUN_IS_TURN` 依次设为 `'1'`、其它值（`'true'`、`'0'`、`''`）、`delete` ⇒ 调用结果依次为 `true`、`false`、`false`（只有恰为 `'1'` 才为真）。读数 `callTimeRead=true onlyExactOne=true`。
- [ ] (d) 同一次运行内 **负对照腿（防空转）**：以**内存源码**喂同一扫描器——只在注释里提到该名字的源码计数为 **0**（`commentOnlyCount=0`），含两处真实读取的源码计数为 **2**（`twoRealReadsCount=2`）⇒ 「1 处」不是扫描器空转的假绿。
- [ ] (e) **取假形态可复现**：在任一非测试文件里临时加第二处读取 ⇒ **(a) 腿红**（`flagReaders=2`），且红落在 (a) 的读数上、**不是别的腿先红**。逐字红态读数、退出码与命令行抄进完成记录；用后还原、重跑 (a)–(d) 恢复绿，`git diff` 最终不含该临时代码。
- [ ] (f) 该判据文件单次运行墙钟 **< 20s**（AC 明列；每条读数在断言之前先采齐，红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [ ] (g) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 **355**，AC-386 落地后为 356，以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（立案读数 AC2 的 `known=3 unknown=352`、AC3 的 `known=1 unknown=354`，即 `base - 3` / `base - 1`）各 +1，并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [ ] (h) 遵守 `$backend-module-standards`：判据落 `server/shared/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npx oxlint server/` 退出 0。
- [ ] (i) 既有旗标消费者判据不被悄悄变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-turn-semantics.test.ts`、`... server/modules/websocket/tests/processing-single-writer.test.ts`、`... server/modules/websocket/tests/activity-deliveries-snapshot.test.ts`、`... server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts` 各退出 **0**（它们都经 barrel 或模块读同一谓词并打印旗标读数）；若实现上必须改动其中任一文件，在完成记录里**逐条列出并说明**，不得悄悄让它们变红。

## DoD

真实落地判据（不是「测试存在」、也不是「导出存在」）：在交付的树上跑 `server/shared/tests/resident-run-is-turn-single-reader.test.ts`——它用 TypeScript AST 扫 `server/` 的全部非测试代码：

(a) `process.env.RESIDENT_RUN_IS_TURN` 只有一处读取，位于 `server/shared/utils.ts`（`flagReaders=1`）；
(b) 谓词 `residentRunIsTurn` 由 `server/shared/utils.ts` 导出且带消费者注释，driver / registry / chat-websocket 三处 import 都指向它，registry 不再转出口；
(c) 调用时读取（`'1'`→true，其它值/删除→false，只有恰为 `'1'` 为真）；
(d) 负对照证明扫描器有区分力（只在注释里提到该名字=0，两处真实读取=2）；
(e) 假形态（任一非测试文件加第二处读取 ⇒ (a) 红）可复现，还原后恢复绿——即判据有洞会被看见。

`git diff` 须只含：单点实现（`server/shared/utils.ts`、`server/modules/providers/list/claude/claude-host-driver.provider.ts`、`server/modules/websocket/services/chat-run-registry.service.ts`、`server/modules/websocket/services/chat-websocket.service.ts`、`server/modules/websocket/services/chat-control.service.ts`、`server/modules/websocket/index.ts`）、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/shared/utils.ts` （`residentRunIsTurn` 的新家：调用时读 `process.env.RESIDENT_RUN_IS_TURN === '1'`，按 `$backend-module-standards` 带消费者注释导出；求值叶子，不 import providers / websocket）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （删局部 `residentRunIsTurn`(:758)；五处调用点(:4423/:4553/:4866/:4950/:5042)改经 `@/shared/utils.js` 的 import——「providers 不能 import websocket」的局部副本注释改写为指向共享叶子的说明）
- `server/modules/websocket/services/chat-run-registry.service.ts` （删本模块的 `export function residentRunIsTurn`(:50)；三处调用点(:540/:1052/:1088)改经 `@/shared/utils.js` 的 import；不再转出口该谓词）
- `server/modules/websocket/services/chat-websocket.service.ts` （(:28) import 源由 `chat-run-registry.service.js` 改为 `@/shared/utils.js`）
- `server/modules/websocket/services/chat-control.service.ts` （**实现上必需、立案时未列**：(:9) 同样从 `chat-run-registry.service.js` 深引该谓词；registry 不再导出后必须改指 `@/shared/utils.js`）
- `server/modules/websocket/index.ts` （**实现上必需、立案时未列**：(:50) 的转出口 `residentRunIsTurn` 改从 `@/shared/utils.js` re-export，AC-385 判据经它打印旗标）
- `server/shared/tests/resident-run-is-turn-single-reader.test.ts` （新：AC-392 判据文件——AST 扫描 + 导入面核对 + 调用时读取 + 负对照 + 取假形态）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac392-resident-run-is-turn-single-reader.md` （自触）
