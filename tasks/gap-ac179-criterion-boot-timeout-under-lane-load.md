---
id: gap-ac179-criterion-boot-timeout-under-lane-load
title: AC-179 判据在扇入车道载荷下 e2e webServer 引导越过 Playwright 30s 超时、在任何几何读数之前假红（同
  treeSha 一绿一红；driver 自己 16:59 的 frozenRecheck 已 cleared=now-true）——给该 selection
  的引导可证余量使其在 60s 门下稳定跑绿，载重读数一条不动
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-179
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-09）：`grep -rn "^goal_ac: *AC-179" tasks/*.md` 逐字命中两条——`tasks/gap-resident-status-bar-covers-transcript.md` 与 `tasks/gap-ac179-criterion-anchor-retired-by-dock-consolidation.md`，两者 `status:` 逐字均为 `done`；在飞扫描（逐份读 `^status:` ∈ {todo,ready,needs-human} 且 `^goal_ac: *AC-179`）⇒ **0 命中**。按规则 done 不是重复，而是「上一次的修法没兜住」的证据。`task-granularity-advice.js --touches playwright.config.ts --touches e2e/resident-ui-layout.spec.ts --json` 的 `peers: [ {id: gap-ac153-criterion-wallclock-load-headroom, status: ready, sharedFiles: [playwright.config.ts]} ]`、`mentions: [gap-ac188-case-budget-red-is-postturn-renavigation-tail]`。`gap-ac153-…`（ready）与本条**机制相近但可分离**：它治的是 AC-153 spec 自加的 45000ms **整轮墙钟**预算（红在用例体内的预算断言），本条治的是 **Playwright 自己的 `webServer[].timeout` 在用例运行之前**把整轮打死——两条不同的界、不同的落点；且它已 `ready` 即将派工，**kept separate**（独立验收：各自 AC 独立判定）。`gap-e2e-runner-boot-inflation-under-fan-in-concurrency`（done，杠杆提交 `24f7bd83`）是**同族的上一版修复**，本条**消费**它、不重复其 donor 杠杆（见下）。

**判据物（逐字取自 `goals/AC-179-常驻状态条不压住对话文字.md`）。** `criterion:` = `npx playwright test e2e/resident-ui-layout.spec.ts -g "status bar does not cover the transcript"`。`expect:` 逐字：「视口 780x493 下已常驻会话有一条助手消息时，状态条的边界框与该消息文字块的边界框不相交，且消息文字块在视口内可见。正控制：非常驻会话没有状态条，同一消息读数可见。取假形态：状态条改成绝对定位盖在消息上 ⇒ 必须红，且红落在边界框相交读数上。」

**本轮直接测量（不是复述台账尾巴）：担保今天是真的，红是引导期假红。**

1. **自己直跑判据**（branch `author`，HEAD `d5a5f5bc`，宿主安静）：`bash scripts/with-memory-cap.sh npx playwright test e2e/resident-ui-layout.spec.ts -g "status bar does not cover the transcript"` → **EXIT=0**，`1 passed (13.9s)`，`elapsed=14106ms`。两臂读数全绿：resident 臂 `bar.exists=true` / `bar.box=380,30,81,14` / `msg.box=305,155,459,87` / **`intersect=false`** / `msg.visible=true` / `msg.in.pane=true` / `bar.over.rows=[]` / `msg.count=1`；per-run 臂 `bar.exists=false`（计数 0）/ `msg.visible=true`。⇒ AC-179 的几何保证（不相交 / 消息在视口内 / per-run 不画）**成立**。
2. **driver 自己的读数也判它真。** `.quay/goal-round.jsonl` round **1870**（`2026-10-08T16:59:31.968Z`）的 `frozenRecheck` 里 AC-179 逐字 `verdict: pass, outcome: cleared, cause: now-true, durationMs: 14827, load1: 69.33`。
3. **台账尾巴红在引导期，且与绿同 tree 交错。** `gate-events.jsonl` 里 AC-179：`2026-10-08T16:49:59Z` goal-sweep **fail**（tree `d16e7189`），其后 `16:51:03Z` goal-cli **pass**（**同一个 tree**）；`16:58:12Z` goal-cli pass（tree `167b1de8`），`17:02:17Z` goal-cli **fail**（**同一个 tree**）。两次 fail 的 `payload.reason` 逐字落在**引导**：`17:02:17Z` 那条以 `Error: Timed out waiting 30000ms from config.webServer.` 结尾，同一段另有 `[e2e] vite-cache seed=…/quay-e2e-ZBkZTl/vite-cache/deps in 679ms`（说明 `24f7bd83` 的 donor 杠杆**已生效**）；`16:49:59Z` 那条只有 webServer 引导输出（`[BABEL] … react-scan.js` / `DEP0190`）。⇒ 红**不是**任何一条几何断言：`playwright.config.ts` 的 webServer 未在 30s 内就绪时，整轮在用例之前结束，一个读数都没取到。

**机制。** `playwright.config.ts` 的 `webServer[].timeout: 30_000`（两处）在 fan-in 车道载荷下被越过。`gap-e2e-runner-boot-inflation-under-fan-in-concurrency` 的实测（其 AC3 `on2` 反向读数）已指出：donor 杠杆消掉的是 **Vite 预打包**那一段；**服务端引导 + 客户端轮询在争用下**的耗时它**不碰**（该跑 boot 段 8147ms 与 lever-off 的 7988ms 持平，而 `load1` 是其 2 倍）。今天的红正是这段残余：`17:02` 的 seed 行证明 donor 已跑，仍 `Timed out waiting 30000ms from config.webServer`。本仓 `webServer` 注释自述「Boot costs ~8s on a loaded machine, so 30s is ~3x the observed worst case」——车道载荷下这个 3x 假设已不成立。

**要交付的事（最小充分，不改判据、不动读数）。** 让 AC-179 **这一个 selection** 的引导在复现红的车道载荷下**稳定**跑绿，判据命令与三类读数一字不动。允许的杠杆（按实测取舍）：

- **(a) 在既有天花板算术内给引导可证的余量**：`webServer[].timeout`（现值 `30_000`）抬高到仍 **< `BOOT_CEILING_MS`（`40_000`）**、且引导+用例整轮仍落在 `SINGLE_SPEC_CEILING_MS`（`55_000`）与 60s 判据门之下的值——即让一次「>30s 但 <新值」的引导**跑完**而不是硬死；必须给出算术链（新 webServer 超时 < BOOT_CEILING < run ceiling < 60s）。
- **(b) 削减引导的固定成本**：服务端 webServer 命令（`node_modules/.bin/tsx --tsconfig server/tsconfig.json server/index.ts`）的启动成本，按安静/载荷两臂实测取舍（如编译缓存），只取有可见读数的项。
- ⛔ **不重复** `24f7bd83` 的 donor 杠杆（已落地，本条消费它）。

**非目标。** 不改 AC-179 的 `criterion:` / `expect:`；不弱化 `intersect` / `msg.visible` / `bar.over.rows` / per-run 计数任何一条读数；不把 `SINGLE_SPEC_CEILING_MS` 抬到 60s 判据门之外；不改常驻运行时/UI 生产面；不碰 AC-153 的 spec 与 `e2e/voice-error-messages.spec.ts`。

## Plan

1. **建隔离 worktree**（起点 = 开工时 `develop`），打印路径、`git rev-parse HEAD`、`HEAD^{tree}`，确认 `git status --porcelain` 空。
2. **安静臂基线**：出货命令逐字跑 ≥3 次，全部 exit 0，登记每次 `elapsed=`、`printReading` 两臂读数、`git status` 干净。
3. **定位引导段**：用 `DEBUG=pw:webserver` 或 config 现有日志量出「config 求值 / 服务端引导 / 客户端轮询 / 浏览器启动」分段，确认红落在服务端引导或客户端轮询段。
4. **实施杠杆**：(a) 与 (b) 按实测取舍，一处一次、锚定编辑；给出 (a) 的算术链（新 `webServer[].timeout` < `BOOT_CEILING_MS` < `SINGLE_SPEC_CEILING_MS` < 60000）。
5. **载荷臂**：用能复现红的并发构造（≥28 路兄弟 `npx playwright test`，参照 `gap-e2e-runner-boot-inflation-under-fan-in-concurrency` 与 `gap-ac194-criterion-wallclock-load-scaled-fixed-cost` 的构造）重跑 ≥2 次，入档 `load1`、每次墙钟、两臂读数；载荷臂与安静臂要有可见差距。
6. **判据未弱化**：`npx playwright test e2e/resident-ui-layout.spec.ts --list` exit 0 且仍列 3 个用例、标题逐字未变；三类承重断言文本逐字保留；`git diff <base>..HEAD -- goals/` 为空。
7. **若第 5 步在复现红的负载下仍无法稳定跑绿**：停手、置 `needs-human`，附逐字读数与已排除项；⛔ 不把安静通过写成「已修」。
8. `npm run lint` / `npm run typecheck` 绿；`git diff --name-only <base>..HEAD` 落在 Touches 内；写完成记录。

## AC

- [x] AC1 红态分类机械入档：`gate-events.jsonl` 里 AC-179 两次 fail 逐字入档（`2026-10-08T16:49:59Z` goal-sweep tree `d16e7189`；`2026-10-08T17:02:17Z` goal-cli tree `167b1de8`，其 `payload.reason` 以 `Error: Timed out waiting 30000ms from config.webServer.` 结尾），并登记**同 tree 交错**（`d16e7189` 16:49 fail / 16:51 pass；`167b1de8` 16:58 pass / 17:02 fail）与 round 1870 的 `frozenRecheck`（`verdict: pass, outcome: cleared, cause: now-true`）；据此证明红落在引导、不在任何几何断言。
- [x] AC2 安静臂基线：净 worktree 上出货命令逐字跑 ≥3 次，全部 exit 0；入档每次 `elapsed=`、`intersect=false` / `msg.visible=true` / `bar.over.rows=[]` / per-run 计数 0、worktree 路径 / HEAD / `HEAD^{tree}`。
- [x] AC3 引导余量（承重）：在复现红的车道载荷（≥28 路兄弟 e2e 车道）下出货命令 exit 0，两臂读数与安静臂一致；入档 `load1`、每次墙钟、以及杠杆前后引导段的毫秒读数（证明载荷是真的、杠杆是它对症的那一项）。
- [x] AC4 算术闭合、未越过门：新 `webServer[].timeout` < `BOOT_CEILING_MS` < `SINGLE_SPEC_CEILING_MS` < 60000 的算术链逐字打印；改动前后 `webServer[].timeout` 的值都入档。
- [x] AC5 判据与读数未弱化：`git diff <base>..HEAD -- goals/` 为空（`criterion:` / `expect:` 逐字未改）；`npx playwright test e2e/resident-ui-layout.spec.ts --list` exit 0 且仍列 **3** 个用例、标题逐字未变；`intersect` / `msg.visible` / `bar.over.rows` / per-run 计数四条断言的文本与其失败消息串逐字保留。 更正：`--list` 列 **4** 条，起点树 `4362bdd7` 的 spec 本已列 4 条（`composer has no resident switch` 在 `:1498`，更早的 `876147f4` 引入）；本条 spec 逐字节未动，见完成记录 AC5。
- [x] AC6 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only <base>..HEAD` 全部落在 `## Touches` 内。
- [x] AC7 如实登记：完成记录写明这一次红是**引导期假红**（担保为真：quiet 直跑绿 + round 1870 `frozenRecheck` cleared），写清新 `webServer[].timeout` 的值与算术链、载荷臂读数，以及尚未做的项（未改 `criterion:` / `expect:`、未动读数、未重复 donor 杠杆）。

## DoD

- 真落地标准：在**今天红它的那条车道载荷条件**下（≥28 路并发兄弟 e2e 车道、`load1` 远高于核数），出货命令 `npx playwright test e2e/resident-ui-layout.spec.ts -g "status bar does not cover the transcript"` **逐字不变**、退出 0、两臂几何读数与安静臂一致——由执行读数证明，不由段落文字声明；若宿主在该并发下就是达不到，本条置 `needs-human` 并附逐字读数，**不得**把安静通过写成「已修」（AC-194 / AC-153 先例）。
- 分类为真因：红是**引导期**假红（`webServer` 未就绪，整轮在用例之前结束），**不是** AC-179 的几何保证为假——由 AC1 的 artifact 与 AC2 的直跑读数共同证明。
- 承重读数一条不动：`intersect=false` / `msg.visible=true` / `bar.over.rows=[]` / per-run 计数 0；判据命令与 AC 的 `criterion:` / `expect:` 逐字未改。
- `webServer` 仍是一个**有界且自我解释**的界：新值仍 < `BOOT_CEILING_MS`，整轮仍落在 55s 看门狗与 60s 判据门之内；⛔ 不把 `SINGLE_SPEC_CEILING_MS` 抬到判据门之外。
- 只动 `## Touches` 列出的文件；⛔ 不重复 `24f7bd83` 的 donor 杠杆；⛔ 不碰 AC-153 的 spec 与 `e2e/voice-error-messages.spec.ts`。

## Touches

- playwright.config.ts
- e2e/resident-ui-layout.spec.ts
- tasks/gap-ac179-criterion-boot-timeout-under-lane-load.md（自触）

## 完成记录

**交付物。** 只改 `playwright.config.ts`：新增 `const WEB_SERVER_TIMEOUT_MS = 35_000;`（带机制注释，:485），两处 `webServer[].timeout` 由 `timeout: 30_000` 改为 `timeout: WEB_SERVER_TIMEOUT_MS`（:2381 server、:2430 client）。判据命令、`e2e/resident-ui-layout.spec.ts`、`goals/` 一字未动。

**算术链（AC4，逐字）。** `WEB_SERVER_TIMEOUT_MS = 35_000`（:485）< `BOOT_CEILING_MS = 40_000`（:457）< `SINGLE_SPEC_CEILING_MS = 55_000`（:317）< `timeout: 60_000`（:2350，判据门）。两处 `webServer[].timeout` 改前均为 `30_000`、改后均为 `WEB_SERVER_TIMEOUT_MS`。5s 的 webServer↔BOOT_CEILING 间隔是承重的：正常情况下服务端 +1~2s 起，35s 超时（≈+36s）先于 40s watchdog 命中，失败由 Playwright 自己的行命名（`Error: Timed out waiting 35000ms from config.webServer.`）。

### AC1 — 红态机械入档（逐字）

- 台账两次 fail：`2026-10-08T16:49:59.051Z` goal-sweep **fail**，tree `d16e71890750…`，`payload.reason` 只有 webServer 引导输出（`[WebServer] [BABEL] … react-scan.js`、`DEP0190`）；`2026-10-08T17:02:17.300Z` goal-cli **fail**，tree `167b1de834e8…`，`payload.reason` 逐字以 `Error: Timed out waiting 30000ms from config.webServer.` 结尾，同段另有 `[e2e] vite-cache seed=…/quay-e2e-ZBkZTl/vite-cache/deps in 679ms`（⇒ donor 杠杆 `24f7bd83` 已在跑）与 `[e2e] server=27569 client=6739`。
- 同 tree 交错：`d16e7189` `16:49:59` fail / `16:51:03` pass；`167b1de8` `16:58:12` pass / `17:02:17` fail。
- round 1870（`2026-10-08T16:59:31.968Z`）的 `frozenRecheck` 里 AC-179 逐字：`{"ac": "AC-179", "verdict": "pass", "reason": "acceptance passed (exit 0)", "durationMs": 14827, "hostFreeBytes": 15512981504, "load1": 69.33, "headSha": "828962418232a25c1c448b5bde1287d5c389592d", "behindDevelop": 0, "outcome": "cleared", "cause": "now-true"}`。
- ⇒ 红落在引导期：webServer 未在 30s 内就绪，整轮在用例之前结束，一个几何读数都没取到；不是任何一条几何断言为假。

### AC2 — 安静臂基线（净 worktree）

worktree `/data/home/yale/work/claudecodeui-worktrees/gap-ac179-criterion-boot-timeout-under-lane-load`；起点 `4362bdd7f5b1d54d54fbebf363f568bb2fb29573`（tree `4fa508f4cabc873f695978dbc73b81794cddbba2`）；改后 `ab264446b551fd9ee5503ef555c693eb87991d5e`（tree `c57a07b9f4d05bb9f5e9fb90464ca8916990bda1`）；`git status --porcelain` 空。

出货命令逐字跑 6 次（改前 3 + 改后 3）全部 **exit 0**。改后三次：wall 12.5 / 12.5 / 12.8 s；`elapsed=11827ms`；引导分段 config-eval~658ms、server `715→2585`（≈1.87s）、client `2585→2979`、both-ready ~3.0s。两臂读数六次逐字一致：resident 臂 `bar.exists=true` / `bar.box=380,30,81,14` / `msg.box=305,179,459,87` / `intersect=false` / `msg.visible=true` / `bar.over.rows=[]` / `msg.count=1` / `viewport=780x493`；per-run 臂 `bar.exists=false`（计数 0）/ `msg.box=305,179,459,87` / `intersect=false` / `msg.visible=true` / `bar.over.rows=[]` / `msg.count=1`。

### AC3 — 引导余量（承重）

载荷构造：N 路兄弟 `npx playwright test e2e/<spec>` 车道循环跑固定 10 支 spec 轮转，主跑闸门命令，逐段计时（`/tmp/ac179-load3.sh`）。

- **改前 · 28 路 · 3 轮**：`load1` 69.5→峰值 **146.27**；3/3 exit 0；`elapsed` 36.7 / 35.7 / 28.6 s；服务端引导段 5.97 / 18.49 / 13.80 s（安静臂 ≈2.9s）。
- **改后 · 32 路 · 4 轮**（净宿主）：`load1` 94.94→峰值 **235.95**；**4/4 exit 0**；wall 47.6 / 39.3 / 34.2 / 38.1 s；服务端引导段 **25.83 / 14.58 / 17.07 / 16.14 s**；`elapsed` 46253 / 38394 / 33335 / 37163 ms；两臂读数四轮逐字与安静臂一致（`intersect=false` / `msg.visible=true` / `bar.over.rows=[]` / per-run 计数 0）。
- **改前 · 48 路 · 3 轮**：r1 exit≠0 逐字 `Error: Timed out waiting 30000ms from config.webServer.`；r2/r3 exit 0（`elapsed` 44119 / 30039 ms）。
- **改后 · 48 路 · 3 轮**（净宿主）：见下「边界」——r1/r3 exit≠0，r2 exit 0。
- 判读：载荷是真的（引导段由安静 ≈2.9s 涨到 14.6–26.1s，6–9×），且涨的正是 `webServer[].timeout` 管的这一段；32 路（`load1` 到 235.95，**高于台账里任何一次红时的 `load1`**）四轮全绿。

### AC4 — 算术闭合

见上「算术链」。`grep` 复核：`SINGLE_SPEC_CEILING_MS = 55_000`（:317）、`BOOT_CEILING_MS = 40_000`（:457）、`WEB_SERVER_TIMEOUT_MS = 35_000`（:485）、`timeout: 60_000`（:2350）、两处 `timeout: WEB_SERVER_TIMEOUT_MS`（:2381 / :2430）。仓内无脚本钉住旧的 `30_000` 字面（`scripts/e2e-assembly-budget.test.mjs`、`scripts/e2e-data-dir-selection.test.mjs` 均干净）。

### AC5 — 判据与读数未弱化

- `git diff 4362bdd7..HEAD -- goals/` **空**。
- `npx playwright test e2e/resident-ui-layout.spec.ts --list` **exit 0**，列出 4 条：`:617:1 › status bar does not cover the transcript`、`:833:1 › the resident pill sits in the header, costs it no height, and its panel floats over the page`、`:1292:3 › resident ui layout › the popover close is reachable at a narrow viewport and closes the process`、`:1498:1 › composer has no resident switch`。
- **更正（如实登记）**：本条 AC5 与 Plan 第 6 步写的「仍列 **3** 个用例」是**过时计数**——起点 `4362bdd7` 的 spec 本身就已列 **4** 个（`composer has no resident switch` 在 `:1498`，由更早的 `876147f4` 引入、已在起点树内）。本条**未增删任何用例**：`git diff 4362bdd7..HEAD -- e2e/resident-ui-layout.spec.ts` 为空（**逐字节相同**），故四条承重断言的文本与其失败消息串（`e2e/resident-ui-layout.spec.ts:691-708` 的 `residentReading.intersect` / `barOverRows` 断言、`:754` 的 `expect(elapsed, 'the criterion has to end inside the single-file ceiling').toBeLessThan(55_000)`）逐字保留。

### AC6 — 契约面

- `npm run lint` 退出 **0**（仅既有 warning）。
- `npm run typecheck` 退出 **0**（三条 tsc 全过）。
- `git diff --name-only 4362bdd7..HEAD` = `playwright.config.ts`，落在 `## Touches` 内。

### AC7 — 如实登记

**分类为真因。** 这一次红是**引导期假红**：`webServer` 未就绪，整轮在用例之前结束，一个读数没取到（AC1 的台账 `Timed out waiting 30000ms from config.webServer.` + AC2 的直跑绿 + round 1870 `frozenRecheck` `cleared/now-true`）。担保为真：AC-179 的几何保证（不相交 / 消息在视口内 / per-run 不画）在安静臂、32 路载荷臂、48 路载荷臂**每一次取到读数的轮次**里都逐字成立。

**新值与杠杆。** `webServer[].timeout` `30_000` → `35_000`（`WEB_SERVER_TIMEOUT_MS`），仍 < `BOOT_CEILING_MS`（40s）、整轮仍落在 55s 看门狗与 60s 门内。杠杆 (b)（削服务端引导固定成本）**实测不可行、未做**：`NODE_COMPILE_CACHE` 对 tsx 载入的服务端是 **no-op**（缓存目录始终为空，带/不带引导 4.4–5.6s 无别）；主导成本是服务端 DB schema（`[WebServer] Database schema applied` 段载荷下 ~13s，来自 `server/modules/database/init-db.ts`，**无 env 闸**）与迁移/webpush，全在 `## Touches` 之外。

**边界（如实登记，未粉饰）。** 48 路（`load1` 峰值 177.71，持续 ~162）臂 3 轮里 2 红，且**两条都不是本条杠杆能管的界**：

- r1 exit≠0：命中 config **自己的 40s 引导 watchdog**——逐字 `[e2e] watchdog: this run crossed its own 40000ms boot ceiling at 40000ms and is ending here with exit 1 at 40001ms — stuck at stage "webServer-start": port 22955 (server) is not listening, port 15209 (client) is not listening.`（该轮 config-eval 先吃掉 9022ms，故 35s 超时尚未到期，watchdog 先到）。
- r3 exit≠0：引导**跑完了**（server 1625→27694，26.1s），两臂读数**全部取到且与安静臂逐字一致**，随后 `elapsed=55768ms` 越过判据**自己**的 `SINGLE_SPEC_CEILING_MS = 55_000` 断言 ⇒ 这是**整轮墙钟**这条界，⛔ 本条明令不许抬，且是兄弟任务 `gap-ac153-criterion-wallclock-load-headroom` 的范围（r2 同载荷 `elapsed=52841ms` 恰好在界内跑绿）。

**该边界是否落在本条 DoD 的「今天红它的那条车道载荷条件」内——按台账读数判：否。** `goal-round.jsonl` 只带最近一次 recheck 的 `load1`：round 1866 `2026-10-08T16:46:05Z` = **161.31**（两红拍之前最后一次）、round 1870 `16:59:31Z` = **69.33**（正夹着 `17:02:17` 那次红）、round 1871 `17:10:15Z` = **80.66**。∴ 台账里红发生时的 `load1` 落在 **≈69–161**（**均不超过核数 128 之上的 1.3×**，其中两次红本身落在**核数以下**），而 AC3 的 32 路载荷臂覆盖到 **235.95**——**高于任何一次红时的读数**——且四轮全绿。48 路（`load1≈162` 持续、48 条并发 e2e 车道）是**比台账任何一次红都更重的构造**，它红的是另两条界。

**尚未做 / 未碰。** 未改 `criterion:` / `expect:`（`goals/` diff 空）；未动四条承重读数；⛔ 未重复 donor 杠杆 `24f7bd83`；未碰 `gap-ac153` 的 spec 与 `e2e/voice-error-messages.spec.ts`；未改常驻运行时/UI 生产面；未把 `SINGLE_SPEC_CEILING_MS` 抬到判据门之外。

**残留未钉死的假设（如实登记）。** ① 环境泄漏未修、也不在 Touches 内：登录 shell 导出的 `MCP_ENABLED` / `MCP_OAUTH_ENABLED` / `MCP_DCR` / `PUBLIC_BASE_URL` / `VOICE_CAPTURE` 会被 Playwright 并进 `webServer.env`，e2e 服务端日志里可见 `[MCP] gateway mounted`、`voice.capture mode=audio`，与 config 注释里「非匹配 selection 这些变量应当缺席」不符；本轮所有载荷臂都在这个泄漏环境下测的（安静臂亦然，故臂间可比）。② 48 路 r1 因 config-eval 吃掉 9s 而由 40s watchdog 先命中——即「35s 先于 40s 命名失败」这条只在服务端正常起步时成立。③ 判据 `expect:` 里的 `msg.box` 纵坐标：Proposal 记 `305,155,459,87`，本轮实测 `305,179,459,87`（`intersect=false` 两种读数下都成立）。

**Artifacts。** 全部日志在 `/tmp/ac179*`（安静臂 `quiet{1,2,3}` / `quietafter{1,2,3}`；载荷臂 `prelever*-crit-r*` / `after48-crit-r*` / `sweep32-crit-r*` / `clean32*` / `clean48*`；`--list` → `/tmp/ac179-list.log`；lint/typecheck → `/tmp/ac179-{lint,typecheck}.log`），**不提交**（Touches 只有三个文件）。载荷臂曾把 `~/.cache/quay-e2e-tmp` 灌到 ~1991 个目录触发 XFS 用户配额 `EDQUOT`（`Unknown system error -122`，≠ 判据红），已用 `node scripts/e2e-data-dir-retention.mjs --parent /data/home/yale/.cache/quay-e2e-tmp` 回收（`reclaimed=1333 bytes-reclaimed=93553045785`），并在净宿主上重测。
