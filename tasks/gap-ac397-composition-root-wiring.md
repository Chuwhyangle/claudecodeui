---
id: gap-ac397-composition-root-wiring
title: AC-397 生产装配守护：交付 server/shared/tests/composition-root-wiring.test.ts —— 用
  TypeScript AST 读 server/index.ts 的模块顶层（不经函数/条件/try）恰各一条 setTurnOpener /
  setUnattendedRunOpener、均先于 .listen(、且把箭头源码 transpile 后绑到隔离 registry 真开出
  run；含未装配反向对照与六类取假形态
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-397
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测 2026-10-17）：`grep -rl '^goal_ac: *AC-397' tasks/*.md` → **0** 命中；`grep -rln 'AC-397' tasks/` → **0** 命中；`task_list search=AC-397` / `search=composition-root-wiring` / `search=setTurnOpener` 均 `total:0` ⇒ 无任何状态（todo / ready / needs-human）的任务认领 AC-397，本条不是重复立案。机制词 `setTurnOpener` 在仓库里只出现在三处：`server/index.ts`（装配本句）、本条新判据、以及两条兄弟判据各自在**测试里自装**（`server/modules/websocket/tests/chat-run-turn-semantics.test.ts`、`.../processing-single-writer.test.ts`）——正因为它们自装，删掉 `server/index.ts` 那一行不会红，这就是本条的缺陷面。与 `server/modules/providers/tests/claude-resident-unattended-turn.test.ts` 的关系：它对同一个 `setUnattendedRunOpener` 只有一处**文本 `includes` 读数**（`readFileSync(...).split('\n').find((line) => line.includes('setUnattendedRunOpener'))`，打印 `[readings] compositionRootWire …`），既不是 AST、也不检查嵌套与顺序、更不执行它；本条是它的严格推广（AST 结构 + 源码顺序 + 执行装配 + 取假形态），机制与判据文件都不同 ⇒ **separate**。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --touches server/shared/tests/composition-root-wiring.test.ts --touches server/index.ts --json`）报 `peers: []`、`mentions: []` ⇒ 无同文件在跑的兄弟，无需 `depends_on`。

### 缺陷面（为什么必须有这一条）

GOAL-045 达成后做的变异实验（2026-10-17，会话 1d9b5177-b11a-4bda-894f-ec522fad82c0，即 AC-397 的 origin）：在临时 worktree 里删掉 `server/index.ts:1063` 的 `sessionHostManager.setTurnOpener((input) => chatRunRegistry.openTurn(input));` 一行后，**AC-382（chat-run-turn-semantics）与 AC-384（processing-single-writer）仍全绿**——两条判据都在自己的测试里调用 `sessionHostManager.setTurnOpener(...)`，没有任何判据读取或执行真实的 composition root。而 `sessionHostManager.openTurn` 的设计是**未装配时静默返回 null**（`server/modules/session-hosts/session-host-manager.service.ts:1625`，`return turnOpener ? turnOpener(input) : null;`），所以删掉装配不报错、不抛异常，只是生产里 run=turn 永远开不出 run。`setUnattendedRunOpener`（`server/index.ts:1054`）只有上面那句文本读数守护，同样不执行它。

本条把 composition root 本身变成被测对象：读真实 `server/index.ts` 的结构（AST），并把那两条装配表达式**取出来执行**，验证它们真能把 run 开出来。

### 交付（一件 + collateral）

1. **新判据文件** `server/shared/tests/composition-root-wiring.test.ts`（AC-397 的 criterion 逐字指定该路径），`node:test` 单文件、单次运行 < 20s。四条腿，每条先采齐读数并 `console.log`、之后才 `assert`：

   - **(a) 结构腿（TypeScript AST，`ts.createSourceFile`；注释与字符串里的名字不产生节点，故不计）**：解析 `server/index.ts`，在**模块顶层**——即祖先链上除 `SourceFile` 外**不得有** `FunctionDeclaration` / `ArrowFunction` / `FunctionExpression` / `IfStatement` / `ConditionalExpression` / `TryStatement` / `CatchClause` / `Block` 等任何容器——各找到**恰好一条** `ExpressionStatement`，其表达式是对 `sessionHostManager.setTurnOpener(...)` 与 `sessionHostManager.setUnattendedRunOpener(...)` 的 `CallExpression`；其唯一实参是箭头函数，该箭头**恰一个形参**，函数体是**对该形参的单次调用**（concise body 即该 `CallExpression`；或 block body 里恰一条语句、且是 `return` 该 `CallExpression`——两种写法都读，打印读了哪一种），被调者分别是 `chatRunRegistry.openTurn` / `chatRunRegistry.openUnattendedRun`，唯一实参是**形参标识符本身**（不是别的表达式、不是零实参、不是 `undefined`）。打印 `wiring turnOpener=<line> unattendedOpener=<line>`（立案实测 **1063 / 1054**）。
   - **(b) 先于监听腿**：同一份 AST 上，这两条语句的 `getStart()` 都小于 `server/index.ts` 里**全部** `.listen(` 调用的最小起点（立案实测唯一一处是 `server.listen(SERVER_PORT, HOST, …)` 在 **:1909**，位于 `startServer`（**1864–**）之内）；且这两条语句**不在 `startServer` 之内**——它们因此在模块加载时执行，而 `startServer()` 在文件末尾 **:2019** 才被调用。打印 `listenLines=[1909] startServerRange=[1864,<end>] wiringInStartServer=false moduleLoadCall=2019`。
   - **(c) 行为腿（装配的是真的）**：从 index.ts 取出这两个箭头的**源码文本**，经 `ts.transpileModule`（`{ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }`）转成 JS（将来给形参加类型标注也不失效），用一个把自由标识符 `chatRunRegistry` 绑到**隔离** `createChatRunRegistry()` 实例的构造取回真函数（`new Function('chatRunRegistry', 'return (' + js + ')')`，或 `node:vm` 的 `runInNewContext`——见「风险 2」），装到**新的** `createSessionHostManager()` 上；随后**经 manager 自己**调用：`openTurn({ appSessionId, provider: 'claude', providerSessionId: null, userId: 1, kind: 'delivered', deliveryIds: ['d1'] })` ⇒ 返回 `{ runId, writer }`，且该隔离注册表 `getRunById(runId)` 读回 `status: 'running'`（`source: 'user'`、`kind: 'delivered'`、`deliveryIds: ['d1']`）；`openUnattendedRun({ appSessionId, provider: 'claude', providerSessionId: null, userId: 1 })` ⇒ 返回 writer，且注册表里留下 `source: 'unattended'` 的 run（用 `getRunById` / `readRun(runId)` / `getRun(appSessionId)` 任一读回）。**反向对照**：一个**未装配**的新 `createSessionHostManager()` 上，`openTurn(...)` 与 `openUnattendedRun(...)` 都 `=== null`。这一对读数在同一进程里把「装配生效」与「装配不生效」分开：删掉装配不是报错而是静默 `null`，这正是本条要钉住的形态。
   - **(d) 取假形态腿（全部在**内存源码字符串**上做，不改仓库文件）**：把 (a)/(b)/(c) 的读数函数参数化成 `(sourceText: string)`，对**每一条**装配语句各做一遍：**删除**该语句 ⇒ (a) 红；把它**包进 `if (process.env.X) { … }`** ⇒ (a) 红；把它**改成注释**（`// …`）⇒ (a) 红；箭头改成 **`() => null`** 或**丢弃形参**（`() => chatRunRegistry.openTurn(undefined)`、`(input) => chatRunRegistry.openTurn()`）⇒ (a) 红**且** (c) 红；把它**移进 `startServer` 函数体**、或**放到 `.listen(` 之后** ⇒ (b) 红。每条变异打印它自己那条腿的红态读数，并断言**红落在指定的那条腿上**（不是别的腿先红）；同一个读数函数在真源码上仍绿（同进程两读对照）。

2. **collateral**：新增一个 `server/**/*.test.ts` ⇒ 复量 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案实测 **363**），把 `server/shared/tests/quay-test-script.test.ts` 自己两条计数 pin 各 +1（立案读数：AC2 `known=3 unknown=360`、AC3 `known=1 unknown=362`，即 `base-3` / `base-1`）并改写其上方注释里的算术（含那句「the tree collects 363 server test files」与本条任务名的记账）；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行——先量：立案 338/363 = **93.1%**，新增后 338/364 = **92.9%**，未破 ⇒ 通常不动。

### 怎么落地 (c)：为什么不导入生产入口

`import 'server/index.ts'`（或 `server/index.js`）会真的起服务、开 DB、绑端口——既不是判据该做的事，也会把单文件运行推过 20s。所以 (c) 走「取源码文本 → `transpileModule` → 把自由标识符**作为形参**绑定 → 装进新 manager」。判据因此**不需要**端口、真 claude 二进制，也**不依赖服务正在运行**。

隔离注册表按 `server/modules/websocket/tests/chat-run-by-id.test.ts:25–87` 的既有夹具照抄：临时 `DATABASE_PATH` + `closeConnection()` + `initializeDatabase()` + `sessionsDb.createSession(...)`，再 `createChatRunRegistry()`（`chat-run-registry.service.ts:292` 的 options 全可省）。`sessionsDb.createSession` 那步只是让 run 的 provider/session 读数与兄弟判据一致；`startRun` 自身不查会话行（见该文件 :652–760）。

### 风险

1. **「顶层」必须用祖先链判，不能用「文件里出现几次」判**：否则把语句挪进 `if (process.env.X) { … }` 之后，文件里仍恰好一条 `setTurnOpener(...)` CallExpression，结构腿会**假绿**。(d) 的 `if` 形态与「移进 `startServer`」形态就是钉这一条的。
2. **(c) 的绑定方式**：箭头体里的 `chatRunRegistry` 是 index.ts 模块作用域的自由标识符。用文本替换改它（找 `chatRunRegistry.` 再替换）会在将来重命名时**静默失配**——那时 (c) 测的是个桩却仍可能绿。把名字**作为 `new Function` 的形参**（或 `vm.runInNewContext` 的 sandbox 键）传进去，重命名会在 (a) 的被调者匹配上先红，而不是在 (c) 里悄悄换掉被测对象。
3. **红要落在读数上**：(c)/(d) 里执行变异源码可能**抛出**（例如 `openTurn(undefined)` 会在体内读 `input.kind`）——把抛出的 `exception=<name>: <msg>` 也当作一条读数捕获并打印，不要让异常打断整个运行、也不要让它被算成「超时」。(f) 的进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
4. **本任务不改 `server/index.ts`**：立案时两条装配已在正确位置（:1054 / :1063，均模块顶层、均先于 :1909 的 `.listen(`）。`server/index.ts` 只被**读**，因此不进 `## Touches`；最终 `git diff` 里不应出现它。

## AC

- [ ] (a) `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/composition-root-wiring.test.ts` 退出 **0**（当前必红：该文件不存在，文案含 `Could not find`）。同一次运行**先打印结构读数** `wiring turnOpener=<line> unattendedOpener=<line>`（立案实测 **1063 / 1054**），逐条打印每条装配的形读数：`topLevel=true`、`paramCount=1`、`callee=chatRunRegistry.openTurn`（或 `.openUnattendedRun`）、`argIsParam=true`、`bodyForm=expression`（或 `block-return`）、`count=<该顶层语句条数>`；再断言「模块顶层恰各一条」。
- [ ] (b) 同一次运行内**先于监听腿**：打印 `listenLines=[1909] startServerRange=[1864,<end>] wiringInStartServer=false moduleLoadCall=2019` 形态的读数；断言这两条语句的起点都小于 index.ts 里**全部** `.listen(` 调用的最小起点，且两者的祖先链里都没有 `startServer`。
- [ ] (c) 同一次运行内**行为腿**：打印 `wired turn runId=<id> status=running source=user kind=delivered deliveries=1`、`wired unattended runId=<id> source=unattended status=running`、`unwired turn=null unattended=null`；断言装配后 `openTurn` 返回的 run 在该隔离注册表里 `getRunById(runId).status === 'running'` 且 `source`/`kind`/`deliveryIds` 相符，装配后 `openUnattendedRun` 在注册表里留下 `source === 'unattended'` 的 run，而**未装配**的新 manager 上 `openTurn` 与 `openUnattendedRun` 都 `=== null`。
- [ ] (d) 同一次运行内**取假形态腿**：六类变异（对 `setTurnOpener` 与 `setUnattendedRunOpener` 各一遍：删 / 裹 `if` / 注释掉 / `() => null` 或丢形参 / 移进 `startServer` / 放到 `.listen(` 之后）**各自红在指定的那条腿**，红态读数逐字打印（含 `count=0`、`topLevel=false`、`argIsParam=false`、`exception=…` 这类读数），且同一个读数函数在真源码上仍绿；全部变异只在内存字符串上做，`git status --short server/index.ts` 保持空。
- [ ] (e) 判据**不执行生产入口**：AST 核对判据文件自身没有任何 import / require 的说明符解析到 `REPO_ROOT/server/index.ts`（计数打印为 0，且打印 `indexSourceChars=<n>` 证明 composition root 是以**文本**读入的），因此运行时不绑端口、不起服务、不依赖服务正在运行。
- [ ] (f) 该判据文件单次运行墙钟 **< 20s**（AC 明列）；读数先采齐再断言，红要落在错的读数上、不落在超时或更早的腿上；进程预算守卫照兄弟文件用 `exit 3`（进程级杀）。
- [ ] (g) collateral：新增一个 server 测试文件 ⇒ 复量收集数（立案 **363**），`server/shared/tests/quay-test-script.test.ts` 两条计数 pin 各 +1（AC2 读 `known=3 unknown=361`、AC3 读 `known=1 unknown=363`）并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` 仅当 AC7 覆盖率地板跌破 90% 才追加一行（先量，立案 93.1%）；单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 **0**。
- [ ] (h) 遵守 `$backend-module-standards`：判据落 `server/shared/tests/`、跨模块引用只经模块 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 **0**；`npx oxlint server/` 退出 **0**。
- [ ] (i) 本任务不改 `server/index.ts`、也不改任何生产代码 ⇒ 既有兄弟判据不被悄悄变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-turn-semantics.test.ts` 与 `... --test server/modules/websocket/tests/processing-single-writer.test.ts` 各退出 **0**（两条都在测试里自装 opener，正是「删掉 index.ts 那行它们仍绿」的证据）；若实现上必须改动其中任一文件，在完成记录里逐条列出并说明。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/shared/tests/composition-root-wiring.test.ts`——它**读真实的 `server/index.ts`**（TypeScript AST，不是文本 grep，注释与字符串里的名字不算）并**执行其中那两条装配表达式**：

(a) 模块顶层恰各一条 `sessionHostManager.setTurnOpener(<箭头>)` / `sessionHostManager.setUnattendedRunOpener(<箭头>)`，箭头恰一形参、函数体是对 `chatRunRegistry.openTurn` / `chatRunRegistry.openUnattendedRun` 的单次调用、形参原样作唯一实参（立案 1063 / 1054）；
(b) 两条在源码顺序上都先于 index.ts 的全部 `.listen(`，且都不在 `startServer` 之内（随模块加载执行）；
(c) 取出这两个箭头、`transpileModule` 后绑到隔离 `createChatRunRegistry()`，装进新 `createSessionHostManager()` ⇒ `openTurn` 真开出 run（`getRunById(runId).status === 'running'`），`openUnattendedRun` 真留下 `source === 'unattended'` 的 run；未装配的对照 manager 上两者都 `=== null`；
(d) 六类取假形态各自红在指定的那条腿（内存源码，不改仓库文件），还原即绿。

**这条判据存在的唯一理由，是「装配被删掉」时要能被看见**：把 `setTurnOpener(...)` 语句从内存源码里删掉后 (a) 必须红，而 (a) 的这层区分力由 (c) 的反向对照（未装配 ⇒ `null`）与 (d) 的六类变异共同兜住——一个只在真源码上绿、在变异源码上不红的判据，测的是它自己的夹具而不是 composition root。它补的正是 2026-10-17 那个洞：删掉 `server/index.ts:1063` 一行后 AC-382 与 AC-384 仍全绿，本判据落地后该删改会立刻红。

`git diff` 须只含：这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline）、以及本任务的 task 文件。完成记录须含：四条腿的逐字读数与 `EXIT=0`、六类变异各自的逐字红态与它红在哪条腿、(f) 的墙钟、(g) 的复量数字、还原后 `git status --short` 干净的证据。

## Touches

- `server/shared/tests/composition-root-wiring.test.ts` （新：AC-397 判据文件——AST 结构腿 + 先于监听腿 + 执行装配的行为腿 + 未装配反向对照 + 六类取假形态；只读 `server/index.ts`，不 import 生产入口）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术与任务记账）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac397-composition-root-wiring.md` （自触）
