---
id: gap-ac173-ledger-red-is-boot-ceiling-crossed
title: AC-173 台账尾巴 2026-10-13T16:37:26.220Z 的红是 e2e 引导越过 config 自己的 40s
  引导天花板看门狗（该跑 watchdog-state.json =
  {"armed":true,"fired":true,"ceilingMs":40000,"detail":"boot ceiling crossed at
  40000ms"}、test-results/ 空 ⇒ 一条断言未跑）而非判据假：同 treeSha 4ee9b532 净检直跑为绿（3 passed /
  exit 0 / elapsed=38533ms），重跑并钉住「引导越界 ≠ 判据假」+ 负载余量读数
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-173
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-173 `status: achieved`，其 GOAL-013 已 achieved 且不再活，未声明 `long-term: true`；台账尾部 `2026-10-13T16:37:26.220Z` 那拍记为 fail，故按 CURRENTLY FALSE 立案。

判据物（逐字取自 `goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md`）。`criterion:` = `npx playwright test e2e/resident-running-view.spec.ts`。`expect:` 逐字：「调试 agent 场景造出一个运行中的会话与两个空闲常驻会话：侧栏 Running 徽标读数为 1；Running 视图两组各列出对应会话，第二组每行有关闭按钮，点击后该会话宿主关闭、从该组消失。取假形态：徽标计入空闲常驻会话 ⇒ 读数 3，必须红。」

<!-- dedup-ref --> 机制去重读数（本轮立案实测，checkout `/data/home/yale/work/claudecodeui`，branch `author`，`git rev-parse HEAD` = `b79473a9971554757392571ee35769e2e6b8c64b`，`HEAD^{tree}` = `af86c35154be8c8560f9d0d79554ef0114f42fa9`）：`grep -rln '^goal_ac: *AC-173' tasks/` 命中 4 份，`status:` 逐字皆 **done**（`gap-resident-running-view-criterion-bounded-boot-guard`、`gap-claude-resident-running-view`、`gap-ac173-badge-source-mismatch-after-dock-consolidation`、`gap-ac173-ledger-red-is-uncommitted-composer-wip`）；在飞扫描（`^status:` ∈ todo/ready/needs-human）**无一认领 AC-173** ⇒ 无在飞认领者。按「done 不算重复、是更早修法没兜住的证据」：`gap-resident-running-view-criterion-bounded-boot-guard` 钉的是 spec **体内**客户端启动的有界导航（cases 之前），`gap-ac173-ledger-red-is-uncommitted-composer-wip` 修的是**主检出未提交 composer WIP** 在判据运行期被保存引发的 HMR 崩，`gap-ac173-badge-source-mismatch-after-dock-consolidation` 修的是徽标**数据源**，`gap-claude-resident-running-view` 是常驻视图本体——**没有一条**碰过「config **自己的 40s 引导天花板看门狗**在任何用例之前把整轮打死」这条机制。同族先例各治**别的**界、本条不重复：`gap-ac179-criterion-boot-timeout-under-lane-load`（done）治 Playwright 自己的 `webServer[].timeout`（`30_000`→`35_000`），其完成记录逐字登记过「48 路 r1 命中 config 自己的 40s 引导 watchdog」并明写该形态**不在其 DoD 内**；`gap-ac171-criterion-run-ceiling-crossed-under-lane-load`（done）治越过 **55s 运行**看门狗的 `Channel closed`；`gap-e2e-runner-boot-inflation-under-fan-in-concurrency`（done）治引导**固定成本膨胀**（vite donor 杠杆）。本条的红落在**引导天花板**（`BOOT_CEILING_MS = 40_000`）这条三者**都未覆盖**的界上 ⇒ 本条不是重复。

**本轮直接测量（读数不是推断）**

（1）**判据净检直跑 → 绿**：在 HEAD `67ca7406`（其 `HEAD^{tree}` = `4ee9b532fb45581a7ab24d7c39c890aac38f7292`，与下面那拍 fail 的 treeSha **逐字相同**）上重跑出货命令 `npx playwright test e2e/resident-running-view.spec.ts` → **EXIT 0**，`3 passed (39.1s)`，`elapsed=38533ms`。判据自己打印的读数逐字（节选，全文 `/tmp/ac173-run.log`）：

```
hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1
badge.text="1" badge.label="1 running sessions"
group.running.count=1 group.residentIdle.count=2
close.request=200
hosts.beforeClose=2 hosts.afterClose=1
badge.reading.after=1
shared.perBinding=1 shared.perHost=2 badge.reading=1
DEBUG_AGENT_RUN_SEAM_UNAVAILABLE=0 controlPlane.responses=8
locales.checked=12 keys.checked=11 missing=0
elapsed=38533ms
  3 passed (39.1s)
EXIT=0
```

⇒ **被提交的树满足 AC-173**：徽标读 1（`badge.reading=1`，不是 idle 计入的 3）、两组各列对应会话（running 组 1 条 / resident-idle 组 2 条）、关闭按钮请求 200 且宿主数 2→1、计数器绑会话不绑宿主（`shared.perBinding=1 shared.perHost=2`）。**取假形态未出现**（若徽标计入空闲常驻会读 3）。

（2）**台账尾巴**（`.quay/gate-events.jsonl`，`item_id=AC-173`、`gate=goal`）**末五拍**：`2026-10-13T16:01:41.299Z pass` → `16:10:27.537Z pass` → `16:19:26.684Z pass` → `16:28:20.272Z pass` → `2026-10-13T16:37:26.220Z fail`（序列 `pass,pass,pass,pass,fail`）。历史合计 561 pass / 249 fail。

（3）**关键读数：那拍 fail 与本次直跑跑在同一棵树上**。`16:37:26.220Z` 那拍 `payload.treeSha` = `4ee9b532fb45581a7ab24d7c39c890aac38f7292` = 本次直跑 HEAD 的 `HEAD^{tree}`（`git rev-parse 67ca74067^{tree}` 逐字相同）。同一棵树，`16:37:26Z` 记 fail、本次直跑 EXIT 0 ⇒ 红**不在树里**。（当前 checkout 已前进到 `b79473a9`／tree `af86c351`，二者之差 `git diff --name-only 4ee9b532 af86c351` = **仅** `tasks/gap-live-voice-interrupt-missing-intent-drops-stop.md`；`e2e/ server/ src/ scripts/ playwright.config.ts` 差集 **空** ⇒ 两棵树判据输入代码逐字节相同。）

（4）**决定性工件：那拍失败跑是被 config 自己的 40s 引导天花板看门狗打死的，不是任何断言。** 台账 `payload.reason` 只含 webServer 的 stderr 噪声（`[WebServer] [BABEL] … react-scan.js?…`、`[DEP0190] …`），**不含任何判据读数 token**。按 reason 里的 data-dir 路径定位到那次失败跑的 `~/.cache/quay-e2e-tmp/quay-e2e-XyGwOL`，其 `watchdog-state.json`（mtime `2026-10-14 00:37:26.150 CST` = `16:37:26.150Z`，与 gate 事件 `16:37:26.220Z` 对得上）逐字：

```json
{"armed": true, "fired": true, "ceilingMs": 40000, "detail": "boot ceiling crossed at 40000ms"}
```

其 `test-results/` 目录**为空**（一条用例都没开始）⇒ 判据本体**一条断言都没跑到**：config 的引导天花板在 Playwright 的 pre-spawn 可用性探针（**没有自己的 deadline**）上命中，整轮在任何用例之前结束、exit 1，台账记为 `verdict: fail`。

<!-- dedup-ref --> **机制（读 config 自己的注释，逐字）。** `playwright.config.ts:570` `const BOOT_CEILING_MS = 40_000;`；`:784` `arm(BOOT_CEILING_MS, 'boot ceiling', true);`；`:718` `writeWatchdogState({ armed: true, fired: true, ceilingMs: ceiling, detail: "<label> crossed at <crossedAt>ms" });`。config 自述（`:537-538` 逐字）：「Before both webServers answer, a run is on the path nothing bounds, and `BOOT_CEILING_MS` bounds it there.」即这条界的存在目的就是兜「两个 webServer 尚未应答」这段无人界的路。与 `gap-ac179-criterion-boot-timeout-under-lane-load` 的关系：先把 `webServer[].timeout` 抬到 35s（`WEB_SERVER_TIMEOUT_MS`）**不能**救这一形态——`:591-594` 逐字写明算术 `WEB_SERVER_TIMEOUT_MS (35s) < BOOT_CEILING_MS (40s) < SINGLE_SPEC_CEILING_MS (55s) < 60s`，且「The 5s gap to `BOOT_CEILING_MS` is load-bearing」；当 config 求值吃掉 >5s 时，40s 引导天花板比 35s webServer 超时**更早命中**（`gap-ac179-…` 完成记录登记过这个 48 路 r1 形态）。这一次就是它。

**这条是什么、不是什么**：verification-only 归因入档。它**不**改实现、判据、`playwright.config.ts`、宿主配置一个字节，只在同一棵树上重跑判据、读台账、读那次失败跑自己的工件，把「引导天花板越界 ≠ 判据假」的区分钉成下次可机械复用的判法。remedy（进一步削引导固定成本／给引导可证余量／降 fan-in 并发）属 **e2e 基建族**（`playwright.config.ts` 的引导段、`scripts/e2e-data-dir-*`），**不在本条内夹带**。

## Plan

1. 在同一 checkout（记录 `git rev-parse HEAD` 与 `HEAD^{tree}`）跑出货命令 `npx playwright test e2e/resident-running-view.spec.ts` 一次，读退出码、`3 passed`、`elapsed=`，并把判据自己打印的读数行**逐字**抄进完成记录；跑前后各取 `git status --porcelain` 与 `git rev-parse HEAD^{tree}`，证明没有边跑边改树。
2. 机械读台账（`jq`）：打印 AC-173 `gate=goal` 末五拍 `verdict` 序列；逐字给出 `16:37:26.220Z` 那拍的 `payload.reason` 与 `payload.treeSha`；证明该 `treeSha` 等于本 checkout（本次直跑 HEAD）的 `HEAD^{tree}`；给出 `git diff --name-only <那拍 tree> <当前 tree>` 只含 `tasks/**`。
3. **决定性工件**：按 `payload.reason` 里的 data-dir 路径读其 `watchdog-state.json`，逐字登记 `{"armed":true,"fired":true,"ceilingMs":40000,"detail":"boot ceiling crossed at 40000ms"}`，证明其 mtime 对得上那拍 fail，且 `test-results/` 为空（一条用例未跑）。若该目录已被回收，如实写「已回收」并只登记台账与 config 注释读数（⛔ 不把没核实的目录认成这次失败跑）。
4. **分辨力（承重）**：把「判据本体的读数集合」与「fail reason 的文本」逐条对照，证明二者**零交集**（reason 只含 `[WebServer]`/`[BABEL]`/`react-scan.js`/`[DEP0190]`，不含 `badge.reading`/`group.running.count`/`close.request`/`shared.perBinding` 等任何一条），并给出同 treeSha 的红/绿对照（`4ee9b532`：`16:37:26Z` fail vs 本次直跑 pass）。
5. **负载余量读数（承重）**：本次直跑 `elapsed=` 与判据自带上限 `elapsed < 55_000`（`e2e/resident-running-view.spec.ts:1178` 逐字）比出余量；并逐字引 `playwright.config.ts:591` 的算术链（`WEB_SERVER_TIMEOUT_MS (35s) < BOOT_CEILING_MS (40s) < SINGLE_SPEC_CEILING_MS (55s) < 60s`）说明「引导越界」与「判据假」之间还夹着这条 40s 界。
6. 只把 `tasks/<本条 id>.md` 写进交付；实现/判据/config/宿主配置一字不改。

## AC

- [ ] AC1 判据在同 checkout 上直跑：`npx playwright test e2e/resident-running-view.spec.ts` 退出 **0**、`3 passed`；完成记录里逐字给出 `git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`date -u`，以及判据自己打印的读数行（至少含 `hosts.running=1`、`hosts.residentIdle=2`、`badge.reading=1`、`badge.text="1"`、`group.running.count=1`、`group.residentIdle.count=2`、`close.request=200`、`badge.reading.after=1`、`shared.perBinding=1`、`DEBUG_AGENT_RUN_SEAM_UNAVAILABLE=0`、`locales.checked=12 keys.checked=11 missing=0`、`elapsed=`）。红态基线（本轮立案读数）：台账 `2026-10-13T16:37:26.220Z` 记 fail。
- [ ] AC2 台账归因（机械、可被任何人复现）：打印 AC-173 `gate=goal` 末五拍 `verdict` 序列（应为 `pass,pass,pass,pass,fail`）；逐字给出 `16:37:26.220Z` 那拍的 `payload.reason` 与 `payload.treeSha`；证明该 `treeSha` 等于本 checkout（本次直跑 HEAD）的 `HEAD^{tree}`；给出 `git diff --name-only <那拍 tree> <当前 HEAD^{tree}>`，其含 `tasks/**` 而 `e2e/ server/ src/ scripts/ playwright.config.ts` 差集为空。
- [ ] AC3 决定性工件（承重）：逐字登记那次失败跑 data dir 的 `watchdog-state.json` = `{"armed":true,"fired":true,"ceilingMs":40000,"detail":"boot ceiling crossed at 40000ms"}`，给出其 mtime 与那拍 gate 事件时间的对应，并证明其 `test-results/` 为空；若目录已回收则如实写「已回收」。同时逐字引 `playwright.config.ts` 里 `BOOT_CEILING_MS = 40_000`（`:570`）、`arm(BOOT_CEILING_MS, 'boot ceiling', true)`（`:784`）与 config 自述 `:537-538`「Before both webServers answer, a run is on the path nothing bounds, and `BOOT_CEILING_MS` bounds it there.」
- [ ] AC4 分辨力（承重）：判据本体读数集合与 `16:37:26.220Z` 的 fail reason 文本**零交集**——把两组字符串并列入档，并给出同 treeSha（`4ee9b532fb45581a7ab24d7c39c890aac38f7292`）下 `16:37:26Z` fail 与本次直跑 pass 的对照。⚠️ 若本次直跑为红，本条归因不成立，见 DoD 的停手条款。
- [ ] AC5 负载余量读数（承重）：给出本次直跑 `elapsed=` 与其对判据自带上限 `elapsed < 55_000`（`e2e/resident-running-view.spec.ts:1178` 逐字）的余量，并逐字给出 `playwright.config.ts:591` 的算术链 `WEB_SERVER_TIMEOUT_MS (35s) < BOOT_CEILING_MS (40s) < SINGLE_SPEC_CEILING_MS (55s) < 60s`；写成「下次若在**引导期**红（reason 只含 webServer stderr、`watchdog-state.json` 的 `ceilingMs` = `40000` 且 `detail` 含 `boot ceiling crossed`）⇒ 引导越界，与本次同形、与判据假可分开」。
- [ ] AC6 空 delta 且不夹带：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；完成记录声明本条**未**改 `e2e/resident-running-view.spec.ts`、`src/**`、`server/**`、`scripts/**`、`playwright.config.ts`，并指明 remedy（削引导固定成本／给引导余量／降 fan-in 并发）属 e2e 基建族、不在本条内修；跑前后 `git status --porcelain` 逐字相同。

## DoD

- 出货命令（`npx playwright test e2e/resident-running-view.spec.ts`，逐字不改；⛔ 不加 `-g`、不 skip、不加 `retries`、不改断言）真的在同一 checkout 上跑过，读数行逐字入档——不是复述 `expect` 的文字，不是读台账尾巴。
- 台账归因与那条决定性工件（`watchdog-state.json`）的每一条读数都能由任何人在同一 checkout 上复现（给出逐字命令与逐字输出）；失败跑 data dir 若已回收，如实登记「已回收」而**不**臆造归因。
- 完成记录明确写出判法：**「AC-173 台账 `2026-10-13T16:37:26Z` 那拍红 = e2e 引导越过 config 自己的 40s 引导天花板看门狗（`BOOT_CEILING_MS`，`watchdog-state.json` `boot ceiling crossed at 40000ms`，`test-results/` 空），判据本体未跑 ⇒ 引导越界 ≠ 判据假」**，并写明早先四条 AC-173 任务与三条同族引导任务各修了别的机制、本条是其外的第八条机制。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、`playwright.config.ts`、宿主配置一个字节未动。
- 若直跑为**红**（即红不落在引导、而落在判据自己的断言上，或 `badge.reading=3` 的假形态出现），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，引导越界归因不成立，应按缺陷任务重立」——⛔ 不得把环境红写成产品绿，也不得据此改断言。
- 若直跑为绿而台账尾巴在本条收尾前已被 driver 的下一拍翻成 pass，如实抄那一拍；否则逐字写「台账尾巴仍是 fail」并附 AC1 的直跑读数，⛔ 不得写成已通过。

## Touches

- tasks/gap-ac173-ledger-red-is-boot-ceiling-crossed.md（自触）
- e2e/resident-running-view.spec.ts（本条只跑不改：判据本体与 `:1178` 的 `elapsed < 55_000` 上限）
- goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md（本条只读不改：criterion/expect 的逐字来源）
- playwright.config.ts（本条只读不改：`BOOT_CEILING_MS` / `arm(...)` / `writeWatchdogState` / 算术链注释的读数来源）