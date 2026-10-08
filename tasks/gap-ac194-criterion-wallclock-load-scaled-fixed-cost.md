---
id: gap-ac194-criterion-wallclock-load-scaled-fixed-cost
title: AC-194 判据在扇入负载下越过 AC 自己的 40s 上限而红（两份 error-context 都是 spec:431 的 40s
  断言，Received 47757/42771ms）——AC-194 的 describe 从未拿到 AC-199 的启动治疗（无
  warmClientStartup、仍是固定 25s waitFor + 重载回退），把它做成负载不敏感并在负载臂下实测达标
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-194
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是复述台账尾巴）。AC-194 记录 `status: achieved`，其 GOAL-015 已 `achieved`、不再活，且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。

判据物（逐字取自 `goals/AC-194-真实浏览器-坞里看到任务与计划-状态不刷新就变化-重载后由快照恢复-卡片按-tooluseid-读任务-计划只读.md` 的 `criterion:`）：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"`。其 `expect:` 要求：坞摘要显示后台任务数与计划数；展开面板按类型列任务（描述/状态/已运行时间/最近动作）与计划（表达式/下次触发倒计时/提示词）；任务完成后状态**不刷新页面**即变化；整页重载后由快照恢复；转写里 Agent 与 Bash 卡片头读 Task 显示实时状态而不是只写 running；计划行取消控件计数为 0；**墙钟须实测不超过 40 秒**；两条假形态必须有分辨力。

### 本轮直接现测：安静宿主上判据是绿的，红是负载下的整轮墙钟

本轮开工 `HEAD=8e92562a`（branch `author`），`git status --porcelain --untracked-files=no` 空（工作树无源码改动）。出货命令逐字不改直跑两次均 exit 0：spec 自印 `AC-194 wall clock: 17819ms` / `18011ms`（整轮 17.8s / 17.9s）——安静宿主上距 40s 上限约 22s。

台账 `.quay/gate-events.jsonl` 里 AC-194 `gate=acceptance` 共 253 条，绝大多数 `pass`；最近两红在 `2026-10-08T02:31:06Z` 与 `2026-10-08T02:35:09Z`（本地 +08:00 即 10:31 / 10:35），其 `payload.reason` 只有 `[WebServer] [BABEL] Note …` 与 `DEP0190`——**只看该字段会误判成「启动即哑、无测试输出」**（task `gap-ac199-criterion-ledger-red-is-silent-e2e-death` 已把这条判法钉死：`gate=goal` 红 + `reason` 只有 webServer 引导输出 ⇒ 必须读 `<dataDir>/test-results/<spec>/error-context.md`）。读 e2e artifact 才是真读数：

```
quay-e2e-8YVbZV (02:31:06Z): Error: the criterion must complete within 40s / Expected: <= 40000 / Received: 47757
quay-e2e-XoZeOf (02:35:09Z): …                                              Received: 42771
```

两个 data dir 的 `watchdog-state.json` 皆 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`——运行是自己 exit 1 的，55s 天花板未触发；每个 test-results 目录同时含 `trace.zip`，即运行产出了测试输出。

两处断言落点都是 `e2e/activity-dock-background.spec.ts:431` 的 `expect(elapsedMs, 'the criterion must complete within 40s').toBeLessThanOrEqual(40_000)`，`elapsedMs = Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT)`——**从整轮 `npx playwright test` 起算，含 config 求值、seeding、webServer 引导、浏览器启动、beforeAll 与用例体**（`playwright.config.ts:35-45` 的书面设计：注释明写「a spec that timed its own body would report a number whose shortfall against the ceiling is the part it could not observe」）。

带时间戳的安静跑（本条实测，`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194" 2>&1 | while IFS= read -r l; do printf '%6dms %s\n' "$(($(date +%s%3N)-START))" "$l"; done`）：

```
  842ms  server=… client=…                    端口分配
 5015ms  Running 1 test using 1 worker        webServer 引导完成（~4.2s）
 5295ms  测试开始
10932ms  [WebServer] [BABEL] react-scan …     首次导航期间 Vite 优化器才提交（本 run 私有冷预打包）
13529ms  diag.snapshot.status=200 …           beforeAll 结束（浏览器启动 + 首载 ≈ 8.2s）
14962ms  running.tasks=…                      会话打开 + 坞 + 面板读数
18011ms  AC-194 wall clock
```

⇒ 固定开销三段：(1) npx + config 求值 + webServer 引导 ≈ 5.0s；(2) 浏览器启动 + 首载/beforeAll ≈ 8.2s（其中**冷 Vite 优化器在首载期间才提交、把文档整体替换**——`full-reload`）；(3) 用例体（含一次整页 `page.reload()` 重开面板）≈ 4.5s。负载下这三段一起膨胀，越过 AC 自己的 40s。

### 缺口机制：AC-194 的 describe 从未拿到 AC-199 的启动治疗

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rl "^goal_ac: *AC-194" tasks/` 命中唯一一条 `gap-activity-dock-background-browser`（`status: done`，交付坞的任务/计划**产品面**）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-194`）⇒ **0 命中**。那条 done **不是重复**：它只交付产品面，从未做过负载鲁棒性。姊妹 task `gap-ac199-criterion-wallclock-load-scaled-fixed-cost`（done，`goal_ac: AC-199`）把**同一个 spec 文件**里的 AC-199 判据做成负载不敏感（`await-release` 释放握手 + `warmClientStartup` 预热 + 有界 probe 前导），但其 Plan step 6 / AC5 对 AC-194 只要求「静跑一次 ≤ 40000」，**从未把 AC-194 的 describe 放进负载臂**——所以负载下的红一次都没被碰过，本轮照旧复发。

读代码，机制逐字：该 spec 有**两个 describe、两个各自独立的 `beforeAll`**。

- `test.describe('activity dock controls')`（AC-199）的 `beforeAll`（`e2e/activity-dock-background.spec.ts:709`）先 `await warmClientStartup(clientUrl)`（:730），再 `page.goto('/')` + `awaitWorkspaceInSidebar`（:747，有界 4s probe，整段受 `STARTUP_PROBE_DEADLINE_MS = 15_000` 约束）。
- `test.describe('activity dock background')`（AC-194）的 `beforeAll`（:232）**没有** `warmClientStartup`，且仍是固定 25s 探针加一次重载回退：

```
await page.goto('/');
if (!(await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
  await page.reload();
}
```

判据命令 `-g "AC-194"` **只跑「background」这个 describe**，于是 AC-199 那个 `beforeAll` 里的预热与有界 probe **根本不执行**：AC-194 的首次导航仍撞上本 run 私有的冷 Vite 优化器（上文 `:10932ms` 的 BABEL 行即其提交），文档被整体替换，侧栏在**那份**文档上永远不渲染，于是 25s `waitFor` 跑满整段再走重载回退——一个随宿主负载放大的固定开销。AC-199 的 commit message（`6cc8b657`）逐字描述了同一现象：「a 25s waitFor plus a reload fallback that fires whenever the cold Vite dev server replaces its first document」。AC-199 把它从自己的 describe 里取掉了；AC-194 的 describe 一直留着。

⇒ 42.7s / 47.8s 的来源：安静宿主上首载快、25s 探针秒过；负载/冷优化下探针跑满 25s，叠加 5s 引导与 4.5s 用例体，整轮越过 40s。

**实现面（本条认领）。** 把 AC-194 的 describe 做成与 AC-199 同等的负载不敏感：

1. **启动治疗**：把 `warmClientStartup` + 有界 probe 前导（`awaitWorkspaceInSidebar` / `STARTUP_PROBE_MS` / `STARTUP_RELOAD_PROBE_MS` / `STARTUP_PROBE_DEADLINE_MS`）从 AC-199 的 `beforeAll` 提取为**共享 helper**，让 AC-194 的 `beforeAll`（:232）在 `browser.newContext()` 之前同样 `warmClientStartup`、并用有界 probe 取代固定 25s `waitFor` + 重载回退。
2. **用例体固定等待**（按判据能稳定复现的读数取舍）：AC-194 用例体里的固定等待（`page.waitForTimeout(500)`、reload 后的 `PANE` 30s / `DOCK_TOGGLE` 25s）改为有界条件探针。
3. ⛔ 允许的杠杆：削减 (1)(2)(3) 三段固定开销。**不得**改判据命令、**不得**改 `goals/AC-194-…md` 的 `criterion:` / `expect:`、**不得**放宽或删除 40s 上限、**不得**弱化任何一条读数（坞计数、面板四读数、计划三读数、不刷新即变化、reload 由快照恢复、卡片读 Task、计划零控件、两条假形态的分辨力）。⛔ 单纯把时钟偏移调小不是解（参考 AC-199：那会把一种红换成赛跑红）。

**非目标。** 不改 AC-194 的产品面（坞/面板/卡片/Task 归约/活动协议）；不碰停止/转后台控制面（AC-196/197/198/199）；不碰 Monitor 折叠、人工关卡、其它 provider；不改 AC-199 的读数与上限。

## Plan

1. 建本条隔离 worktree（起点 = 开工时 `develop`），打印路径、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`，确认 `git status --porcelain` 空。
2. 机械复录红态证据：`cat` `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-{8YVbZV,XoZeOf}/test-results/*/error-context.md` 的 `# Error details` 段与各自 `watchdog-state.json`，逐字入档；写明断言落点 `e2e/activity-dock-background.spec.ts:431`，并写明 AC-194 的 describe（:232）无 `warmClientStartup`、仍有固定 25s `waitFor`。
3. 安静臂基线：出货命令逐字跑 ≥3 次，记录 exit、spec 自印 `AC-194 wall clock`、整轮墙钟；再按带时间戳跑法量出三段固定开销作为改动前对照。
4. 实施改动：提取共享启动 helper 并接到 AC-194 的 `beforeAll`；按需收窄用例体的固定等待（保持所有读数）。改 `src/**` 时按 AGENTS.md 载入并遵守 `$frontend-module-standards`；改 `server/**` 时载入 `$backend-module-standards`。⛔ 该 spec 与 AC-199 共享，改动用 add/add 纪律（从 develop 取文件、只改本条拥有区段，见 `shared-e2e-spec-add-add-merge-take-develop-then-append-renamed`）。
5. 安静臂复测 ≥3 次，全部 exit 0 且 `AC-194 wall clock ≤ 40000`；再跑 AC-199 判据确认同文件兄弟不回归。
6. 负载臂：用能复现膨胀的并发负载（≥20 路兄弟 `npx playwright test`，参照 AC-199 续做轮的构造）重跑 ≥2 次，全部 exit 0 且 ≤ 40000；入档负载生成命令、并发度、宿主 `load1`、每次墙钟，且负载臂与安静臂有可见差距（否则负载没造出来、本条不算验证）。
7. 若负载臂仍 >40000ms：停手，置 `needs-human`，附逐字读数与已排除项；⛔ 不改上限、不把安静通过写成修复。
8. 写完成记录，置终态 done（AC-194 是机械判据，无人工关卡）。

## AC

- [ ] AC1 红态真因机械入档：`quay-e2e-8YVbZV` / `quay-e2e-XoZeOf` 的 `error-context.md` `# Error details` 逐字为 `Error: the criterion must complete within 40s` + `Expected: <= 40000` + `Received: 47757 / 42771`，两个 `watchdog-state.json` 皆 `fired:false`；断言落点记为 `e2e/activity-dock-background.spec.ts:431`；并写明 AC-194 的 describe 无 `warmClientStartup`、仍有固定 25s `waitFor`。
- [ ] AC2 安静臂基线：净 worktree 上出货命令逐字跑 ≥3 次，全部 exit 0 且 `AC-194 wall clock ≤ 40000`；入档 worktree 路径、`HEAD`、`HEAD^{tree}`、每次墙钟。
- [ ] AC3 负载臂达标：在能复现膨胀的并发负载下跑 ≥2 次，全部 exit 0 且 `AC-194 wall clock ≤ 40000`；入档负载生成命令、并发度、宿主 `load1`、每次墙钟，且负载臂墙钟与安静臂有可见差距。
- [ ] AC4 读数与上限都未弱化：`grep -n "toBeLessThanOrEqual(40_000)" e2e/activity-dock-background.spec.ts` 仍命中 AC-194 那处；spec 输出里 `dock.counts=2/1`、`running.tasks` 两行四读数、`running.plans` 三读数、`settled.tasks=[]`、`restored.*`、`plan.cancelControls=0`、`settled.cardTaskStates=["completed","completed"]`、`settled.cardFoldedStates=["running","running"]` 与两条假形态逐字仍在；`goals/AC-194-…md` 与判据命令逐字未改（`git diff <base>..HEAD -- goals/` 为空）。
- [ ] AC5 兄弟判据不回归：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"` exit 0 且其墙钟 ≤ 40000（该 spec 与 AC-199 共享）。
- [ ] AC6 失败路径如实：若负载臂仍 >40000ms，停手并置 `needs-human`，附逐字读数与已排除项；⛔ 不得放宽 40s 上限、不得删除断言、不得把安静臂通过写成「flake 已修」。

## DoD

真实落地判据：在判据今天变红的那个条件（宿主同时跑 ≥20 路兄弟 e2e，参照 AC-199 续做轮的构造，`load1` 显著抬高）下，出货命令 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` 逐字不变、退出 0，且自印 `AC-194 wall clock ≤ 40000`，负载臂与安静臂有可见差距（证明负载真的造出来了）。取假形态：回退启动治疗（AC-194 的 `beforeAll` 恢复固定 25s `waitFor` + 重载回退、去掉 `warmClientStartup`）后，同一负载构造必须重新越过 40s——这正是两份 `error-context.md` 的 47757 / 42771ms。40s 上限、主读数与 `goals/AC-194-…md` 的 `criterion:` / `expect:` 一字未改。

## Touches

- `e2e/activity-dock-background.spec.ts`（判据本体：AC-194 的 describe `beforeAll` 的启动路径与用例体固定等待；与 AC-199 共享该文件）
- `playwright.config.ts`（仅在需要削减 config/webServer 引导段固定开销时）
- `tasks/gap-ac194-criterion-wallclock-load-scaled-fixed-cost.md`（自触）
