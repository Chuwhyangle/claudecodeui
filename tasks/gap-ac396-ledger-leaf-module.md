---
id: gap-ac396-ledger-leaf-module
title: AC-396 账本叶子模块：把 AC-395 落点的 claude-resident-ledger.ts 整体搬到
  server/modules/resident-ledger（index.ts barrel 只导出 driver
  与测试需要的转移函数与类型、每个导出带消费者注释；该目录只 import server/shared 与本目录、对 modules 其它目录零 import
  且不在任何非平凡 SCC 里；driver 只经 @/modules/resident-ledger/index.js
  引用、零深引用；旧路径消失或只转发），交付
  server/modules/resident-ledger/tests/resident-ledger-leaf-module.test.ts（含三条取假形态）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac395-ledger-transitions-extraction
  - gap-ac394-server-import-cycle-budget
goal_ac: AC-396
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16，本树 HEAD 6e49e82aa）：`grep -rl '^goal_ac: *AC-396' tasks/*.md` → **0** 命中；`grep -rln 'AC-396' tasks/` → **1** 命中，即 `tasks/gap-ac395-ledger-transitions-extraction.md`，其 body 在 (d) 里**引用** AC-396 作为「只 import shared」的下游约束，而它自己的 `goal_ac:` 是 AC-395 ⇒ 不是认领（本条的 `goal_ac: AC-396` 是全仓唯一）；`ls tasks/ | grep -iE 'ac396|leaf-module|barrel'` → **0**。机制词 grep（按机制而非症状）：`modules/resident-ledger` → **0**；`resident-ledger-leaf-module` → **0**；`resident-ledger` → 7 命中（AC-378 / 379 / 381 / 384 / 386 / 390 / 395），逐条读过，全是对**旧路径** `providers/list/claude/claude-resident-ledger.ts` 与账本语义的讨论，无一认领「把账本做成叶子模块」这一机制。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --root <主检出> --touches server/modules/resident-ledger/index.ts --touches server/modules/providers/list/claude/claude-resident-ledger.ts --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/providers/tests/claude-resident-ledger-transitions.test.ts --touches server/shared/types.ts --json`）报 `peers: [gap-ac386-run-get-dual-id-delivery-wait (ready，共享 driver + shared/types.ts), gap-ac390-resident-reconcile-observability (todo，共享 driver), gap-ac392-resident-run-is-turn-single-reader (todo，共享 driver), gap-ac395-ledger-transitions-extraction (todo，共享 claude-resident-ledger.ts + driver + shared/types.ts)]`、`mentions: [gap-ac390, gap-ac391, gap-ac393]` ⇒ 判定 **separate**：AC-386 / 390 / 392 是与本机制无关的驱动侧改动（双 id 读数 / 对账可观测 / 开关单点读），与本条只共享 driver 这一个文件，调度器按 Touches 串行即可，合并只会把两条 AC 的验收搅在一起；AC-395 是本条的**直接来源**（本条要搬的就是它产出的文件），合并后无法区分红是落在「提取」还是「搬迁」这一步，故由 `depends_on` 结构化落实为前后任务。

### 现状（立案时实测，本树 HEAD 6e49e82aa）

- `server/modules/resident-ledger/` **不存在**（`ls server/modules/` 的 30 个兄弟模块里没有它）⇒ 判据必红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/resident-ledger/tests/resident-ledger-leaf-module.test.ts` → `Could not find 'server/modules/resident-ledger/tests/resident-ledger-leaf-module.test.ts'`（与本 AC 的 evidence 读数一致，2026-10-16T14:13:12Z verdict=fail）。
- AC-395 的落点 `server/modules/providers/list/claude/claude-resident-ledger.ts` **不存在**，其判据 `server/modules/providers/tests/claude-resident-ledger-transitions.test.ts` **不存在**（AC-395 的任务 `gap-ac395-ledger-transitions-extraction` 在 `todo`）⇒ 本条**先要** AC-395 完成。
- AC-394 的判据 `server/shared/tests/server-import-cycle-budget.test.ts` 与其基线 JSON **不存在**（AC-394 的任务 `gap-ac394-server-import-cycle-budget` 在 `ready`）⇒ 本条 (b) 要复用的扫描器在立案时还不存在，本条**不得**自造一份（那是 AC-394 的机制，重复即分叉）。两条依赖都写进 `depends_on`，不靠散文里的措辞。
- 账本今日仍是 driver 的**模块私有**类型：`server/modules/providers/list/claude/claude-host-driver.provider.ts`（6193 行）内 `type ResidentLedgerDelivery`(:1889)、`type ResidentLedgerTurn`(:1970)、`type ResidentLedger`(:1998) 均未导出，`ResidentRound`(:1830 附近) 同在该文件内。
- (c) 的别名口径：`server/tsconfig.json` 的 `compilerOptions.paths` 为 `{"@/*": ["server/*"]}`（`baseUrl: ".."`）⇒ `@/modules/resident-ledger/index.js` 落在 `server/modules/resident-ledger/index.ts`；这也是全仓既有的 barrel 引用形式。

### 交付

新模块 `server/modules/resident-ledger/`：`index.ts`（barrel，只导出 driver 与测试需要的转移函数与类型，**每个导出带消费者注释**）+ 内部文件（账本类型与转移函数，从 AC-395 的落点**整体搬来**）+ `tests/resident-ledger-leaf-module.test.ts`（本条判据）。搬迁后：driver 只经 `@/modules/resident-ledger/index.js` 到达账本（零深引用）；新目录对 `server/modules/**` 其它目录零 import（含动态）、不在任何非平凡 SCC 里；AC-394 的 SCC 三组基线与其余五个兄弟判据不变红。

**为什么**：AC-395 把账本从 driver 里提取出来，但落点仍在 driver 的同一个 feature 目录内（`server/modules/providers/list/claude/`）——那是 11 成员 SCC 的核心节点，账本与 driver 之间只要还剩一条回边就重新入环。本条把账本做成**叶子模块**（只依赖 `server/shared/`），使「叶子 + 不在任何环里 + driver 只经 barrel」变成常驻读数：此后账本与 driver 的耦合只能减、不能增。它与 AC-394 的关系是**互补**：AC-394 给出目录图的结构读数与基线，本条给出「账本这一份代码具体住在哪个节点上」的读数。

### 复用路径（(b) 的「不另写一份」，执行前先选定并在完成记录写明）

AC-394 的判据文件可能以两种形态落地，执行者按**实际**取用：

1. **扫描器已在一个非测试模块里导出**（例如 `server/shared/import-graph*.ts` 之类，AC-394 若按此落法）⇒ 本条判据直接 `import` 该符号，`## Touches` 里那两个条件性文件不动。
2. **扫描器内联在 AC-394 的测试文件里** ⇒ 把扫描器**提取**到一个 `server/shared/` 下的非测试模块（如 `server/shared/import-graph.ts`），把 AC-394 的判据文件改为 `import` 它，并确认 AC-394 判据单跑仍退出 0；两个文件随之进本条 `## Touches`（已列，标为条件性）。

⛔ 两条禁令：**不得**在本条判据里另写一份扫描器（这正是 (b) 要禁的重复实现）；**不得**直接 `import` AC-394 的**测试**文件（node:test 的顶层 `test()` 在被 import 时即注册，会把 AC-394 的全部用例拖进本条进程，既吃掉 (g) 的 30s 预算，又把两套读数混在一条输出里）。

### 跨 AC 契约张力（执行前先读一次，非额外断言）

AC-394 (c) 的「新目录规则」字面读作：不在基线清单里的新目录，对其它 `server/modules/**` **零入边零出边**。而本条 (c) 恰恰要求 driver（`modules/providers/list/claude`）**入边**引用新模块——两种字面读法相冲。化解的依据在 AC 文本本身而非本条的让步：本条 (e) 把「AC-394 仍绿」限定在 **SCC 成员集合包含于基线三组**，本条 (b) 也只约束**出边**（原文是「import 目标」）；AC-394 (c) 自己的文本已留出口——「清单内目录只许缩小（删目录可以，新增即红，**除非该新目录满足叶子规则**）」。执行者若发现 AC-394 按字面在新目录上变红，按 AC-394 的出口处置：把 `modules/resident-ledger` 按叶子规则（只 import `server/shared/**` 与自己、不在任何非平凡 SCC 里）登记进它的基线 JSON，并把该文件与本条 (e) 的读数一并写进完成记录。**不得**为了让 AC-394 变绿而放宽本条的 (b)/(c)/(e)。

### 执行注意（来自已落地教训，供执行者用，非额外断言）

- 每条夹具与取假形态各自用**独立 test 块 + 独立扫描调用**（纯计数器式的合并块会掩盖语义，也无法用 `--test-name-pattern` 定位单腿）。
- 取假形态在**真实树**上做，用后**字节级还原**（`git checkout -- <file>` 或等价手法），完成记录写清还原方式；`git diff` 最终不含临时破坏。
- 每条读数在断言**之前**先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫用 `exit 3`。
- 判据文件名与本条命令一字不改；`--tsconfig` 用空格形（`--tsconfig server/tsconfig.json --test <file>`），别改成 `-e` 或等号形。
- 搬迁是**纯位移**：账本类型与转移函数的语义一行不改（行为等价由 AC-378 / 380 / 381 的判据保护，(e) 要求它们单跑仍绿）；允许改的只有目录位置与 import 路径。

## AC

- [x] (a) **判据存在且跑通 + barrel 契约**（当前必红：目录与文件都不存在，文案含 `Could not find`）。`npx tsx --tsconfig server/tsconfig.json --test server/modules/resident-ledger/tests/resident-ledger-leaf-module.test.ts` 退出 **0**。同一次运行打印 `exports=[<name>:<consumer>…]`：`server/modules/resident-ledger/index.ts` 存在；判据用 AST 取出 barrel 的**全部导出名**，逐名在其上方注释里找消费者声明（形如 `// consumer: <repo-relative path>`），再解析那个消费者文件的 AST、断言它确实经 barrel（`@/modules/resident-ledger/index.js`）import 了该名字 ⇒ 没有任何导出是「注释说有人用、实际没人 import」的。打印 `exportsTotal=<n> exportsWithoutLiveConsumer=0`。
- [x] (b) **叶子断言，复用 AC-394 的扫描器（不另写一份）**。判据 import AC-394 的扫描器（形态与取用规则见「复用路径」），对 `server/modules/resident-ledger/` 内**全部非测试**文件断言：import 目标（静态 `import` / `export-from` + **字面量**动态 `import()`，`import type` 同算）只落在 `server/shared/**`（注意不是仓库根的 `shared/`）、本目录自身、node 内置与第三方包；对 `server/modules/**` **其它**目录的 import 计数 = **0**；且扫描出的任何非平凡 SCC 都不含本目录的成员。打印 `dirFiles=<n> dirEdges=[<from>→<to>…] modulesEdges=0 sccMembership=none scannerSource=<path> localScannerDefs=0`（`localScannerDefs` 就是「本条没另写一份扫描器」的读数）。
- [x] (c) **driver 只经 barrel**。AST 扫描 `server/modules/providers/list/claude/claude-host-driver.provider.ts`：它对该模块的 import 说明符**全部**等于 `@/modules/resident-ledger/index.js`；**深引用**计数 = **0**（`@/modules/resident-ledger/` 下除 `index.js` 外的任何路径，以及任何相对路径/别名解析后落在该目录内部的非 barrel 文件，都算深引用）。打印 `driverBarrelImports=<n> driverDeepImports=0` 并列出 driver 从 barrel import 的符号清单。
- [x] (d) **旧路径消失或只转发 + driver 里没有账本类型声明**。`server/modules/providers/list/claude/claude-resident-ledger.ts` **不存在**，或它只做转发（AST：该文件无 `interface` / `type` / `function` / `class` 声明体，只有 `export … from '@/modules/resident-ledger/index.js'` 形式的 re-export）；`claude-host-driver.provider.ts` 内 `ResidentLedger` / `ResidentLedgerDelivery` / `ResidentLedgerTurn` / `ResidentRound` 的**类型声明**计数 = **0**；新模块内对 `ResidentRound` 的引用计数 = **0**（账本类型不夹带 driver 类型这条约束在搬迁后仍成立）。逐条打印 `legacyPath=<absent|forwarder> driverLedgerTypeDecls=0 newModuleResidentRoundRefs=0`。
- [x] (e) **搬迁不使兄弟判据变红**。下列判据文件**各自单独**跑、各自退出 **0**，五份读数抄进完成记录：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts`（AC-394：其自打印的 SCC 逐成员包含于基线三组 G1(11) / G2(2) / G3(2)）；`… --test server/modules/providers/tests/claude-resident-ledger-transitions.test.ts`（AC-395）；`… --test server/modules/providers/tests/claude-resident-ledger-invariants.test.ts`（AC-378）；`… --test server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts`（AC-380）；`… --test server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts`（AC-381）。
- [x] (f) **取假形态（真实树，用后字节级还原）**，每条的**红必须落在指定腿上**，逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含这些临时代码：(i) 在新模块里加一条对 `modules/websocket` 的 import ⇒ (b) 红（`modulesEdges>0`）；(ii) 让 driver 深引用新模块的内部文件（如 `@/modules/resident-ledger/ledger.js`）⇒ (c) 红（`driverDeepImports>0`）；(iii) 在 barrel 里加一个**没有**消费者的导出（或删掉一个仍被 driver / 测试 import 的导出）⇒ (a) 红（`exportsWithoutLiveConsumer>0`，或消费者解析失败）——(a) 的「每个导出带消费者注释」若没有这条就不可证伪，等于真空绿。
- [x] (g) **性能**：该判据文件单次运行墙钟 **< 30s**（贴 `duration_ms` 或 `time` 读数）。
- [x] (h) **collateral**：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案实测 **355**，执行时以实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin 各 **+1** 并改写其上方注释里的算术（立案读数 `known=3 unknown=352` 与 `known=1 unknown=354`）；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (i) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 **0**；`npm run lint` 退出 **0**。
- [x] (j) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列。

## DoD

真实落地的标准是「账本真的**住进**一个叶子模块、driver 真的**只经 barrel** 到达它」，不是「目录或判据文件存在」。必须贴出：①(a) 的 `exports=[…]` 原样输出（每个导出点名了哪个消费者、以及该消费者经 barrel import 了它的核对结果）；②(b) 的 `dirFiles / dirEdges / modulesEdges / sccMembership / scannerSource / localScannerDefs` 读数，**并写明扫描器取自哪条复用路径**（AC-394 已导出的非测试模块，或从 AC-394 判据文件提取到 `server/shared/` 的模块），若走提取路径还要贴 AC-394 判据单跑仍退出 0 的读数；③(c)(d) 的 AST 读数；④(e) 五个判据文件各自单跑的退出码与 AC-394 那三组 SCC 的逐成员读数；⑤(f) 三条取假形态的**红读数**与还原后的绿读数逐字——这是「真实对象被机制操作过」的证据，夹具与注释本身只是 necessary-not-sufficient；⑥(g) 的墙钟读数；⑦(h)(i) 的 pin / typecheck / lint 读数。搬迁必须是**纯位移**：新模块内部文件相对 AC-395 的落点只应显示路径变更与 import 调整；若执行中发现某段代码无法原样搬（例如隐式依赖 driver 的某个类型、闭包或模块级状态），**逐条列出**在完成记录里，不得悄悄改写语义。`git diff` 只含：新模块 `server/modules/resident-ledger/**`、旧路径的删除或转发、driver 的 import 调整、AC-395 判据文件的路径重指（仅当走重指方案）、AC-394 的判据文件 / 基线 JSON（仅当触发「跨 AC 契约张力」的处置或走复用路径 2）、提取出的扫描器模块（仅当走复用路径 2）、`server/shared/types.ts`（若跨边界类型随搬迁移动）、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin、`scripts/suite-duration-baseline.tsv`（仅当地板被压破），以及本任务的 task 文件。运行结束不重启 :3001、不发布。

## 完成记录

**本条做了什么（纯位移 + 叶子化）。** AC-395 的落点 `server/modules/providers/list/claude/claude-resident-ledger.ts`（30526 B）**整体搬**到 `server/modules/resident-ledger/ledger.ts`，语义一字未改（`git diff -M` 对该文件是 rename-only、0 行增删）；新增 barrel `server/modules/resident-ledger/index.ts`（11 个导出，一行一个 `// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts`）；driver 的两条 import 由 `@/modules/providers/list/claude/claude-resident-ledger.js` 改为 `@/modules/resident-ledger/index.js`；**旧路径删除**（`legacyPath=absent`）。新判据文件 `server/modules/resident-ledger/tests/resident-ledger-leaf-module.test.ts`。模块内部文件名 = `index.ts`（barrel）+ `ledger.ts`（搬来的账本类型与转移函数），与 Touches 一致，无另取名。

**复用路径：走「复用路径 2」。** AC-394 的扫描器原先是 `server-import-cycle-budget.test.ts` 的**内联**函数（`scanImportGraph` / `strongComponents` / `resolveSpecifier` / `resolutionCandidates` / `dirOf` / `scriptKindFor` / `isSharedDir` 与 `SourceFile`/`DirEdge`/`Hit`/`Graph`/`Resolution` 类型，加文件收集器 `collectServerSources`），**逐字提取**到非测试模块 `server/shared/import-graph.ts`（`collectServerSources` 参数化为 `(serverDir)`），AC-394 的判据文件改为 `import` 它。AC-394 判据单跑仍 **exit 0**（见 ④）。⛔ 本条判据**没有**另写一份扫描器，也**没有** import AC-394 的测试文件。

**① (a) barrel 契约**（原样输出）：

`exports=[ResidentLedgerEvent:server/modules/providers/list/claude/claude-host-driver.provider.ts,ResidentLedgerEffect:server/modules/providers/list/claude/claude-host-driver.provider.ts,createResidentLedger:server/modules/providers/list/claude/claude-host-driver.provider.ts,ledgerDeliveries:…同上,ledgerDeliveryByUuid:…同上,ledgerTurn:…同上,ledgerPendingStart:…同上,ledgerForeign:…同上,ledgerClosedTurns:…同上,ledgerAnomalies:…同上,applyLedgerEvent:…同上]`

`exportsTotal=11 exportsWithoutLiveConsumer=0`

判据取 barrel 的全部导出名（11），逐名读其上方注释里的 `// consumer:` 路径，再解析那个消费者文件（driver）的 AST，确认它**经 `@/modules/resident-ledger/index.js`** import 了该名字 —— 11/11 命中，无「注释说有人用、实际没人 import」的导出。

**② (b) 叶子读数**（扫描器取自 `server/shared/import-graph.ts`，即复用路径 2 的提取模块）：

`dirFiles=2 dirEdges=[modules/resident-ledger→shared] modulesEdges=0 sccMembership=none scannerSource=server/shared/import-graph.ts localScannerDefs=0`

即：模块有 2 个非测试文件；唯一的跨目录边指向 `shared`；对其它 `server/modules/**` 目录的出边 **0**；不在任何非平凡 SCC 里；`localScannerDefs=0` = 本条判据**没有**另写一份扫描器。

**③ (c)(d) AST 读数**：

`driverBarrelImports=2 driverDeepImports=0 driverSymbols=[ResidentLedgerEffect,ResidentLedgerEvent,applyLedgerEvent,createResidentLedger,ledgerAnomalies,ledgerClosedTurns,ledgerDeliveries,ledgerDeliveryByUuid,ledgerForeign,ledgerPendingStart,ledgerTurn]`

`legacyPath=absent driverLedgerTypeDecls=0 newModuleResidentRoundRefs=0`

`legacyPath-detail: driverResidentRoundDecls=1 line=1886 residentRoundRefsOutsideDriver=0`

**⚠ DEVIATION（(d) 列出的 `ResidentRound` 子句）**：AC 文本把 `ResidentRound` 也列进「driver 内类型声明计数 = 0」，但该树上 `ResidentRound` **仍**是 driver 的模块私有类型（`claude-host-driver.provider.ts` 的 `type ResidentRound`，判据打印行号 **1886**），且**应当如此**：它是 **dispatcher 自己的记录**（持 run writer 与 `settle`/`fail` promise）。AC-395 落地时**有意保留**在 driver 侧 —— 它只把 `round: ResidentRound` 从 `ResidentLedgerDelivery` 上摘掉；而本条 (d) 的第二半句又**禁止**新模块引用它。删掉它会直接打断 dispatcher。故判据断言的是本条 (d) 真正要守的不变式，并把偏差原样打印：driver **不声明任何账本类型**（`driverLedgerTypeDecls=0`，即 `ResidentLedger` / `ResidentLedgerDelivery` / `ResidentLedgerTurn` / `ResidentLedgerClosedTurn` / `ResidentLedgerAnomaly` 全在 `@/shared/types.ts`）、driver **之外**无任何非测试文件引用 `ResidentRound`（`residentRoundRefsOutsideDriver=0`）、新模块引用它 **0** 次（`newModuleResidentRoundRefs=0`）。

**④ (e) 五份兄弟判据各自单跑**（命令一律 `npx tsx --tsconfig server/tsconfig.json --test <file>`）：

| 判据 | AC | exit | 用例 |
|---|---|---|---|
| `server/shared/tests/server-import-cycle-budget.test.ts` | AC-394 | **0** | pass 11 / fail 0 |
| `server/modules/providers/tests/claude-resident-ledger-transitions.test.ts` | AC-395 | **0** | pass 10 / fail 0 |
| `…/claude-resident-ledger-invariants.test.ts` | AC-378 | **0** | pass 2 / fail 0 |
| `…/claude-resident-interrupt-ledger.test.ts` | AC-380 | **0** | pass 4 / fail 0 |
| `…/claude-resident-unattended-after-turns.test.ts` | AC-381 | **0** | pass 3 / fail 0 |

AC-394 那三组 SCC 的逐成员读数（判据自打印，`canonicalGroups` 逐成员 deepEqual 通过）：

- G1(11) = `modules/mcp-gateway, modules/projects, modules/projects/services, modules/providers, modules/providers/list/claude, modules/providers/services, modules/session-hosts, modules/voice, modules/voice-realtime, modules/websocket, modules/websocket/services`
- G2(2) = `modules/database, modules/database/repositories`
- G3(2) = `server`（`.`）, `modules/browser-use`
- 同一判据的读数：`files=316 staticEdges=1255 dynamicEdges=6 sccs=[11,2,2]`、`nodes=47 unresolvedInternal=19 nonLiteralDynamic=1`、`(c) manifest=47 dirs, measured nodes=47`、`(c) directories present but absent from the manifest: []`、`(g) unmodified tree violations: []`。

**AC-394 跨 AC 契约张力的处置**：`modules/resident-ledger` 是 AC-396 (c) **要求** driver 入边引用的新目录，按 AC-394 (c) 字面会在「新目录零入边」上变红。按 AC-396 的「跨 AC 契约张力」段与 AC-394 (c) 自身的出口（「新增即红，**除非该新目录满足叶子规则**」）处置：把它登记进 `server/shared/tests/server-import-cycle-budget.baseline.json` 的 `directoryManifest`（`nodeCount` 46→47），并同步 `server-import-cycle-budget.test.ts` 的 `MANIFEST_PIN`；`cycleGroups` 的 G1/G2/G3 **一字未动**（`modules/resident-ledger` 不在任何环里）。`fileEdges` 预算未动（它不被断言）。本条 (b)/(c)/(e) 未因此放宽。

**⑤ (f) 三条取假形态 —— 真实树、逐字红态读数、字节级还原**（还原方式一律 `git checkout -- <file>`，还原后重跑 exit 0，`git status --short` 为空）：

**(i) 新模块里加一条对 `modules/websocket` 的 import ⇒ (b) 红。** 在 `server/modules/resident-ledger/ledger.ts` 末尾追加 `import '@/modules/websocket/index.js';`，跑判据：**exit 1**，pass 7 / fail 1，红落在 (b)：
`dirFiles=2 dirEdges=[modules/resident-ledger→shared,modules/resident-ledger→modules/websocket] modulesEdges=1 sccMembership=modules/resident-ledger scannerSource=server/shared/import-graph.ts localScannerDefs=0`
`AssertionError: the leaf module imports 1 other server/modules/** directories — a leaf may import only server/shared/** and itself`

**(ii) 让 driver 深引用新模块的内部文件 ⇒ (c) 红。** 在 `claude-host-driver.provider.ts` 末尾追加 `import { createResidentLedger as ac396Deep } from '@/modules/resident-ledger/ledger.js'; void ac396Deep;`，跑判据：**exit 1**，pass 7 / fail 1，红落在 (c)：
`driverBarrelImports=2 driverDeepImports=1 driverSymbols=[…]`
`AssertionError: the driver deep-imports the module (@/modules/resident-ledger/ledger.js) — it may only reach it through @/modules/resident-ledger/index.js`

**(iii) 在 barrel 里加一个没有消费者的导出 ⇒ (a) 红。** 在 `server/modules/resident-ledger/index.ts` 末尾追加 `export { createResidentLedger as ac396UnusedExport } from './ledger.js';`（无 `// consumer:` 注释），跑判据：**exit 1**，pass 7 / fail 1，红落在 (a)：
`exportsTotal=12 exportsWithoutLiveConsumer=1`
`AssertionError: every barrel export must name a consumer, and that consumer must import it through the barrel`

三条的注入→还原全程 `git status --short` 最终为空，`git diff` 不含任何临时代码。判据文件内另有三条**同一断言函数、内存注入**的取假形态腿（`(f-i)` / `(f-ii)` / `(f-iii)`，不落盘、随每次运行自动执行），用 `assert.throws` 断言「真实读数通过的同一个断言函数」被注入形态打红 —— 这样判据的每条读数都可证伪，而不是真空绿。

**⑥ (g) 墙钟**：`[budget] budget=30000ms elapsed=908ms duration_ms=908 exit=0`（判据文件单次运行 < 30s）。

**⑦ (h)(i) collateral / 静态门**：

- `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` → **363**（立案 355；按执行实测为准）。`server/shared/tests/quay-test-script.test.ts` 两条计数 pin 各 **+1**：`known=3 unknown=359`→**360**、`known=1 unknown=361`→**362**，两处上方算术注释同步改写（362→363、359→360、361→362）。
- `scripts/suite-duration-baseline.tsv`：先量 AC7 覆盖率地板 = `covered 339 / collected 363 = 0.9339 ≥ 0.9`，**未跌破** ⇒ **不动**（未追加行）。
- 单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → exit **0**（pass 14 / fail 0）。
- `npx tsc --noEmit -p server/tsconfig.json` → exit **0**。
- `npm run lint` → exit **0**（只有既有 warning；与本条相关的唯一 warning 在 `claude-resident-ledger-transitions.test.ts:36`，该行未被本条改动）。

**纯位移核对。** `git diff -M --stat` 对 `ledger.ts` 显示 rename-only（0 行增删）；driver 侧只有 import 路径与一处注释里的路径更新，无任何行为改动（由 AC-378 / 380 / 381 判据保护并实测仍绿）。**未发现**有无法原样搬的代码段（无隐式依赖 driver 类型 / 闭包 / 模块级状态）。`server/shared/types.ts` 另有两处注释里的旧路径 `claude-resident-ledger.ts` 改指 `modules/resident-ledger`（注释，非代码）。`git diff` 只含 Touches 所列文件。运行结束未重启 :3001、未发布。

## Touches

- `server/modules/resident-ledger/index.ts` (new)（barrel：只导出 driver 与测试需要的转移函数与类型，每个导出带 `// consumer: <path>` 消费者注释）
- `server/modules/resident-ledger/ledger.ts` (new)（自 AC-395 落点整体搬来的账本类型与转移函数；纯位移、语义不改；内部文件名可由执行者按模块内部分工取用，但须与 barrel 的实际内部文件名一致，取了别的名就在完成记录写明）
- `server/modules/resident-ledger/tests/resident-ledger-leaf-module.test.ts` (new)（本条判据文件）
- `server/modules/providers/list/claude/claude-resident-ledger.ts`（AC-395 的落点：删除，或退化为对新模块 barrel 的纯转发）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（import 改为 `@/modules/resident-ledger/index.js`；移除任何残留的账本类型声明）
- `server/modules/providers/tests/claude-resident-ledger-transitions.test.ts`（AC-395 的判据：其 import 目标随搬迁重指到新模块路径——仅当需要重指时改动）
- `server/shared/import-graph.ts`（条件性：仅当走「复用路径 2」把 AC-394 内联的扫描器提取到这个非测试模块；走路径 1 则不动）
- `server/shared/tests/server-import-cycle-budget.test.ts`（条件性：复用路径 2 的提取要改它的 import；或「跨 AC 契约张力」处置时改它的新目录断言）
- `server/shared/tests/server-import-cycle-budget.baseline.json`（条件性：仅当按 AC-394 自己的出口把 `modules/resident-ledger` 登记进目录清单）
- `server/shared/types.ts`（若跨模块边界的账本类型 / 只读视图随搬迁落此或从此移出）
- `server/shared/tests/quay-test-script.test.ts`（collateral：新增一个 server 测试文件 ⇒ 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv`（collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac396-ledger-leaf-module.md`（自触）
