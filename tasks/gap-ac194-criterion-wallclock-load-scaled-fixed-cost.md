---
id: gap-ac194-criterion-wallclock-load-scaled-fixed-cost
title: AC-194 判据在扇入负载下越过 AC 自己的 40s 上限而红（两份 error-context 都是 spec:431 的 40s
  断言，Received 47757/42771ms）——AC-194 的 describe 从未拿到 AC-199 的启动治疗（无
  warmClientStartup、仍是固定 25s waitFor + 重载回退），把它做成负载不敏感并在负载臂下实测达标
status: done
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

判据物（逐字取自 `goals/AC-194-真实浏览器-坞里看到任务与计划-状态不刷新就变化-重载后由快照恢复-卡片按-tooluseid-读任务-计划只读.md` 的 `criterion:`）：`npx playwright test e2e/activity-dock-background.spec.ts -g \"AC-194\"`。其 `expect:` 要求：坞摘要显示后台任务数与计划数；展开面板按类型列任务（描述/状态/已运行时间/最近动作）与计划（表达式/下次触发倒计时/提示词）；任务完成后状态**不刷新页面**即变化；整页重载后由快照恢复；转写里 Agent 与 Bash 卡片头读 Task 显示实时状态而不是只写 running；计划行取消控件计数为 0；**墙钟须实测不超过 40 秒**；两条假形态必须有分辨力。

### 本轮直接现测：安静宿主上判据是绿的，红是负载下的整轮墙钟

本轮开工 `HEAD=8e92562a`（branch `author`），`git status --porcelain --untracked-files=no` 空（工作树无源码改动）。出货命令逐字不改直跑两次均 exit 0：spec 自印 `AC-194 wall clock: 17819ms` / `18011ms`（整轮 17.8s / 17.9s）——安静宿主上距 40s 上限约 22s。

台账 `.quay/gate-events.jsonl` 里 AC-194 `gate=acceptance` 共 253 条，绝大多数 `pass`；最近两红在 `2026-10-08T02:31:06Z` 与 `2026-10-08T02:35:09Z`（本地 +08:00 即 10:31 / 10:35），其 `payload.reason` 只有 `[WebServer] [BABEL] Note …` 与 `DEP0190`——**只看该字段会误判成「启动即哑、无测试输出」**（task `gap-ac199-criterion-ledger-red-is-silent-e2e-death` 已把这条判法钉死：`gate=goal` 红 + `reason` 只有 webServer 引导输出 ⇒ 必须读 `<dataDir>/test-results/<spec>/error-context.md`）。读 e2e artifact 才是真读数：

```
quay-e2e-8YVbZV (02:31:06Z): Error: the criterion must complete within 40s / Expected: <= 40000 / Received: 47757
quay-e2e-XoZeOf (02:35:09Z): …                                              Received: 42771
```

两个 data dir 的 `watchdog-state.json` 皆 `{\"armed\":true,\"fired\":false,\"ceilingMs\":55000,\"detail\":\"boot 40000ms, re-armed to 55000ms once past boot\"}`——运行是自己 exit 1 的，55s 天花板未触发；每个 test-results 目录同时含 `trace.zip`，即运行产出了测试输出。

两处断言落点都是 `e2e/activity-dock-background.spec.ts:431` 的 `expect(elapsedMs, 'the criterion must complete within 40s').toBeLessThanOrEqual(40_000)`，`elapsedMs = Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT)`——**从整轮 `npx playwright test` 起算，含 config 求值、seeding、webServer 引导、浏览器启动、beforeAll 与用例体**（`playwright.config.ts:35-45` 的书面设计：注释明写「a spec that timed its own body would report a number whose shortfall against the ceiling is the part it could not observe」）。

带时间戳的安静跑（本条实测，`npx playwright test e2e/activity-dock-background.spec.ts -g \"AC-194\" 2>&1 | while IFS= read -r l; do printf '%6dms %s\\n' \"$(($(date +%s%3N)-START))\" \"$l\"; done`）：

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

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rl \"^goal_ac: *AC-194\" tasks/` 命中唯一一条 `gap-activity-dock-background-browser`（`status: done`，交付坞的任务/计划**产品面**）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-194`）⇒ **0 命中**。那条 done **不是重复**：它只交付产品面，从未做过负载鲁棒性。姊妹 task `gap-ac199-criterion-wallclock-load-scaled-fixed-cost`（done，`goal_ac: AC-199`）把**同一个 spec 文件**里的 AC-199 判据做成负载不敏感（`await-release` 释放握手 + `warmClientStartup` 预热 + 有界 probe 前导），但其 Plan step 6 / AC5 对 AC-194 只要求「静跑一次 ≤ 40000」，**从未把 AC-194 的 describe 放进负载臂**——所以负载下的红一次都没被碰过，本轮照旧复发。

读代码，机制逐字：该 spec 有**两个 describe、两个各自独立的 `beforeAll`**。

- `test.describe('activity dock controls')`（AC-199）的 `beforeAll`（`e2e/activity-dock-background.spec.ts:709`）先 `await warmClientStartup(clientUrl)`（:730），再 `page.goto('/')` + `awaitWorkspaceInSidebar`（:747，有界 4s probe，整段受 `STARTUP_PROBE_DEADLINE_MS = 15_000` 约束）。
- `test.describe('activity dock background')`（AC-194）的 `beforeAll`（:232）**没有** `warmClientStartup`，且仍是固定 25s 探针加一次重载回退：

```
await page.goto('/');
if (!(await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
  await page.reload();
}
```

判据命令 `-g \"AC-194\"` **只跑「background」这个 describe**，于是 AC-199 那个 `beforeAll` 里的预热与有界 probe **根本不执行**：AC-194 的首次导航仍撞上本 run 私有的冷 Vite 优化器（上文 `:10932ms` 的 BABEL 行即其提交），文档被整体替换，侧栏在**那份**文档上永远不渲染，于是 25s `waitFor` 跑满整段再走重载回退——一个随宿主负载放大的固定开销。AC-199 的 commit message（`6cc8b657`）逐字描述了同一现象：「a 25s waitFor plus a reload fallback that fires whenever the cold Vite dev server replaces its first document」。AC-199 把它从自己的 describe 里取掉了；AC-194 的 describe 一直留着。

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

- [x] AC1 红态真因机械入档：`quay-e2e-8YVbZV` / `quay-e2e-XoZeOf` 的 `error-context.md` `# Error details` 逐字为 `Error: the criterion must complete within 40s` + `Expected: <= 40000` + `Received: 47757 / 42771`，两个 `watchdog-state.json` 皆 `fired:false`；断言落点记为 `e2e/activity-dock-background.spec.ts:431`；并写明 AC-194 的 describe 无 `warmClientStartup`、仍有固定 25s `waitFor`。
- [x] AC2 安静臂基线：净 worktree 上出货命令逐字跑 ≥3 次，全部 exit 0 且 `AC-194 wall clock ≤ 40000`；入档 worktree 路径、`HEAD`、`HEAD^{tree}`、每次墙钟。
- [x] AC3 负载臂（经人裁定改口径，2026-10-08）：本机已知不可达——28+ 路并发下的红是 runner boot（宿主 CPU 争用，在本条 Touches 之外）；修复为非负收益（同负载成对对照下假形态从不更慢：24 路 23.2s 假 vs 25.3s 修复；28 路 32.3s 假 vs 30.0s 修复）；负载臂读数（20/24 路达标，28/32/40 路 boot 主导而红）与构造已入档于 Evidence；残余风险移交后续 task `gap-e2e-runner-boot-inflation-under-fan-in-concurrency`。
- [x] AC4 读数与上限都未弱化：`grep -n \"toBeLessThanOrEqual(40_000)\" e2e/activity-dock-background.spec.ts` 仍命中 AC-194 那处；spec 输出里 `dock.counts=2/1`、`running.tasks` 两行四读数、`running.plans` 三读数、`settled.tasks=[]`、`restored.*`、`plan.cancelControls=0`、`settled.cardTaskStates=[\"completed\",\"completed\"]`、`settled.cardFoldedStates=[\"running\",\"running\"]` 与两条假形态逐字仍在；`goals/AC-194-…md` 与判据命令逐字未改（`git diff <base>..HEAD -- goals/` 为空）。
- [x] AC5 兄弟判据不回归：`npx playwright test e2e/activity-dock-background.spec.ts -g \"AC-199\"` exit 0 且其墙钟 ≤ 40000（该 spec 与 AC-199 共享）。
- [x] AC6 失败路径如实：若负载臂仍 >40000ms，停手并置 `needs-human`，附逐字读数与已排除项；⛔ 不得放宽 40s 上限、不得删除断言、不得把安静臂通过写成「flake 已修」。

## DoD

真实落地判据（经人裁定改口径，2026-10-08）：安静宿主上出货命令 `npx playwright test e2e/activity-dock-background.spec.ts -g \"AC-194\"` 逐字不变、退出 0，且自印 `AC-194 wall clock ≤ 40000`（安静臂 16.3–16.7s）；40s 上限、主读数与 `goals/AC-194-…md` 的 `criterion:` / `expect:` 一字未改。

负载臂与假形态分句（原：≥20 路并发下修复态过、回退启动治疗后同一负载重新越过 40s）**本机已知不可达**：28+ 路红是 runner boot（宿主 CPU 争用，在 Touches 之外）；修复为非负收益（同负载下假形态从不更慢）；残余风险移交后续 task `gap-e2e-runner-boot-inflation-under-fan-in-concurrency`。⛔ 未放宽上限、未删除断言、未把安静臂通过写成「已修」。

## Touches

- `e2e/activity-dock-background.spec.ts`（判据本体：AC-194 的 describe `beforeAll` 的启动路径与用例体固定等待；与 AC-199 共享该文件）
- `playwright.config.ts`（仅在需要削减 config/webServer 引导段固定开销时）
- `tasks/gap-ac194-criterion-wallclock-load-scaled-fixed-cost.md`（自触）

## Evidence

### 改动（work product，保留在分支；其收益未被证实）

- 提交 `422f43208ccddf0d2285326f7728ff81cd1e3cfb`，tree `3795394cc6f57172757b33e71b91d78192491229`，单文件 `e2e/activity-dock-background.spec.ts`，起点 `45b79766`（开工 `develop`）。
- 对 AC-194 的 `beforeAll`（:232）两处改动：(1) `browser.newContext()` 之前 `warmClientStartup(clientUrl)`（现 :254）；(2) 用 `awaitWorkspaceInSidebar` + 有界 probe 取代固定 25s `waitFor` + 重载回退（现 :285-287）。共用 helper 本就在同文件（`warmClientStartup` :565、`awaitWorkspaceInSidebar` :620、`STARTUP_PROBE_MS=4_000`、`STARTUP_RELOAD_PROBE_MS=4_000`、`STARTUP_PROBE_DEADLINE_MS=15_000`、`CLIENT_WARM_DEADLINE_MS=25_000`），未改动它们。
- 第三个 describe（`activity dock capability gate`，:1033 附近）里的旧固定 25s `waitFor` 按 Proposal 的非目标**未动**。
- 形态切换：`git -C <wt> reset --hard HEAD` → 修复态；`git revert --no-commit HEAD` → 假形态（暂存未提交）。

### 安静臂（AC2）

出货命令逐字 `npx playwright test e2e/activity-dock-background.spec.ts -g \"AC-194\"`，全部经 `bash scripts/with-memory-cap.sh`：

| 形态 | exit | `AC-194 wall clock` |
|---|---|---|
| 修复 #1 / #2 / #3 | 0 / 0 / 0 | 16507 / 16678 / 16349 ms |
| 改前基线 #1 / #2 / #3 | 0 / 0 / 0 | 16638 / 16743 / 17086 ms |

worktree `/data/home/yale/work/claudecodeui-worktrees/gap-ac194-criterion-wallclock-load-scaled-fixed-cost`，HEAD `422f4320`，tree `3795394c`，`git status --porcelain` 空。

### 负载臂（AC3 未达标）

构造（脚本 `/tmp/ac194-loadrun2.sh <runid> <critlog> [delay=3]`，`LANE_COUNT` 路并发 `npx playwright test`，10 个 spec 循环：`activity-dock-background -g AC-194`、`session-filter`、`sidebar-resize`、`activity-dock-truthful`、`transcript-edge-layout`、`transcript-follow`、`transcript-global-scrollbar`、`transcript-rail-geometry`、`transcript-work-segments`、`mobile-composer-send-key`；延迟 3s 后跑判据；每 2s 采 `load1` 到 `/tmp/ac194-load-<id>-trace.log`，lane 生命期到 `-lanelife.log`）：

| 并发 | 修复态 墙钟（load1） | 假形态 墙钟（load1） |
|---|---|---|
| 20 | 20522 pass（13.6→22.0）；34557 pass（20→30.7） | 20620 pass（14.7→25.9）；26573 pass（环境负载 68→98，峰值 97.8） |
| 24 | **25252 pass**（65.6→89.6，峰值 104） | **23189 pass**（63.5→73.5） |
| 28 | **29995 pass**（54.2→107.8）；**41502 FAIL** | **32338 pass**（41.9→75.1）；**55684 被 watchdog 杀** |
| 30 | — | 33906（起始 load1 200，读数污染） |
| 32 | **41698 FAIL**（`Received: 41698`，47.7→113.6，峰值 117.1；warm-up 11.5s） | — |
| 40 | 40823 FAIL（warm-up 跑满自身 25s `CLIENT_WARM_DEADLINE_MS`；109.7→170.4） | 55869 在 55s 被 watchdog 杀（19.3→186.5，峰值 181） |

复现红的逐字读数（28 路修复态）：`AC-194 wall clock: 41502ms` / `Expected: <= 40000` / `Received: 41502`，error-context 在 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-mnikjV/test-results/activity-dock-background-a-aeb25-nd-restores-from-a-snapshot/error-context.md`。

**同负载成对对照：假形态从不更慢。** 24 路 23.2s（假）vs 25.3s（修复）；28 路 a 轮 32.3s（假）vs 30.0s（修复）。

**膨胀的主项是 runner boot，不在本条的 Touches 内。** 28 路修复态那次 41502ms 的分解：warm-up 395ms + sidebar ready 6732ms + 用例体 ≈5.9s ⇒ 约 **28.5s 花在 config 求值 + webServer 引导 + 浏览器启动**（安静基线同段约 6.4s）。32 路那次 boot ≈21.9s。AC-199 当年能清掉 40s，是因为它还额外削掉了一段 12s 的场景内时钟偏移；AC-194 的场景本身已经短（任务 3.6/3.8s 落定、walk 4.4s 结束），没有同量级的可削偏移。

**修复自身的启动预算与判据上限同量级。** 修复态前导上限 = `warmClientStartup` 的 25s（`CLIENT_WARM_DEADLINE_MS`）+ `awaitWorkspaceInSidebar` 的 15s（`STARTUP_PROBE_DEADLINE_MS`）= 40s，与整轮 40s 上限相等；在它要治的坏区里上限用满，等于把整轮预算全花在 startup 上（40 路实测 warm-up 就跑满 25s 截止并越过 40s）。安静/中等负载下 warm-up 很快返回（24 路 2847ms），因此它削掉的只是「本来就没跑满的 25s 探针」——这正是分辨力不可复现的原因。

### 不可复现的分辨力（DoD 假形态分句在此构造下不成立）

DoD 要求：同一负载构造下修复态 exit 0 且 ≤40000、假形态重新越过 40s。本轮所有「修复态通过」的构造里，假形态**也通过**（20 路 20.6s/26.6s；24 路 23.2s；28 路 a 轮 32.3s），而同负载下假形态墙钟不高于修复态。唯一让假形态越线的两处（28 路 55684、40 路 55869）修复态同样越线。⇒ 本机无法在同一负载构造下让「修复过、假形态红」同时成立。

### 红是可复现的「冷 Vite 优化器」路径 + 负载

`playwright.config.ts:1902` 的 `seedViteCache` 把共享 `node_modules/.vite/deps` 拷进本 run 的私有 `vite-cache/deps`；注释逐字写明：兄弟 run 正在改写共享缓存时拷贝可能撕裂，「the copy is discarded and Vite optimizes into the private directory from scratch」。私有缓存从零优化 ⇒ 首次导航期间文档被整体替换 ⇒ 旧固定 25s 探针在那份不再渲染的文档上跑满整段。历史红 42771ms 与「引导 ≈5s + 首载 ≈8s + 探针 25s + 用例体 ≈4.5s」的安静臂分段吻合（**推断，非直接读数**）。本轮的负载臂没有稳定落进这条 degraded 路径（24 路时假形态 beforeAll 仅约 12s，探针未跑满），因此没能把历史红的形状在同一构造下重建。

### 判据是间歇性红，且余量是毫秒级

`/data/home/yale/work/claudecodeui/.quay/gate-events.jsonl` 中 AC-194 `gate=goal`（评估根 = 主 checkout `/data/home/yale/work/claudecodeui`，**不含本分支的修复**）：tree `83d62bfba0ed` 在 02:31:06Z FAIL（dd `8YVbZV`）、02:31:35Z PASS、02:33:06Z PASS、02:35:09Z FAIL（dd `XoZeOf`）——同一 tree、同一命令，4 分钟内 2 红 2 绿；tree `358b0a8cf248` 在 02:47:36Z–03:14:55Z 连续 17 次 PASS；tree `821eb30e0448` 在 03:26:56Z FAIL，dd `rRUK1u`（`Received: 40007`，watchdog `fired:false`）——**该次红正好发生在本条自己的负载臂运行期间**，且只超上限 7ms。⇒ 判据静跑约 16.5–18s，距 40s 上限本就只剩毫秒—秒级余量，宿主任何负载抬升都会把它推过去。

### 已排除项（不当作解）

1. 放宽 40s 上限 / 删除该断言 —— ⛔ 未做（`grep` 仍命中，见 AC4）。
2. 改判据命令或 `goals/AC-194-…md` 的 `criterion:` / `expect:` —— ⛔ 未做（`git diff 45b79766..HEAD --stat -- goals/` 为空）。
3. 弱化任一读数或两条假形态 —— ⛔ 未做（AC4 逐字读数仍在）。
4. 把安静臂通过写成「flake 已修」 —— ⛔ 未做。
5. 单纯缩小时钟偏移 —— Proposal 已排除（AC-199 证明会换成赛跑红），本轮未走。
6. 削减 runner boot（config/webServer/浏览器启动）—— 主膨胀项，但本机构造下它是宿主机 CPU 争用（≥28 路时 20–28s），config 侧无可削减的固定开销；未在本条内找到可验证的杠杆。

### 交办

修复已接上、安静臂更绿且不回归兄弟（AC5：`-g \"AC-199\"` exit 0，`AC-199 wall clock: 13037ms`），但**收益未被证实**：负载臂不能达标，DoD 的分辨力分句在本机不成立，且修复在坏区里自身就要花 25–40s。需要人工裁决：是接受「AC-194 的红是宿主 boot/并发容量问题」（对应 fan-in 侧并发限流或共享 vite 缓存预热，属另一处 seam），还是改判据口径（需人工关卡）。修复提交保留在分支上供评估，但其净收益为负的风险（坏区里 warm-up 上限 25s > 被取代的固定探针在正常路径上的代价）已如实记录。

### 复现命令

- 修复态静跑：`bash scripts/with-memory-cap.sh npx playwright test e2e/activity-dock-background.spec.ts -g \"AC-194\"`
- 假形态：`git -C <wt> revert --no-commit HEAD` 后同上。
- 负载臂：`LANE_COUNT=28 bash /tmp/ac194-loadrun2.sh fix28b /tmp/ac194-load-fix28b-criterion.log 3`
- 兄弟：`bash scripts/with-memory-cap.sh npx playwright test e2e/activity-dock-background.spec.ts -g \"AC-199\"`

### Human adjudication

Human adjudication 2026-10-08: merge fix, file boot-concurrency follow-up. AC3 / DoD load-arm and falsification clause reworded as "known unreachable on this host: the 28+ lane red is runner boot (host CPU contention, outside Touches); the fix is non-negative (fake form never slower at equal load); residual risk moved to follow-up task `gap-e2e-runner-boot-inflation-under-fan-in-concurrency`".
