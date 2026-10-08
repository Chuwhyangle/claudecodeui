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

- [ ] AC1 红态分类机械入档：`gate-events.jsonl` 里 AC-179 两次 fail 逐字入档（`2026-10-08T16:49:59Z` goal-sweep tree `d16e7189`；`2026-10-08T17:02:17Z` goal-cli tree `167b1de8`，其 `payload.reason` 以 `Error: Timed out waiting 30000ms from config.webServer.` 结尾），并登记**同 tree 交错**（`d16e7189` 16:49 fail / 16:51 pass；`167b1de8` 16:58 pass / 17:02 fail）与 round 1870 的 `frozenRecheck`（`verdict: pass, outcome: cleared, cause: now-true`）；据此证明红落在引导、不在任何几何断言。
- [ ] AC2 安静臂基线：净 worktree 上出货命令逐字跑 ≥3 次，全部 exit 0；入档每次 `elapsed=`、`intersect=false` / `msg.visible=true` / `bar.over.rows=[]` / per-run 计数 0、worktree 路径 / HEAD / `HEAD^{tree}`。
- [ ] AC3 引导余量（承重）：在复现红的车道载荷（≥28 路兄弟 e2e 车道）下出货命令 exit 0，两臂读数与安静臂一致；入档 `load1`、每次墙钟、以及杠杆前后引导段的毫秒读数（证明载荷是真的、杠杆是它对症的那一项）。
- [ ] AC4 算术闭合、未越过门：新 `webServer[].timeout` < `BOOT_CEILING_MS` < `SINGLE_SPEC_CEILING_MS` < 60000 的算术链逐字打印；改动前后 `webServer[].timeout` 的值都入档。
- [ ] AC5 判据与读数未弱化：`git diff <base>..HEAD -- goals/` 为空（`criterion:` / `expect:` 逐字未改）；`npx playwright test e2e/resident-ui-layout.spec.ts --list` exit 0 且仍列 **3** 个用例、标题逐字未变；`intersect` / `msg.visible` / `bar.over.rows` / per-run 计数四条断言的文本与其失败消息串逐字保留。
- [ ] AC6 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only <base>..HEAD` 全部落在 `## Touches` 内。
- [ ] AC7 如实登记：完成记录写明这一次红是**引导期假红**（担保为真：quiet 直跑绿 + round 1870 `frozenRecheck` cleared），写清新 `webServer[].timeout` 的值与算术链、载荷臂读数，以及尚未做的项（未改 `criterion:` / `expect:`、未动读数、未重复 donor 杠杆）。

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
