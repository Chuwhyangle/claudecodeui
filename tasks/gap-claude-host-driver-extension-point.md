---
id: gap-claude-host-driver-extension-point
title: ClaudeResidentHostDriver 扩展点重构：读数/结局处理改成同目录可注册分派（registry + 兄弟文件 +
  负对照判据），driver 只留薄委托
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：机制词 grep（按机制而非症状）`grep -rlE 'registerOutcomeHandler|可注册分派|扩展点|extension point|outcome.?handler|读数处理器' tasks/*.md` → **0** 命中；`grep -rl 'ClaudeResidentHostDriver' tasks/*.md` → 21 命中，逐条读过，全是该类的**行为/缺陷**任务（控制队列、对账、unattended、ledger 等，均已 done/superseded），无一认领「把该类的读数/结局处理做成可注册分派（扩展点）」这一机制。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.22.0/scripts/dist/task-granularity-advice.js --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --json`）报 `peers: []`（无任何 open 的 todo/ready 任务在 Touches 里声明该文件）⇒ 判定 **separate**，无 peer 可合并。

### 现状（立案时实测，2026-10-22）

- `server/modules/providers/list/claude/claude-host-driver.provider.ts` = **6662 行**；`ClaudeResidentHostDriver` 类从 3008 行到文件末尾（约 3650 行），方法 ≥ 66（本会话保守计数：constructor + public + private + 箭头属性；F6 架构校准报告 2026-10-20 记 87 方法、`primaryOwnerShare 0.81`、`busFactor 1`）。
- 其中约 20 个是「读数/结局处理」方法：`unattendedReading / busyInputReading / ledgerReading / queuedInputUuid / pendingQueuedInputs / startedQueuedCommands / runInFlight / lifecycleReading / permissionReading / remoteControlRefusal / liveStateFor / ledgerStateFor …`，全部内联在该类里。
- granularity-advice `perFile`：**44 个已落地任务**碰过这个文件，中位每任务改它 **94 行**、中位 **2 轮**——典型「增量流回中心文件」的再加工磁石。
- 这对应 Quay 的 worker-driver 失败形态（`runResidentLoop` call 出度 84、状态散在闭包；「只抽区域、不规定新代码落点 ⇒ 82% 增量流回中心文件」）。本类目前**没有**注册/分派出口：新增任何一个 resident 行为 = 往这个类上加方法。

### 改法

给 `ClaudeResidentHostDriver` 引入一个有界注册表/分派层（Quay GOAL-909 的 `registerOutcomeHandler` 同款）：读数与结局处理改成**可注册处理器**，driver 只保留公开方法签名（`IProviderHostDriver` 契约不变），方法体改为经 registry 薄委托；处理器本体迁到 driver **同目录**的兄弟文件，从 driver 文件之外注册并生效。**行为保持**：这是一次不改变任何行为判据的重构（改动前现存的 resident 判据必须原样仍绿）。

⛔ **范围护栏（避免重蹈 mcp-gateway 覆辙）**：新文件一律落在 `server/modules/providers/list/claude/` 同目录（兄弟文件），**不新建 `server/modules/**` 目录**。`gap-mcp-gateway-tool-registration-extract`（superseded）证明过：拆出新子包会被 AC-394 的目录棘轮判「进入 11 成员 SCC / 新目录非叶子」而 revert。本条走「同目录兄弟文件」即可拿到「从中心文件之外注册」的全部结构收益，而不触碰 AC-394 的 `directoryManifest` 与 `cycleGroups` 基线。

<!-- dedup-ref --> 相关但不同机制：`gap-mcp-gateway-tool-registration-extract`（superseded，2026-10-20）是把 mcp-gateway 的读/写工具注册拆成**子包**（最终因 AC-394 棘轮 revert），与本条「同目录注册表 + 兄弟文件」不是同一机制，其教训作为本条的范围护栏而非前置；`gap-ac396-ledger-leaf-module`（done）是把账本搬成**叶子模块**（搬家的「叶子 + barrel-only + 纯位移 + 取假形态」纪律是本条的样板，但机制不同：它搬的是数据与转移函数，本条拆的是分派）。两者均不构成本条的前置依赖。

## Plan

1. **盘点**：列出 driver 内全部读数/结局处理方法，按读数域分组（ledger / queue / lifecycle / permission / remote-control / title-mirror …），记录每个的公开签名与调用方（确认只改方法体、不动签名）。
2. **定义 registry**：`claude-resident-outcome-registry.ts` 暴露 register / unregister / dispatch + 默认分派路径；默认路径逐字保持现有行为（行为等价由 (e) 的既有判据保护）。
3. **迁处理器**：把读数/结局逻辑整体迁到 `claude-resident-outcome-handlers.ts`（兄弟文件），在装配处注册；driver 公开方法改为薄委托。迁移是**纯位移**：语义一行不改。
4. **判据**：写 `claude-resident-outcome-registry.test.ts`——正臂（从非 driver 文件注册的处理器在对应结局上被触发）、负臂（未注册的处理器不被触发，内存注入形态打红同一条断言函数）、行为保持（对既有读数的 spot 断言）。
5. **收口**：跑 (e) 的既有判据、(d) 的静态门、(f) 的 collateral，记录 centralΔ 基线（`centralΔ/(centralΔ+nonCentralΔ)`，供后续轮次判定增量是否流回中心文件）。

## AC

- [ ] (a) **扩展点存在且 driver 经它分派**：`test -f server/modules/providers/list/claude/claude-resident-outcome-registry.ts` 退出 0；`grep -q "claude-resident-outcome-registry" server/modules/providers/list/claude/claude-host-driver.provider.ts` 退出 0。
- [ ] (b) **判据存在且跑通（正臂）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-outcome-registry.test.ts` 退出 0；其打印读数显示「注册自非 `claude-host-driver.provider.ts` 文件的处理器在对应结局/读数上被触发」（handler 来源路径 ≠ driver 路径）。
- [ ] (c) **负对照**：同一判据含「未注册的处理器不被触发」断言，且该断言在内存注入形态下打红同一条断言函数（判据单跑自动执行并打印读数；grep 判据文件可见该负对照断言函数）。
- [ ] (d) **中心文件瘦身 + 静态门**：`test "$(wc -l < server/modules/providers/list/claude/claude-host-driver.provider.ts)" -lt 6662` 退出 0（基线=立案实测 6662）；`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **既有行为判据不改一字仍绿**：三个文件各自单跑、各自退出 0（命令一律 `npx tsx --tsconfig server/tsconfig.json --test <file>`）：`server/modules/providers/tests/claude-resident-reconcile.test.ts`、`server/modules/providers/tests/claude-resident-busy-input.test.ts`、`server/modules/providers/tests/claude-resident-idle.test.ts`。
- [ ] (f) **collateral**：新增一个 `server/**/*.test.ts` ⇒ 先复量 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（执行时以实测为准），按 `server/shared/tests/quay-test-script.test.ts` 两条计数 pin 各 +1 并改写其上方注释算术；`scripts/suite-duration-baseline.tsv` 仅当 AC7 覆盖率地板跌破 90% 才追加一行；单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [ ] (g) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列。

## DoD

真实落地的标准是「一个新的读数/结局处理器真的**从 driver 文件之外注册并生效**，未注册的不触发，既有读数行为不变」，不是「多了两个文件」。必须贴出：①(b) 判据打印的原样输出（handler 来源路径、注册名、是否触发）；②正臂与负臂两臂的逐字读数（负臂=未注册不触发 + 内存注入形态打红的红读数与还原后绿读数）；③(e) 三条既有判据各自单跑的退出码；④(d) 的 `wc -l` 前后读数与 typecheck / lint 退出码；⑤迁移是**纯位移**的核对（driver 侧仅方法体改为薄委托、公开签名一字未动；若发现某段逻辑无法原样迁——隐式依赖 driver 的私有类型/闭包/模块级状态——逐条列出，不得悄悄改写语义）；⑥`git diff` 只含 `## Touches` 所列文件。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（读数/结局处理方法改为经 registry 薄委托，公开签名不变）
- `server/modules/providers/list/claude/claude-resident-outcome-registry.ts` (new)（注册/注销/分派接口 + 默认分派路径）
- `server/modules/providers/list/claude/claude-resident-outcome-handlers.ts` (new)（从 driver 迁出的读数/结局处理器，装配处注册）
- `server/modules/providers/tests/claude-resident-outcome-registry.test.ts` (new)（本条判据：正臂 + 负对照 + 行为保持 spot 断言）
- `server/shared/tests/quay-test-script.test.ts`（collateral：两条计数 pin 各 +1 及注释算术）
- `scripts/suite-duration-baseline.tsv`（collateral：仅当覆盖率地板跌破 90%）
- `tasks/gap-claude-host-driver-extension-point.md`（自触）
