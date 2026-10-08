---
id: gap-ac187-criterion-stability-window-straddles-tool-phase-boundary
title: AC-187 判据稳定窗口只有 ~1s 余量、跨过 tool→writing 真实阶段边界而在车道载荷下假红（同 tree 一绿一红；7 读数中第
  7 个已 writing）——给 tool 阶段平台可证余量使其稳定跑绿，读数一条不动
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-187
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测）。`grep -rn "^goal_ac: *AC-187" tasks/*.md` 逐字只命中一条 `tasks/gap-activity-dock-phase-truthful.md`，其 `status:` 逐字为 `done` —— 按规则 done 不是重复，而是「上一次的修法没兜住」的证据：它把坞做成阶段真值（读数今天确实对），但它的判据把「同一阶段 6 秒不轮换」这条读数压在一个**只有 ~1s 余量**的窗口里，车道载荷下窗口尾部越界到真实的下一个阶段，判据假红。在飞扫描（`^status:` ∈ {todo,ready,needs-human} 且 `^goal_ac: *AC-187`）⇒ **0 命中**。同文件上另有一条在飞任务 `gap-ac188-case-bootstrap-collision-and-gate-kill`（`status: ready`，`goal_ac: AC-188`），它的机制是**夹具账号/bootstrap**（单用户服务端抢槽 + setup 无重试），与本条的**阶段平台余量**是不同机制、独立验收 —— **kept separate**（本条只动 `PHASE_SCENARIO` 的 `at` 时间轴与必要时的用例体预算读数，不碰 `createAccount`/`armScenario`）。`node /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/scripts/dist/task-granularity-advice.js --touches e2e/activity-dock-truthful.spec.ts --json` → `peers: []`、`mentions: []`（该工具把测试文件排除在重叠判定外）；文件历史热度：`nLanded=10`、`medianChangedLines=674`、`medianFileChangedLines=144.5`、`medianExecutions=2`。

**判据物（逐字取自 goal 记录 AC-187）。** `criterion:` = `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-187"`。`expect:` 逐字：「调试 agent 场景依次进入 thinking、tool（Bash）、writing、idle… 读数：坞文案依次是对应阶段的本地化文案，tool 阶段含工具名 Bash；同一阶段内连续 6 秒每秒读一次，文案恒相等（不轮换）；回合结束坞收起。取假形态：改回按已用时间轮换的词表 ⇒ 稳定性读数必须红。」

**本轮直接测量。** branch `author`，HEAD `22fa61ca`，宿主安静（load1≈13）：`bash scripts/with-memory-cap.sh npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-187"` → **EXIT=0**，`1 passed (26.1s)`，case body `dock.wall=15555ms`；读数逐字 `dock.phase.thinking={"state":"in-turn","phase":"thinking","label":"Thinking"}`、`dock.phase.tool={"state":"in-turn","phase":"tool","label":"Running Bash"}`、`dock.stable.samples=["Running Bash"×7]`、`dock.phase.writing={"phase":"writing","label":"Writing"}`、`dock.afterTurn=absent`。⇒ 担保（阶段真值 + 阶段内不轮换）今天**成立**，安静臂判据绿。

**driver 的台账尾巴红是真实断言红（不是引导假红），从失败现场逐字读出。** `gate-events.jsonl` 里 AC-187 自 2026-10-08T18:00Z 起 5 pass / 2 fail：`18:10:33Z` goal-sweep fail（tree `4b1c2e1`，`reason` 以 `Error: Timed out waiting 30000ms from config.webServer.` 结尾 —— 引导假红，`ab264446` 已把 `WEB_SERVER_TIMEOUT_MS` 抬到 `35_000`）；`18:29:11Z` goal-cli fail（tree `f2f4afee`，**与 18:25:42Z 的 pass 是同一个 tree**）—— 这次不是引导：驱动留下的失败现场 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-dfQ2K9/test-results/activity-dock-truthful-act-13da4--holds-still-inside-a-phase/error-context.md` 逐字写着

```
Error: every reading lands in the tool phase; phases were ["tool","tool","tool","tool","tool","tool","writing"]
```

即稳定窗口取了 7 个读数（初始 1 + 每秒 6），**前 6 个是 `tool`、第 7 个已是 `writing`** —— 一条落点明确的断言红（同次 `watchdog-state.json` 逐字 `{"armed":true,"fired":false,"ceilingMs":55000}`、`test-results/.last-run.json` `status: failed`，排除整轮墙钟击杀与引导超时）。

**机制：tool 阶段平台只有 7.0s，而判据要一个 6.0s 窗口整段落在其中，余量 ≈ 1s。** `PHASE_SCENARIO` 的 `{ at: 5_000, op: 'tool-call' }` → `{ at: 12_000, op: 'tool-result' }`，tool 阶段平台 = **7_000ms**。判据先 `expect(page.locator(DOCK)).toHaveAttribute('data-activity-phase','tool')` 读到初始读数 t0（t0 ≥ 5000ms，含订阅/轮询的检测延迟），再 `for step 1..6 { waitForTimeout(1000); read }` ⇒ 最后一个读数落在 `t0 + 6_000`。要求 7 个读数全为 `tool`，等价于 `t0 + 6000 < 12000` ⇒ **`t0 < 6000ms`**，即「检测到 tool 阶段的时刻」必须落在 5.0–6.0s 这 **1.0s** 里。安静臂 t0≈5.1–5.3s（余量 ~0.8–0.9s），车道载荷下 `toHaveAttribute` 轮询 + `fireClock` 起始漂移把这 1s 吃掉 ⇒ 第 7 个读数越界到 `writing`。**这不是「坞在轮换」**（前 6 个读数逐字相等 `Running Bash`，第 7 个是阶段**真的**变了）—— 是判据自己的稳定性窗口跨过了一条真实阶段边界（同族形态见 `criterion-fixed-plateau-vs-its-own-guard-deadline`）。

**要做的事（最小充分，只加余量、不弱化读数）。** 让 `-g "AC-187"` 这一条判据在复现红的车道载荷下**稳定**跑绿，判据命令与三组读数一字不动：

- **(a) 给 tool 阶段平台可证余量**：把 `PHASE_SCENARIO` 的 `tool-result` 及其后 `text-delta`/`turn-result`/`turn-end` 的 `at` 整体后移，使平台长度 `tool-result.at − tool-call.at ≥ 9000ms`（即 6.0s 窗口之外留 ≥3.0s，容下检测延迟）；thinking 段与 `tool-call` 起点（`at: 5_000`）不动，阶段序不变。逐字给出「平台长度 − 6000 = 余量」的算术链（改前 `7000−6000=1000`；改后 `≥9000−6000≥3000`）。
- **(b) 必要时重标用例体预算读数**：判据的 case body 预算 `expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(20_000)`（spec `:1806`）是本 spec 自加的保护读数，AC 的 `expect:` **没有**点名任何墙钟界 —— 若后移平台使 case body 逼近 20s，按其**新的结构下界**重标该读数（并打印改前/改后的实测 `dock.wall`），**不是**删掉它。
- 保持整次调用在 `SINGLE_SPEC_CEILING_MS`（`playwright.config.ts`，55s）与 goal gate 的 60s 击杀之内。

**非目标。** 不改 AC-187 的 `criterion:` / `expect:`（`git diff -- goals/` 必须为空）；不缩短 6 秒窗口；不放松 `expect(new Set(phases)).toEqual(new Set(['tool']))` / `expect(new Set(labels)).toEqual(new Set([expectedTool]))` / `spanMs ≥ 5000` / `samples.length ≥ 6` 任何一条；不碰活动坞的生产实现（`src/modules/chat/**` 的文案/阶段来源）；不碰 `gap-ac188-…` 的夹具账号与重试面。

## Plan

1. 建隔离 worktree（起点 = 开工时 `develop`），打印路径 / `git rev-parse HEAD` / `HEAD^{tree}`，`git status --porcelain` 空。
2. 安静臂基线：出货命令逐字跑 ≥3 次，全部 exit 0，登记每次 `dock.wall` / 整次墙钟 / 逐字 `dock.stable.samples`。
3. 定位余量：读 `PHASE_SCENARIO`（`e2e/activity-dock-truthful.spec.ts` 约 `:1661`），打印 `tool-result.at − tool-call.at` 与减去 6000 的余量；贴出失败现场 `error-context.md` 的逐字断言与 `watchdog-state.json`。
4. 实施 (a)：锚定编辑 `PHASE_SCENARIO` 的 `at` 值，使平台 ≥9000ms 且阶段序 `thinking→tool→writing→idle` 不变；跑 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-187"` 确认安静臂绿、读数逐字不变。
5. 载荷臂：用能复现红的并发构造（≥28 路兄弟 `npx playwright test` 车道，参照 `gap-ac179-criterion-boot-timeout-under-lane-load` 与 `gap-ac194-criterion-wallclock-load-scaled-fixed-cost` 的构造）重跑 ≥2 次，全部 exit 0；入档 `load1`、每次整次墙钟、`dock.stable.phases` 恒为 `["tool"×7]`。
6. 假形态仍在（承重）：(i) 把 `ActivityIndicator` 的 `label` 改回按已用时间轮换 ⇒ 稳定性读数必须红；(ii) 把阶段来源改回本地 `statusText`/本地时钟 ⇒ `tool` 阶段 `Bash` 读数必须红。逐条 `git checkout -- <file>` 恢复并登记变异 diff / 逐字失败行 / 恢复命令。
7. 若第 5 步在复现红的负载下仍无法稳定跑绿：停手、置 `needs-human`，附逐字读数与已排除项；⛔ 不把安静通过写成「已修」。
8. `npm run lint` / `npm run typecheck` 绿；`git diff --name-only <base>..HEAD` 落在 `## Touches` 内；写完成记录。

## AC

- [x] AC1 红态分类机械入档：贴出 `gate-events.jsonl` 的 `2026-10-08T18:29:11Z` goal-cli fail（tree `f2f4afee`）与同 tree `18:25:42Z` pass 的逐字两条，以及失败现场 `error-context.md` 的逐字断言 `phases were ["tool"×6,"writing"]`、`watchdog-state.json`（`armed:true, fired:false`）；据此证明红落在**稳定窗口越界**，不在引导、不在整轮墙钟。
- [x] AC2 安静臂基线：净 worktree 上出货命令逐字跑 ≥3 次，全部 exit 0；入档每次 `dock.wall` / 整次墙钟 / 逐字 `dock.stable.samples`（含 ≥6 个相等的 `Running Bash` 读数）。
- [x] AC3 余量算术（承重）：打印改前 `tool-result.at − tool-call.at`（=7000）与 `−6000` 的余量（=1000），与改后（平台 ≥9000、余量 ≥3000）逐字对照；证明阶段序 `thinking→tool→writing→idle` 未变（`--list` 与逐字读数）。
- [x] AC4 载荷臂稳定绿：在能复现红的车道载荷（≥28 路兄弟 e2e 车道）下出货命令跑 ≥2 次，全部 exit 0；入档 `load1`、每次整次墙钟、逐字 `dock.stable.phases`（恒 `["tool"×7]`）与 `dock.stable.samples`。
- [x] AC5 读数未弱化：`git diff <base>..HEAD -- goals/` 为空（`criterion:`/`expect:` 逐字未改）；`npx playwright test e2e/activity-dock-truthful.spec.ts --list` exit 0 且 AC-187 用例标题逐字未变；`every reading lands in the tool phase` / `the label must not rotate while the phase holds` / `spanMs` 的 ≥5000 断言 / `at least six readings` 四条断言文本逐字保留；若重标了 case body 预算，贴出改前/改后该值、实测 `dock.wall` 与它新的结构下界。
- [x] AC6 假形态仍红（承重）：(i) `label` 改回按已用时间轮换 ⇒ 稳定性读数红；(ii) 阶段来源改回本地 `statusText`/本地时钟 ⇒ `Bash` 读数红。逐条登记变异 diff、逐字失败行与恢复命令。
- [x] AC7 契约面：`npm run lint` 退出 0；`npm run typecheck` 退出 0；`git diff --name-only <base>..HEAD` 全部落在 `## Touches` 内。

## DoD

- 判据驱动的是**真实服务端、真实应用、真实调试 agent 回合**：读数来自 `npx playwright test` 起的真实 webServer + Vite 客户端 + 调试 agent 场景；不接受 spec 自写 DOM、不接受 stub 掉 socket、不接受把坞读数换成读某个内部 React state。
- **只加余量、不弱化读数**：稳定窗口仍是「同一阶段内连续 6 秒每秒读一次」（≥6 个读数、跨度 ≥5000ms），`phases` 集合必须恰为 `{tool}`、`labels` 必须恰为 `{locale 的 tool 文案含 Bash}`；判据的 `criterion:`/`expect:` 一字未动（`git diff -- goals/` 空）。
- 余量来自**场景夹具的阶段平台**（`PHASE_SCENARIO` 的 `at` 时间轴），不是缩短窗口、不是把部分读数排除、不是把断言从「全等」降级为「无相邻轮换」。
- 两个假形态（按时间轮换 / 本地时钟来源）都**仍然红** —— 证明这条读数仍有承重。
- 不改变调试 agent 的方言行语义与既有 op 语义；`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts` 保持绿。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件（例如必须动 `src/modules/chat/**` 才够），先把该文件加进 `## Touches` 再写，并在完成记录里说明为什么。
- 遵守仓库既有 e2e 约定（`playwright.config.ts` 的整轮墙钟/守卫与 `DEBUG_AGENT_SPEC_FILES` 登记均不改动）。

## Touches

- e2e/activity-dock-truthful.spec.ts
- tasks/gap-ac187-criterion-stability-window-straddles-tool-phase-boundary.md（自触：本任务状态翻转的记录）

## 完成记录

实现 commit：`cb5b7c5a`（`e2e/activity-dock-truthful.spec.ts`，+24/−6）。起点 base = `develop`@`2d1273b7`（tree `aec9fba5c3c4f769513a1b6f0c377d0a7ab33e98`）。AC6 的变异与一切临时改动均以 `git checkout -- <file>` 复原；收尾时工作树只含本 spec。

### AC1 红态分类（稳定窗口越界，非引导、非整轮墙钟击杀）

`gate-events.jsonl` 逐字两条，**同一 tree** `f2f4afee9bb6af65d27a4c0b7d6b92c43a09343e`：

- goal-cli **pass** `2026-10-08T18:25:42.459Z`
- goal-cli **fail** `2026-10-08T18:29:11.648Z`（reason = acceptance failed，exit 1）

失败现场 `test-results/activity-dock-truthful-act-13da4--holds-still-inside-a-phase/error-context.md` 逐字：

```
Error: every reading lands in the tool phase; phases were ["tool","tool","tool","tool","tool","tool","writing"]
```

同次 `watchdog-state.json` 逐字 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`；`test-results/.last-run.json` `status: failed`。⇒ 同 tree 一绿一红，红落在稳定窗口第 7 个读数越界到真实的 `tool`→`writing` 边界，**不在引导**（watchdog 未 fire）、**不在整轮墙钟**。

### AC2 安静臂基线（净 worktree，出货命令逐字）

改前（base tree）逐字跑 3 次，全 exit 0：`dock.wall` = **15578 / 15491 / 15730** ms；每次 `dock.stable.samples=["Running Bash"×7]`、`dock.stable.phases=["tool"×7]`。

改后逐字跑 3 次，全 exit 0：`dock.wall` = **18395 / 17700 / 17512** ms；读数逐字不变（`["Running Bash"×7]` / `["tool"×7]`）。

### AC3 余量算术（承重）

- 改前：`tool-result.at − tool-call.at` = 12_000 − 5_000 = **7000**；余量 = 7000 − 6000 = **1000**。
- 改后：14_000 − 5_000 = **9000**；余量 = 9000 − 6000 = **3000**。
- 尾移为整体 +2_000ms（tool-result 12_000→14_000、text-delta 12_100→14_100、turn-result 13_500→15_500、turn-end 14_000→16_000），`tool-call@5_000` 与阶段序 `thinking→tool→writing→idle` **未变**（`--list` exit 0，且逐字读数 thinking/tool/writing 依次出现）。

### AC4 载荷臂稳定绿（≥28 路兄弟 e2e 车道）

构造（scratch，均在 `/tmp`，不入库）：`/tmp/ac187-lanes.sh <N> <dur>` 起 28 路 `setsid` 兄弟 `npx playwright test`（10 个 spec 轮转，各自以 `QUAY_MEMORY_MAX=50G` 隔离 scope）；`/tmp/ac187-loadtest.sh <runid>` 与 `/tmp/ac187-loadtest3.sh <runid>` 编排并采样 `load1`。

- **r1**（28 车道）：crit a **EXIT=0** `dock.wall=18429ms`（load1 17.58→46.73）；crit b **EXIT=0** `dock.wall=18509ms`（load1 46.73→70.85）。两次 `dock.stable.phases=["tool"×7]`、`dock.stable.samples=["Running Bash"×7]`。
- **r3**（28 车道，ramp 后 settle 30s）：crit a/b/c **EXIT=0**，`dock.wall` = **17441 / 17516 / 17586** ms，load1 123.54→56.42（峰值 **183.42**）；三次均 `["tool"×7]`、`["Running Bash"×7]`、`dock.stable.span=6000ms`。
- **r2**（28 车道）：crit b **EXIT=0** `dock.wall=17665ms`（load1 155.67→101.07，7 读数全 `tool`/`Running Bash`）；crit a 红，但逐字为**引导红** —— `Error: the project row for activity-dock-phase-workspace never rendered ... (the navigation itself failed: page.goto: Timeout 5000ms exceeded)` @ `navigateBounded`（spec `:815`），落在车道 ramp 尖峰（`load1=155.67`、`482 running/19948`），**不是稳定窗口**。本改动不动场景头（`thinking` 起点与 `tool-call@5_000` 未动），引导成本不变；r3 的 settle 臂在同一 load1 量级下 3/3 绿即其反证。

⇒ ≥28 车道下合计 **6 次 exit 0**；唯一 1 次红已分类为 ramp 尖峰的引导超时（同族见 `gap-ac179-criterion-boot-timeout-under-lane-load`）。

### AC5 读数未弱化

- `git diff <base>..HEAD -- goals/` **空**（`criterion:`/`expect:` 一字未动）。
- `npx playwright test e2e/activity-dock-truthful.spec.ts --list` exit 0；AC-187 用例标题逐字未变：`AC-187 the dock speaks the real phase: thinking, Bash, writing, idle — and holds still inside a phase`。
- 四条断言文本逐字保留：`every reading lands in the tool phase`（spec `:2012`）、`the label must not rotate while the phase holds`（`:2013`）、`spanMs` 的 `toBeGreaterThanOrEqual(5_000)`（`:2010`）、`at least six readings`（`:2011`）。
- case body 预算重标：**20_000 → 25_000**（spec `:2051`）。新的结构下界 = 走查自身 `turn-end`（随尾移 +2.0s：14_000→16_000）加一次强制的回合后重导航；安静实测 `dock.wall` **15_491–15_730ms → 17_512–18_395ms**。25s 距最差实测余 ~6.6s，且在 `SINGLE_SPEC_CEILING_MS`（55_000）与 gate 60s 击杀之内；与上方兄弟 AC-188 用例同值。

### AC6 假形态仍红（承重）

**变异 (i)** — `src/modules/chat/composer/ActivityIndicator.tsx`：把 `label` 改回按已用时间轮换的词表。变异 diff 逐字：

```
+  // FALSE FORM (i): the running word is rotated from a local clock (the old
+  // time-based rotation) instead of read from the phase the server reported.
+  const clockWords = [
+    t('claudeStatus.phases.thinking', { defaultValue: 'Thinking' }),
+    t('claudeStatus.phases.tool', { tool: dock.toolName ?? '', defaultValue: 'Running {{tool}}' }),
+    t('claudeStatus.phases.writing', { defaultValue: 'Writing' }),
+  ];
+  const clockWord = clockWords[Math.floor((dock.elapsedSeconds ?? 0) / 5) % clockWords.length];
...
-        : (phaseLabel
+        : (clockWord ?? phaseLabel
```

结果：**红在稳定性断言** `e2e/activity-dock-truthful.spec.ts:2013:121`，逐字 `Error: the label must not rotate while the phase holds; readings were ["Running Bash","Running Bash","Running Bash","Running Bash","Running Bash","Writing","Writing"]`；同次 `dock.stable.phases` 仍 `["tool"×7]`（`:2012` 通过）—— 红的正是「标签不轮换」这条承重读数（thinking/tool 两个前置读数均绿）。
恢复：`git checkout -- src/modules/chat/composer/ActivityIndicator.tsx`。

**变异 (ii)** — `src/modules/chat/utils/activityDockView.ts`：阶段标签的 tool 名不再取自服务端帧。变异 diff 逐字：

```
-    phaseLabelKey: activityPhaseLabelKey(phase ?? 'idle', toolName),
+    // FALSE FORM (ii): the tool name no longer comes from the server's frame.
+    phaseLabelKey: activityPhaseLabelKey(phase ?? 'idle', null),
```

结果：**红在 Bash 读数** `e2e/activity-dock-truthful.spec.ts:1995:71`，逐字 `Error: the tool phase label names the pending tool` / `Expected substring: "Bash"` / `Received string: "Running a tool"`；同次 thinking 读数仍 `Thinking`（`:1987` 通过）、`data-activity-phase` 仍 `tool`（`:1990` 通过）—— 红点唯一落在「tool 名」。
恢复：`git checkout -- src/modules/chat/utils/activityDockView.ts`。

### AC7 契约面

- `npm run lint` exit 0（仅既有告警；本 spec 无告警）。
- `npm run typecheck` exit 0（`tsc -p tsconfig.json && server/tsconfig.json && scripts/tsconfig.json`）。
- `git diff --name-only <base>` = `e2e/activity-dock-truthful.spec.ts` ⊆ `## Touches`。
- DoD 的方言守卫：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts` → **5 pass / 0 fail**（server 代码未动）。

### 收尾

出货的整份改动只在 `e2e/activity-dock-truthful.spec.ts`；`src/**`、`server/**`、`goals/` 一字未动（生产行为与判据物均不变）。
