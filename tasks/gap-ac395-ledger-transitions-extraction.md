---
id: gap-ac395-ledger-transitions-extraction
title: AC-395 账本转移收口：把 resident 账本的转移函数与账本类型提取到新模块
  server/modules/providers/list/claude/claude-resident-ledger.ts，转移函数返回
  {changed, effects}，driver 只持实例并转发事件、对 turnLedger 的字段访问为 0，账本类型不夹带 driver
  类型（round/leaseId/leaseHeld 移出）、三处「关闭 turn 并记 closedTurns」与三处 [reconcile]
  异常各收成一份；交付
  server/modules/providers/tests/claude-resident-ledger-transitions.test.ts（表驱动转移用例
  + 类型层面断言 + SPEC 附录 A 回放 + 三处取假形态）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac386-run-get-dual-id-delivery-wait
goal_ac: AC-395
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-395' tasks/*.md` → **0** 命中；`grep -rln 'AC-395' tasks/` → **0** 命中；`ls tasks/ | grep -iE 'ac395|ledger-transitions'` → **0** ⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-395。机制词 grep（按机制而非症状）：`claude-resident-ledger.ts` → 0；`转移函数` → 0；`只读视图` → 0；`effects 判别联合` → 0。合并候选（`node …/task-granularity-advice.js --root <主检出> --touches server/modules/providers/list/claude/claude-resident-ledger.ts --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/providers/tests/claude-resident-ledger-transitions.test.ts --json`）报 `peers: [gap-ac386-run-get-dual-id-delivery-wait (ready), gap-ac390-resident-reconcile-observability (todo), gap-ac392-resident-run-is-turn-single-reader (todo)]`（共享文件同为 driver）、`mentions: [gap-ac393-resident-legacy-path-ratchet (ready)]` ⇒ 判定 **separate**：四者机制各不相同（AC-386 是 run_get 双 id 读数、AC-390 是对账可观测、AC-392 是开关单点读、AC-393 是旧路径棘轮），各有独立判据文件与验收，合并只省一次固定开销却把两条 AC 的验收搅在一起。时序（据本 AC 期望文本）：本条任务排在 AC-385（**已落地**）与 **AC-386 的任务之后**、**AC-390 的任务之前**；前者由 `depends_on: [gap-ac386-run-get-dual-id-delivery-wait]` 结构化落实（兄弟 `gap-ac392` 亦如此声明），后者由与 AC-390 共用 driver 这一 Touches 重叠的调度串行承担。本段落里的先后是**排序说明**，非向 Ready 池另加的新前置（段首 `<!-- dedup-ref -->` 标记即为此），不得因此让本任务晋升失格。

### 现状（立案时实测，本树 HEAD 794227804）

S1 账本已内联在 driver（AC-378 落地）：`server/modules/providers/list/claude/claude-host-driver.provider.ts`（6193 行）里 —— `ResidentRound`(:1830)、`ResidentLedgerDelivery`(:1889，带 `round: ResidentRound` :1943、`leaseId` :1959、`leaseHeld` :1961)、`ResidentLedgerTurn`(:1970)、`ResidentLedger`(:1998) 全是**未导出**的模块私有类型；driver 状态字段 `state.turnLedger`（:2386 声明、:2986 初始化）；对 `turnLedger` 的字段访问 `.turnLedger.<field>` **49** 处（读与写都算）；「关闭 turn 并记 closedTurns」有**三份**拼写：进程退出 :4614、RESULT :4929、`closeLedgerTurnOnly`（:6180，:6186 push，现仅 :6137 一处调用）；「异常记账 + `[reconcile]` 日志」有**三份**：:3187（interrupt-no-result）、:4826（double-init）、:4978。新文件 `server/modules/providers/list/claude/claude-resident-ledger.ts` **不存在** ⇒ 判据必红（`Could not find …`）。

### 机制（本 AC 的 (a)–(h)，SPEC §5.2 / §4.4 / §12 / §14）

新文件 `server/modules/providers/list/claude/claude-resident-ledger.ts` 持有**转移函数与账本类型**，driver 只持实例并转发事件。这是一个**行为等价的重构**（首刀）：

- **(a) 转移表**：SPEC §5.2 的每个事件（send、lifecycle queued/started/completed/cancelled、init、RESULT、interrupt 请求、撤回请求、进程退出、owed 结算、double-init）各有至少一条**表驱动**用例，断言转移后的账本状态与返回值 `{changed, effects}`；effects 用类型表达为**判别联合**，成员不含函数类型，由类型层面的断言核对（不用文本扫描）。转移函数允许在模块内部**原地改账**（账本靠对象同一性工作：`pendingStart.includes(delivery)`、`byUuid` 与 `deliveries` 引用同一对象），**禁止模块外写**。
- **(b) 重复拼写收成一份**：三处「关闭 turn 并记 closedTurns」（:4614 进程退出、:4929 RESULT、`closeLedgerTurnOnly` :6180，后者已是现成 helper 但只有一处调用）收成**同一个转移**，对同一 outcome 产出**逐字相同**的 `closedTurns` 记录；三处「异常记账 + `[reconcile]` 日志」（:3187、:4826、:4978）收成**同一个 `reportAnomaly` effect**。这是首刀。
- **(c) 账本对 driver 不透明**，按**写入目标的类型**而不是文本前缀判定：AST 扫描 `claude-host-driver.provider.ts`，对 `turnLedger` 的字段访问（`<expr>.turnLedger.<field>`，读与写都算）计数为 **0**，账本整体只作为参数传给模块函数——这同时消除**别名写**（立案时 :4925 与 :6180 是 `const turn = state.turnLedger.turn; turn.open = false`，:4707 起是对 `byUuid.get` 取出的 delivery 赋值，都不经 `turnLedger.` 前缀直写，按前缀计数会漏）；模块交给 driver 的账本对象一律是**只读视图类型**，类型层面的夹具用 TypeScript **程序化编译**一段对返回对象赋值的片段，必须得到只读属性诊断（**TS2540**），证明 driver 侧写入是编译错误。
- **(d) 账本类型不夹带 driver 类型**：立案时 `ResidentLedgerDelivery` 带 `round: ResidentRound`（dispatcher 的 round，持有 writer 与 settle）、`leaseId`、`leaseHeld`（该 lease 是否已报给 manager），这些是 driver 记账；须移到 driver 侧按 `commandUuid` 索引的表，或对 round 用泛型/不透明句柄；断言新文件只 import shared（AST），不引用 `ResidentRound`。这是 AC-396「只 import shared」的**前置**，不在本条解决就会在搬迁时才发现。
- **(e) 固定尾巴由 driver 统一 commit**：转移函数返回账本是否变化（`{changed, …}`），driver 在其后**统一**同步 lease 并发布，**不给每个转移单配 effects**；带 await 与定时器的动作（如 :3130 之后的 `stopResidentTurn`、`armInterruptWatchdog`）留在 driver，账本侧只改 `interruptRequested`；需要读 driver 状态的输入（如 `cancelledReason`，:4673）由 driver 先算好作为**事件载荷**传入。
- **(f) 行为等价**由既有的 AC-378（性质测试）、AC-380、AC-381 保护：它们已 achieved，goal-driver 会对 achieved 的 AC 复验，本条**不得让它们变红**；本条判据文件另含一条小型回放：把 SPEC 附录 A 四个场景的帧序列喂给转移函数，终态读数满足 **I1–I6**。
- **(g) 取假形态**：把 RESULT 转移里的 owed 标记去掉 ⇒ (a) 红；把一处账本字段访问重新写回 driver ⇒ (c) 红；让账本类型重新引用 `ResidentRound` ⇒ (d) 红。
- **(h)** 单文件单次运行 **< 40s**。

首个产出是**转移表**（含每个写入点归入哪个转移）；读完 driver 的 :4350 到 :4760 之后若发现某写入点与账本无法分离，须在完成记录里**逐条列出**，不得悄悄保留。

### 落点与 `$backend-module-standards` 的对齐

`$backend-module-standards` 要求「一处使用就地定义、两处及以上使用移入 `server/shared/types.ts`（并分组注释）」「模块私有实现不外泄」「跨模块只经 `index.ts` barrel」。与本 AC「新文件持有账本类型」「新文件只 import shared」一致的落法：**内部**账本类型（`ResidentLedger` / `ResidentLedgerDelivery` / `ResidentLedgerTurn`）只在转移模块内使用 ⇒ 就地留在新文件、不导出；**跨越** driver/模块边界的那部分（driver 持有的不透明句柄 / 模块交给 driver 的只读视图类型，及已存在的 `ClaudeResidentDeliveryState` / `ClaudeResidentDeliveryReason` 一族）按「两处及以上」规则落 `server/shared/types.ts`，与既有 resident-ledger 分组注释相邻。新模块与 driver 同在 `server/modules/providers/` 这一 feature 模块内，兄弟文件互引不违反 barrel 规则。此段是对 AC 文本的一处**对齐说明**（AC 的 (f) 硬约束「只 import shared」与标准的类型放置规则在此汇合）；执行者若找到既满足 (f) 又满足标准的另一落法亦可，但须在完成记录里写明选择。

## AC

- [x] (a) 判据文件存在且 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-ledger-transitions.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行打印**转移表**逐事件读数：SPEC §5.2 的每个事件（send、lifecycle queued/started/completed/cancelled、init、RESULT、interrupt 请求、撤回请求、进程退出、owed 结算、double-init）各有 ≥1 条**表驱动**用例，逐条断言**转移后的账本状态**与返回值 `{changed, effects}`（打印 `event=<…> changed=<bool> effects=<…> state=<…>`）。
- [x] (b) `effects` 的**判别联合**由类型层面的断言核对（不用文本扫描）：每个 effect 成员的类型不是函数类型，且把函数赋给任一 effect 成员须得到类型错误（程序化编译或类型夹具断言，逐条打印被检成员与结果）。
- [x] (c) 三处「关闭 turn 并记 closedTurns」（driver :4614 进程退出、:4929 RESULT、:6180 `closeLedgerTurnOnly`）在 `git diff` 里收成**同一个转移**，对同一 outcome 产出**逐字相同**的 `closedTurns` 记录（打印三处归一后的 `closedTurns` 逐字读数，三条路径对同一 outcome 必须一致）；三处「异常记账 + `[reconcile]` 日志」（:3187、:4826、:4978）收成**同一个 `reportAnomaly` effect**（判据打印该 effect 的形状与逐个站点归一读数）。这是首刀。
- [x] (d) AST 扫描 `server/modules/providers/list/claude/claude-host-driver.provider.ts`：对 `turnLedger` 的字段访问（`<expr>.turnLedger.<field>`，读与写都算）计数 = **0**（立案时 49，判据打印 `turnLedgerFieldAccesses=0`）；账本整体只作为参数传给模块函数；别名写（`const turn = state.turnLedger.turn; turn.open = false`、对 `byUuid.get` 取出的 delivery 赋值）一并消除（判据同时断言 driver 内不再出现对账本对象成员的赋值）。
- [x] (e) 模块交给 driver 的账本对象一律是**只读视图类型**：类型层面的夹具用 TypeScript **程序化编译**（`typescript` 已在依赖 `^5.9.3`，`ts.createProgram`/`transpileModule` 一类，参照 `server/modules/websocket/tests/chat-control-wiring.test.ts` 的 `ts.createSourceFile` 用法）一段对返回对象赋值的片段，必须得到只读属性诊断 **TS2540**（判据打印诊断码 2540）。这证明 driver 侧写入是编译错误。
- [x] (f) 账本类型不夹带 driver 类型：`ResidentLedgerDelivery` 不再带 `round: ResidentRound`、`leaseId`、`leaseHeld`（移到 driver 侧按 `commandUuid` 索引的表，或对 round 用泛型/不透明句柄）；AST 断言新文件 `claude-resident-ledger.ts` **只 import shared**、不引用 `ResidentRound`（判据打印新文件的 import 源清单与 `referencesResidentRound=false`）。
- [x] (g) 固定尾巴由 driver 统一 commit：转移函数返回账本是否变化，driver 在其后**统一**同步 lease 并发布，**不给每个转移单配 effects**（判据或 `git diff` 审读证明 effects 集合不含逐转移的 lease/publish 尾巴）；带 await 与定时器的动作（`stopResidentTurn`、`armInterruptWatchdog`，driver :3130 之后）留在 driver，账本侧只改 `interruptRequested`；需要读 driver 状态的输入（如 `cancelledReason`，:4673）由 driver 先算好作为**事件载荷**传入。
- [x] (h) 判据文件另含一条小型回放：把 SPEC 附录 A 四个场景（S1 idle cold、S2 later 两条、S3 next 折叠、S4 interrupt）的帧序列喂给**转移函数**，终态读数满足 **I1–I6**（逐条打印 I1…I6 的读数）。
- [x] (i) 不使既有 achieved 判据变红：`server/modules/providers/tests/claude-resident-ledger-invariants.test.ts`(AC-378)、`claude-resident-interrupt-ledger.test.ts`(AC-380)、`claude-resident-unattended-after-turns.test.ts`(AC-381) 各自单跑退出 **0**，且三者在 `git diff --name-only` 里不出现。
- [x] (j) 三处取假形态可复现（判据文件一字不动，改实现后重跑，红必须落在指定腿上）：(i) 把 RESULT 转移里的 owed 标记去掉 ⇒ (a) 红；(ii) 把一处账本字段访问重新写回 driver ⇒ (d) 红（`turnLedgerFieldAccesses>0`）；(iii) 让账本类型重新引用 `ResidentRound` ⇒ (f) 红。逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含这些临时代码。
- [x] (k) 该判据文件单次运行墙钟 **< 40s**（SPEC §11）：每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫用 `exit 3`（进程级杀，不是单用例失败）。
- [x] (l) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin 各 +1 并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (m) 遵守 `$backend-module-standards`：判据落 `server/modules/providers/tests/`、跨模块只经 `index.ts` barrel、无 `any`；跨越模块边界的账本类型按「两处及以上使用」规则落 `server/shared/types.ts` 并分组注释；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/modules/providers/tests/claude-resident-ledger-transitions.test.ts`——它直接驱动**提取出来的转移函数**（不再经 driver 私有账本），逐事件断言转移后的账本状态与 `{changed, effects}`；effects 的判别联合由类型层面断言核对、且不含函数类型；e 腿程序化编译得到 TS2540；d/f 腿用 AST 扫描（`turnLedger` 字段访问 = 0、新文件只 import shared 且不引用 `ResidentRound`）；h 腿把 SPEC 附录 A 的四个场景帧序列喂进转移函数、终态满足 I1–I6；j 腿三处取假形态各自把指定腿打红、还原后恢复绿——即红的是读数本身，判据有洞会被看见。首个产出是**转移表**（含每个写入点归入哪个转移）并抄进完成记录；读完 driver :4350 到 :4760 之后，若有写入点与账本无法分离，**逐条列出**在完成记录里，不得悄悄保留。`git diff` 只含：新模块 `claude-resident-ledger.ts`、driver 的收口改动、这一个新判据文件（及其类型层面夹具，若另起文件）、`server/shared/types.ts`（若跨边界类型落此）、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/list/claude/claude-resident-ledger.ts` （**新**：账本类型 + 转移函数，返回 `{changed, effects}`；模块内原地改账；对 driver 暴露只读视图 / 不透明句柄；`effects` 为判别联合、不含函数类型）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （移除内联账本转移逻辑与私有账本类型的字段访问；只持实例并转发事件；driver 侧按 `commandUuid` 索引 round/lease 记账；固定尾巴统一 commit）
- `server/modules/providers/tests/claude-resident-ledger-transitions.test.ts` （**新**：AC-395 判据文件——表驱动转移用例、effects 类型断言、只读视图 TS2540 夹具、AST 扫描、SPEC 附录 A 回放、三处取假形态）
- `server/shared/types.ts` （跨越模块边界的账本类型 / 只读视图 / 不透明句柄按「两处及以上使用」规则落此并分组注释；若执行者选用使新模块仅就地定义的等价落法则改列该模块）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac395-ledger-transitions-extraction.md` （自触）
