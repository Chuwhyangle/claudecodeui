---
id: gap-claude-host-driver-lifecycle-extension-point
title: ClaudeResidentHostDriver 第二刀：run/turn 结局处理与通知改成可注册扩展点（react
  侧镜像第一刀，handler 从同目录兄弟文件注册 + 负对照判据），driver 只留派发骨架
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD c0ef2d4b3919）**：机制词 grep `grep -rlE 'outcome.?handler|结局处理|派发执行|第二刀|lifecycle.?handler|ClaudeResidentOutcomeRegistry' tasks/*.md` → 命中 3，逐条读：`gap-claude-host-driver-extension-point`（done）是本条的**直接前身**——它只拆了**读数**（read-only，`ClaudeResidentOutcomeName` 全是 `*Reading`/`liveState`/`ledgerState`）；`gap-chat-settings-composer-transcript-cycles` 与 `gap-cloudcli-quay-snapshot-inflight-tasks` 均不认领此机制。故「把 driver 的**结局处理/通知（write/react 侧）**也做成可注册扩展点」这一机制无人认领。合并候选（granularity-advice `--touches claude-host-driver.provider.ts --touches claude-resident-outcome-handlers.ts`）报 `peers: []` ⇒ **separate**。

### 现状（立案时实测，2026-10-22，HEAD c0ef2d4b3919）

- 第一刀落地后：driver **6559 行**、`ClaudeResidentHostDriver` **88 方法 / outDegree 203 / dependentCount 131**（archguard 新鲜读数，server scope 三榜第一）。
- 第一刀把**读数**（read-only）迁成了 `ClaudeResidentOutcomeRegistry` 的注册 handler；但 **write/react 侧仍在类内联**：run/turn 结局处理（settle / fail / withdraw / close / dropRound / endWithdrawnRun / finishUnattendedTurn / abandonUnattendedTurn …）、reconcile beat 与 held-work 观察（armReconcileBeat / reconcileTick / reconcileHeldWork / observeHeldWorkEvent / inferHeldWork / settleCrons / settleBackgroundTasks）、title-mirror 通知（startIdentityReadback / publishIdentity / refreshIdentityAfterRename / stopTitleMirror / scheduleTitleMirror / mirrorResidentTitle …）与日志/流（writeLogLine / writeReconcileLine / emitLedgerLines / recordQueueFacts …）。
- 这正是 Quay GOAL-909 之后的同款未完项：**状态归属解决了，但派发决策和派发执行两块编排职责还没拆**（runResidentLoop call 出度仍 84）。本类的 react 侧就是那块「派发执行」。
- perFile：driver **45 个已落地任务**碰过，中位每任务改 **101 行**、中位 2 轮。

### 改法

第二刀镜像第一刀：给 run/turn 的**结局处理与通知**（react 侧）引入第二个可注册扩展点（outcome/event handler：name + source + handle(context, …)），handler 落在 driver **同目录**兄弟文件、从 driver 之外注册；driver 的公开方法签名不变，方法体改为薄委托/派发。**行为保持**：不改变任何行为判据。

⛔ 范围护栏同第一刀：新文件一律落在 `server/modules/providers/list/claude/` 同目录，**不新建 `server/modules/**` 目录**（避免 AC-394 目录棘轮）。context 视图沿用第一刀纪律：只给 handler 一个窄只读视图，不得让它闭包到 driver 私有。

<!-- dedup-ref --> 相关但不同机制：`gap-claude-host-driver-extension-point`（done）是本条**直接前身**（拆读数/read-only），本条拆的是它的**补集**（write/react 侧结局与通知），机制不同、验收独立，不构成前置（本条的基线读数在第一刀已落地之后）。`gap-mcp-gateway-tool-registration-extract`（superseded）与 `gap-ac396-ledger-leaf-module`（done）同第一刀引述，仍仅作护栏/样板，均不构成本条前置。

## Plan

1. **盘点**：列出 driver 内全部 write/react 侧方法（run/turn 结局、reconcile、title-mirror、日志/流），按事件域分组，记录公开签名与调用方。
2. **定义第二个扩展点**：name union（闭集）+ 窄只读 context 视图 + register/unregister/dispatch（镜像 `ClaudeResidentOutcomeRegistry` 纪律：未注册返回 null 不抛）。
3. **迁 handler**：把 react 侧方法体**逐字**迁到兄弟 handler 文件，装配处注册；driver 公开方法改薄委托。纯位移、语义一行不改。
4. **判据**：正臂（从非 driver 文件注册的 handler 在对应结局上被触发）、负臂（未注册不触发 + 内存注入形态打红同一条断言函数）、行为保持 spot 断言。
5. **收口**：既有 resident 判据单跑仍绿、tsc/lint、collateral、centralΔ 基线（`centralΔ/(centralΔ+nonCentralΔ)`）。

## AC

- [ ] (a) **扩展点存在且 driver 经它分派**：`test -f server/modules/providers/list/claude/claude-resident-lifecycle-outcome-registry.ts` 退出 0；`grep -q "claude-resident-lifecycle-outcome-registry" server/modules/providers/list/claude/claude-host-driver.provider.ts` 退出 0。
- [ ] (b) **判据存在且跑通（正臂）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-lifecycle-outcome-registry.test.ts` 退出 0；其打印读数显示「注册自非 `claude-host-driver.provider.ts` 文件的 handler 在对应 run/turn 结局上被触发」。
- [ ] (c) **负对照**：同一判据含「未注册的 handler 不被触发」断言，且该断言在内存注入形态下打红同一条断言函数（判据单跑自动执行并打印读数）。
- [ ] (d) **中心文件瘦身 + 静态门**：`test "$(wc -l < server/modules/providers/list/claude/claude-host-driver.provider.ts)" -lt 6559` 退出 0（基线=立案实测 6559）；`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **既有行为判据不改一字仍绿**：四个文件各自单跑、各自退出 0（命令一律 `npx tsx --tsconfig server/tsconfig.json --test <file>`）：`server/modules/providers/tests/claude-resident-outcome-registry.test.ts`、`claude-resident-reconcile.test.ts`、`claude-resident-busy-input.test.ts`、`claude-resident-idle.test.ts`。
- [ ] (f) **collateral**：新增一个 `server/**/*.test.ts` ⇒ 先复量 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（执行时以实测为准），按 `server/shared/tests/quay-test-script.test.ts` 两条计数 pin 各 +1 并改写其上方注释算术；`scripts/suite-duration-baseline.tsv` 仅当 AC7 覆盖率地板跌破 90% 才追加一行；单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [ ] (g) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列。

## DoD

真实落地的标准是「一个新的 run/turn 结局 handler 真的**从 driver 文件之外注册并生效**，未注册的不触发，既有行为不变」，不是「多了两个文件」。必须贴出：①(b) 判据打印的原样输出；②正臂与负臂两臂的逐字读数（负臂=未注册不触发 + 内存注入形态打红的红读数与还原后绿读数）；③(e) 四条判据各自单跑的退出码；④(d) 的 `wc -l` 前后读数与 typecheck / lint 退出码；⑤迁移是**纯位移**的核对（driver 侧仅方法体改薄委托、公开签名未动；若发现某段逻辑无法原样迁——隐式依赖 driver 的私有类型/闭包/模块级状态——逐条列出，不得悄悄改写语义）；⑥`git diff` 只含 `## Touches` 所列文件。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（react 侧方法改薄委托，公开签名不变）
- `server/modules/providers/list/claude/claude-resident-lifecycle-outcome-registry.ts` (new)（第二个扩展点：name union + context 视图 + register/unregister/dispatch）
- `server/modules/providers/list/claude/claude-resident-lifecycle-outcome-handlers.ts` (new)（迁出的 react 侧 handler，装配处注册）
- `server/modules/providers/tests/claude-resident-lifecycle-outcome-registry.test.ts` (new)（判据：正臂 + 负对照 + 行为保持）
- `server/shared/tests/quay-test-script.test.ts`（collateral：两条计数 pin 各 +1 及注释算术）
- `scripts/suite-duration-baseline.tsv`（collateral：仅当覆盖率地板跌破 90%）
- `tasks/gap-claude-host-driver-lifecycle-extension-point.md`（自触）
