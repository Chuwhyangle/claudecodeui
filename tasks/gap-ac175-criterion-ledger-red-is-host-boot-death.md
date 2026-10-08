---
id: gap-ac175-criterion-ledger-red-is-host-boot-death
title: AC-175 台账尾巴的红是宿主启动死（EDQUOT 同一族，sqlite「unable to open database file」落在
  runMigrations）而非判据假：同 treeSha 直跑为绿，重跑并钉住「宿主启动死 ≠ 判据假」+ 负载余量读数
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-175
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-175 `status: achieved`，其 GOAL-013 已 achieved 且不再活，未声明 `long-term: true`；台账尾部 `2026-10-08T23:04:01.806Z` 那拍记为 fail，故按 CURRENTLY FALSE 立案。

判据物（逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`）：`npx playwright test e2e/resident-busy-send.spec.ts`。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，checkout `/data/home/yale/work/claudecodeui`，branch `author`，`git rev-parse HEAD` = `853abee54e74e18247efc214d76988c720fd9e76`，其 `HEAD^{tree}` = `2708492cd53eaef96758fb970f2b5d75975987e4`）：`grep -rln '^goal_ac: *AC-175' tasks/` 命中 6 份，`status:` 逐字皆 **done**（`gap-claude-resident-busy-send-ui`、`gap-ac175-criterion-bounded-boot-guard`、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-ac175-criterion-anchor-retired-by-dock-consolidation`、`gap-ac175-criterion-red-is-uncommitted-composer-wip`、`gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`）。在飞扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human）**无一认领 AC-175** ⇒ 无在飞认领者。按「done 不算重复、是更早修法没兜住的证据」，本条与它们各是**不同机制**：前六条分别修的是启动守卫、锚点退役、心跳控制帧崩合并、未提交 composer WIP 的启动期/运行期崩——**没有一条**碰过下面这条「宿主资源把判据的 server 启动打死」的机制。同族先例 `gap-ac153-ledger-red-is-host-quota`（AC-153，**done**）与本条同机制、异判据；另一条在飞的 `gap-ac153-criterion-budget-rescale-unmerged`（`ready`，AC-153 的整轮 wallclock 预算）与本条**改的文件不相交**（它动 `e2e/voice-error-messages.spec.ts`，本条一字不改）。⇒ 本条不是重复。

**本轮直接测量（读数不是推断）**

（1）**判据直跑 → 绿**（立案前在同一 checkout 上重跑出货命令）：`npx playwright test e2e/resident-busy-send.spec.ts` → **EXIT 0**，`3 passed (37.2s)`，`elapsed=40537ms`。判据自己打印的读数逐字：

```
resident.queuedCard=0
resident.row.present=true
resident.row.annotationKey=resident.pending.annotation
resident.row.annotation=Will be handled after this answer finishes
withdraw.visibleBefore=true
click.dispatched=true
ui.withdrawnBeforeEvent=false
ui.withdrawnAfterEvent=true
row.presentAfter=false
row.textAfter="Withdrawn"
turnsAfterWithdraw=0
turns.control=1
cancelPayloads=1
controlResponsesForCancel=0
cancelAckFrames=1
cancelVerdictSource=command_lifecycle
beforeStarted.withdrawButton=1
afterStarted.withdrawButton=0
afterStarted.annotationKey=resident.pending.started
afterStarted.label=Started processing
perRun.queuedCard=1
perRun.card.label=Queued
locales.checked=12 keys.perLocale=4 missing=0
```

⇒ **被提交的树满足 AC-175**：常驻会话不发 QueuedMessageCard（`resident.queuedCard=0`）、消息立即入记录并带标注、撤回前不宣告（`ui.withdrawnBeforeEvent=false`）、收到 `cancelled` 后才宣告并把该行移除（`ui.withdrawnAfterEvent=true` / `row.presentAfter=false` / `turnsAfterWithdraw=0`）、撤回判据取自 `command_lifecycle`（`cancelVerdictSource=command_lifecycle`、`cancelAckFrames=1`）、出队后按钮消失并显示已开始（`afterStarted.withdrawButton=0`）、per-run 仍画卡（`perRun.queuedCard=1`）。

（2）**台账尾巴（`.quay/gate-events.jsonl`，`item_id=AC-175`、`gate=goal`）末五拍**：`2026-10-08T20:50:02.779Z pass` → `21:51:28.586Z pass` → `22:54:59.086Z fail`（`treeSha=68a001b2474c…`）→ `22:56:59.767Z pass`（goal-cli，同 `68a001b2…`）→ `2026-10-08T23:04:01.806Z fail`（goal-cli，**`treeSha=2708492cd53eaef96758fb970f2b5d75975987e4`**）。

（3）**关键读数：那拍 fail 与本次直跑跑在同一棵树上**。`23:04:01` 那拍的 `treeSha` = `2708492cd53eaef96758fb970f2b5d75975987e4` = 本 checkout 现在 `HEAD^{tree}`（`git rev-parse HEAD^{tree}` 实测逐字相同）。同一棵树，`23:04:01Z` 记 fail、本次直跑 EXIT 0 ⇒ 红**不在树里**。

（4）**那拍据以判 fail 的读数逐字**（`payload.reason`）：`acceptance failed (exit 1) — [WebServer] Error running migrations: unable to open database file [WebServer] [ERROR] Failed to start server: SqliteError: unable to open database file [WebServer] at Database.exec (.../node_modules/better-sqlite3/lib/methods/wrappers.js:9:14) [WebServer] at runMigrations (.../server/modules/database/migrations.ts:1053:8) [WebServer] at initializeDatabase (...`。即：**判据的 server 在启动迁移阶段就死了**（sqlite `SQLITE_CANTOPEN`，`errno` 家族为配额/空间），**判据本体一条断言都没跑到**（reason 里不含上节任何一条读数）。

**这与什么同族**：`unable to open database file` 是宿主**用户配额耗尽（EDQUOT，`errno −122`）**在「写 sqlite 文件」这个面上的样子（同族在 `mkdtemp` 面上报 `Unknown system error -122`）。台账里 `unable to open database file` 全库**仅 1 条**（正是 AC-175 这拍）；而 `Unknown system error -122` 的启动死台账里有成批，且 **AC-175 占 3 次**（`2026-09-27T21:04:33.616Z`、`2026-09-27T21:05:54.631Z`、`2026-09-28T13:04:50.847Z`），同窗还有 AC-151/153/171/172/173/174 同因 —— 这个指纹正是 `gap-ac153-ledger-red-is-host-quota` 已归因过的宿主配额启动死。宿主实测：`mount | grep ' /data '` = `/dev/vdb on /data type xfs (rw,relatime,attr2,inode64,logbufs=8,logbsize=32k,usrquota,prjquota)`（**有用户配额**）；驱动环境 `TMPDIR` 未设 ⇒ `scripts/e2e-data-dir-selection.mjs` 的候选序把运行目录放进 `$HOME/.cache/quay-e2e-tmp`（实测 `2072` 个目录 / `149G`），与 `/data/scratch/yale` 同在带配额的 `/data` 卷上；`df` 对配额无读数（仍报数 TB 空闲），所以「容量够」不能反驳「配额满」。

**为什么早先的修复没兜住**：前六条 AC-175 任务各修一条**别**的机制（启动守卫 / 锚点 / 心跳帧 / composer WIP），**没有一条**动「判据的运行目录落在被配额打死的池子里」这条——于是宿主一挤，AC-175 就以「启动死」的形态复发（09-27/09-28 两次 EDQUOT、10-08 一次 SQLITE_CANTOPEN）。

**这条是什么、不是什么**：verification-only 归因入档。它**不**改实现、判据、宿主配置一个字节，只在同一棵树上重跑判据、读台账、读宿主，把「宿主启动死 ≠ 判据假」的区分钉成下次可机械复用的判法；并给出 remedy（驱动侧把判据的运行目录换到有余量的池子、或先把 `quay-e2e-tmp` 回收下去——`npm run e2e:reclaim` 是现成入口）。该 remedy 属 e2e 基建族（`scripts/e2e-data-dir-*`、`playwright.config.ts`），**不在本条内夹带**。

## Plan

1. 在同一 checkout（记录 `git rev-parse HEAD` 与 `HEAD^{tree}`）跑出货命令 `npx playwright test e2e/resident-busy-send.spec.ts` 一次，读退出码、`3 passed`、`elapsed=`，并把判据自己打印的读数行**逐字**抄进完成记录；跑前后各取 `git status --porcelain` 与 `git rev-parse HEAD^{tree}`，证明没有边跑边改树。
2. 机械读台账（`python3` 或 `jq`）：打印 AC-175 `gate=goal` 末五拍的 `verdict` 序列；逐字给出 `23:04:01.806Z` 那拍的 `payload.reason` 与 `payload.treeSha`；统计全库 `unable to open database file` 条数；列出 `Unknown system error -122` 启动死的 AC-175 历史条数与同窗 AC 名单；打印 `23:03:55.361Z AC-153 pass` 这条（证明 6 秒前邻居判据还活着 ⇒ 不是全场停机，是**阵发**配额）。
3. 分辨力（承重）：把「判据本体的读数集合」与「fail reason 的文本」逐条对照，证明二者**零交集**（reason 只含 `runMigrations` / `unable to open database file`，不含 `resident.queuedCard` / `cancelAckFrames` / `afterStarted.withdrawButton` 等任何一条），并给出同 treeSha 的红/绿对照（`2708492c…`：`23:04:01Z` fail vs 本次直跑 pass）。
4. 宿主读数：`mount | grep ' /data '`（`usrquota,prjquota`）、`ls $HOME/.cache/quay-e2e-tmp | wc -l` 与 `du -sh`、`df -h /data`（容量 ≠ 配额）。若那条失败跑的 data dir 还在（看运行目录里 `auth.db` 是否 0 字节且带 `auth.db-journal`，其 mtime 对得上 `23:04Z`），把它的路径与该签名入档；若已被回收，如实写「已回收」并只登记台账与池级读数（⛔ 不得把没核实的目录认成这次失败跑）。
5. 负载余量读数：本次直跑的 `elapsed` 与判据自带的吞吐上限 `elapsed < 55_000`（`e2e/resident-busy-send.spec.ts:1076`）比出余量（承重，判「下次红是负载跨越还是启动死」要能分开）。
6. 只把 `tasks/<本条 id>.md` 写进交付；实现/判据/宿主配置一字不改。

## AC

- [x] AC1 判据在同 checkout 上直跑：`npx playwright test e2e/resident-busy-send.spec.ts` 退出 **0**、`3 passed`；完成记录里逐字给出 `git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`date -u`，以及判据自己打印的读数行（至少含 `resident.queuedCard=0`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1`、`elapsed=`）。红态基线（本轮立案读数）：台账 `2026-10-08T23:04:01.806Z` 记 fail。
- [x] AC2 台账归因（机械、可被任何人复现）：打印 AC-175 `gate=goal` 末五拍 `verdict` 序列（应为 `pass,pass,fail,pass,fail`）；逐字给出 `23:04:01.806Z` 那拍的 `payload.reason` 并指出其中含 `runMigrations` 与 `unable to open database file`；给出该拍 `payload.treeSha` 并证明它等于本 checkout 的 `HEAD^{tree}`；统计全库 `unable to open database file` 条数（应为 1）与 `Unknown system error -122` 启动死的 AC-175 历史条数（应为 3）及同窗 AC 名单（至少 AC-151/153/171/172/173/174）；逐字给出 `23:03:55.361Z AC-153 pass` 这条。
- [x] AC3 分辨力（承重）：判据本体读数集合与 `23:04:01.806Z` 的 fail reason 文本**零交集**——把两组字符串并列入档，并给出同 treeSha（`2708492cd53eaef96758fb970f2b5d75975987e4`）下 `23:04:01Z` fail 与本次直跑 pass 的对照。⚠️ 若本次直跑为红，本条归因不成立，见 DoD 的停手条款。
- [x] AC4 宿主读数：逐字给出 `mount | grep ' /data '` 一行（含 `usrquota`/`prjquota`）、`ls $HOME/.cache/quay-e2e-tmp | wc -l`、`du -sh $HOME/.cache/quay-e2e-tmp`、`df -h /data`；并写明「`df` 报空闲 ≠ 配额未满」。失败跑 data dir 的 `auth.db`/`auth.db-journal` 签名**只在核实其对得上 `23:04Z` 时才入档**，否则如实写「已回收/不可辨认」。
- [x] AC5 负载余量读数（承重）：给出本次直跑 `elapsed=` 与其对判据自带上限 `elapsed < 55_000`（`e2e/resident-busy-send.spec.ts:1076` 逐字）的余量，写成「下次若在启动**之后**红且 `elapsed` 逼近/越过 55_000 ⇒ 负载跨越，与本次『启动死』可分开」。
- [x] AC6 空 delta 且不夹带：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；完成记录声明本条**未**改 `e2e/resident-busy-send.spec.ts`、`src/**`、`server/**`、`scripts/e2e-data-dir-selection.mjs`、`playwright.config.ts`，并指明 remedy（驱动侧换有余量的运行目录 / 先 `npm run e2e:reclaim`）属 e2e 基建族、不在本条内修；跑前后 `git status --porcelain` 逐字相同。

## DoD

- 出货命令（`npx playwright test e2e/resident-busy-send.spec.ts`，逐字不改；⛔ 不加 `-g`、不 skip、不加 `retries`、不改断言）真的在同一 checkout 上跑过，读数行逐字入档——不是复述 `expect` 的文字，不是读台账尾巴。
- 台账归因的每一条读数都能由任何人在同一 checkout 上从 `.quay/gate-events.jsonl` 复现（给出逐字命令与逐字输出）。
- 完成记录明确写出判法：**「AC-175 台账 `2026-10-08T23:04:01Z` 那拍红 = 宿主配额在 server 启动迁移阶段把判据打死（sqlite `unable to open database file`，同族 EDQUOT），判据本体未跑 ⇒ 宿主启动死 ≠ 判据假」**，并写明早先六条 AC-175 修复各修了别的机制、本条是其外的第七条机制。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、宿主配置一个字节未动。
- 若直跑为**红**（即红不依赖宿主资源、落在判据自己的断言上），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，宿主启动死归因不成立，应按缺陷任务重立」——⛔ 不得把环境红写成产品绿，也不得据此改断言。
- 若直跑为绿而台账尾巴在本条收尾前已被 driver 的下一拍翻成 pass，如实抄那一拍；否则逐字写「台账尾巴仍是 fail」并附 AC1 的直跑读数，⛔ 不得写成已通过。

## Touches

- tasks/gap-ac175-criterion-ledger-red-is-host-boot-death.md（自触）
- e2e/resident-busy-send.spec.ts（本条只跑不改：AC1 的判据本体与 `:1076` 的 `elapsed < 55_000` 上限）
- goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md（本条只读不改：criterion/expect 的逐字来源）
- scripts/e2e-data-dir-selection.mjs（本条只读不改：判据运行目录的候选序与选择，AC4 的池级读数来源）
- playwright.config.ts（本条只读不改：运行目录选择与回收的接线，AC4/AC6 的读数来源）
## 完成记录

本条是 **verification-only**：不改实现、判据、宿主配置、宿主缓存一个字节。判据本体在本条自己的隔离 worktree 上被真的跑过一次（不是复述 expect、不是读台账尾巴），并在**失败那棵树 `2708492c` 上**再跑一次以取得逐字同 treeSha 的红/绿对照。

- worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac175-criterion-ledger-red-is-host-boot-death`，分支 `task/gap-ac175-criterion-ledger-red-is-host-boot-death`
- 起点 = `develop` = `f002bf2bb2a1b8b8a68f185b932bc04f882ba461`（`HEAD^{tree}` = `f8d37a4f4842bc712560411c45a7dffafaa3b2f4`）

### AC1 判据直跑（`npx playwright test e2e/resident-busy-send.spec.ts`）

跑动时刻 `date -u` = `Thu Oct  8 11:24:18 PM UTC 2026`；`git rev-parse HEAD` = `f002bf2bb2a1b8b8a68f185b932bc04f882ba461`；`git rev-parse HEAD^{tree}` = `f8d37a4f4842bc712560411c45a7dffafaa3b2f4`。判据自己打印的读数行**逐字**抄录：

```
resident.queuedCard=0
resident.row.present=true
resident.row.annotationKey=resident.pending.annotation
resident.row.annotation=Will be handled after this answer finishes
resident.row.text="draft one — the process has not taken this yet Will be handled after this answer finishes Withdraw"
withdraw.visibleBefore=true
click.dispatched=true
ui.withdrawnBeforeEvent=false
ui.withdrawnAfterEvent=true
row.presentAfter=false
row.textAfter="Withdrawn"
turnsAfterWithdraw=0
turns.control=1
cancelPayloads=1
controlResponsesForCancel=0
cancelAckFrames=1
cancelVerdictSource=command_lifecycle
beforeStarted.withdrawButton=1
afterStarted.withdrawButton=0
afterStarted.annotationKey=resident.pending.started
afterStarted.label=Started processing
perRun.queuedCard=1
perRun.card.text="QUEUED · Will send when this finishes draft three — this one waits for the browser"
perRun.card.label=Queued
locales.checked=12 keys.perLocale=4 missing=0
elapsed=45050ms
  3 passed (45.0s)
EXIT=0
```

AC 点名的每一条读数都在场：`resident.queuedCard=0`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1`、`elapsed=45050ms`、`EXIT=0`、`3 passed`。红态基线（立案读数）：台账 `2026-10-08T23:04:01.806Z` 记 fail。

**诚实附记（同一棵树上的两次直跑）**：第一次直跑（`date -u` = `Thu Oct  8 11:22:34 PM UTC 2026`，同一棵 `f8d37a4f`）在 `55004ms` 被**整轮 wallclock 看门狗**打断，`EXIT=1`，逐字：

```
[e2e] watchdog: this run crossed its own 55000ms ceiling at 55004ms and is ending here with exit 1 at 55008ms — stuck at stage "browser-launch-or-cases": both webServers answered, so this run is past boot and inside browser launch or a test case.
```

这一次**既不是启动死、也不是判据断言红**——判据本体的读数除因被打断而未跑到的 `locales.checked`/`elapsed=` 外**全部已在场且正确**（`resident.queuedCard=0`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1` 逐字在场）。当时宿主 `load average: 84.02, 76.88, 67.58`（`nproc=128`），多个 e2e 车道在跑。第二次直跑（`11:24:18Z`，`load average ≈ 72`）即 `EXIT=0 / 3 passed / elapsed=45050ms`。⇒ 这是一条**负载敏感的整轮 wallclock 红**（属 AC5 的判法范畴），**不是判据假**；如实登记，不写成产品绿。

### AC2 台账归因（机械、任何人可复现）

**首次测量**（`date -u` = `Thu Oct  8 11:22:31 PM UTC 2026`）读 `.quay/gate-events.jsonl`：AC-175 `gate=goal` 共 **764** 条，**末五拍** `verdict` 序列逐字 = **`pass, pass, fail, pass, fail`**（与 AC2 预期一致）：

```
2026-10-08T20:50:02.779Z goal-sweep pass treeSha=81cd03adecaa…
2026-10-08T21:51:28.586Z goal-sweep pass treeSha=81cd03adecaa…
2026-10-08T22:54:59.086Z goal-sweep fail treeSha=68a001b2474c…
2026-10-08T22:56:59.767Z goal-cli   pass treeSha=68a001b2474c…
2026-10-08T23:04:01.806Z goal-cli   fail treeSha=2708492cd53eaef96758fb970f2b5d75975987e4
```

`23:04:01.806Z` 那拍 `payload.reason` **逐字**：

```
acceptance failed (exit 1) — [WebServer] Error running migrations: unable to open database file [WebServer] [ERROR] Failed to start server: SqliteError: unable to open database file [WebServer] at Database.exec (/data/home/yale/work/claudecodeui/node_modules/better-sqlite3/lib/methods/wrappers.js:9:14) [WebServer] at runMigrations (/data/home/yale/work/claudecodeui/server/modules/database/migrations.ts:1053:8) [WebServer] at initializeDatabase (/data/ho … [truncated, 947 chars of stderr omitted]
```

含 **`Error running migrations`** 与 **`unable to open database file`**，失败点是 **`runMigrations`（`server/modules/database/migrations.ts:1053:8`）**——判据的 server 在**启动迁移阶段**就死了，判据本体一条断言都没跑到。该拍 `payload.treeSha` = `2708492cd53eaef96758fb970f2b5d75975987e4`。

⚠️ **现状复核（提案的 `现状` 已被验证为过期）**：立案时 checkout 的 `HEAD^{tree}` 曾等于 `2708492c…`；本任务收尾时 checkout `HEAD^{tree}` = `f8d37a4f4842bc712560411c45a7dffafaa3b2f4`（`HEAD=f002bf2b`），其间落进的是 `goals/AC-308*`、`goals/AC-309*`、`goals/GOAL-030*` 与若干 `tasks/*.md`。机械证明：`git diff --name-only 2708492cd53eaef96758fb970f2b5d75975987e4 f8d37a4f4842bc712560411c45a7dffafaa3b2f4` = **仅 `goals/**` + `tasks/**`**——判据所读的 `e2e/`、`src/`、`server/`、`scripts/`、`playwright.config.ts` 一个字节不变 ⇒ 两棵树的**判据输入代码相同**（这正是 AC3 的对照成立的基础）。

全库统计（同一脚本可复现）：

- 含 `unable to open database file` 的台账条目 = **1**（正是 `2026-10-08T23:04:01.806Z` AC-175 那拍）。
- AC-175 的 `Unknown system error -122` 启动死 = **3** 条：`2026-09-27T21:04:33.616Z`、`2026-09-27T21:05:54.631Z`、`2026-09-28T13:04:50.847Z`。
- 同窗（`2026-09-27T21:04:31.986Z`–`21:05:56.704Z`）同因 `fail` = **12 条 / 7 条 AC**：`AC-173×2, AC-174×2, AC-175×2, AC-151×2, AC-153×2, AC-171×1, AC-172×1`（名单与条数与 Proposal 一致；`AC-151` 的两条失败点是 `vite-temp`，其余是 `mkdtemp`）。
- `2026-10-08T23:03:55.361Z AC-153 goal-cli pass acceptance passed (exit 0)` 逐字在场 ⇒ 6.4 秒前邻居判据还活着，**不是全场停机，是阵发配额**。

**尾巴重建（DoD 要求如实抄 driver 的下一拍）**：本任务收尾时（`date -u` = `Thu Oct  8 11:27:49 PM UTC 2026`）AC-175 `gate=goal` 已 **766** 条，末五拍 `verdict` 序列 = **`fail, pass, fail, pass, pass`**——driver 在 `2026-10-08T23:23:02.834Z` 与 `2026-10-08T23:26:08.352Z` 各拍了一次 `goal-cli pass`（`payload.reason` = `acceptance passed (exit 0)`），**两拍 `payload.treeSha` = `f8d37a4f4842bc712560411c45a7dffafaa3b2f4`**（= 本任务 worktree 的 `HEAD^{tree}`）。逐字抄最近一拍：

```
2026-10-08T23:26:08.352Z goal-cli pass treeSha=f8d37a4f4842bc712560411c45a7dffafaa3b2f4 reason=acceptance passed (exit 0)
```

⇒ 判据尾巴**已被 driver 的下一拍翻成 pass**（DoD「若直跑为绿而台账尾巴在本条收尾前已被 driver 的下一拍翻成 pass，如实抄那一拍」），不写成「台账尾巴仍是 fail」。

### AC3 分辨力（承重）

判据本体的读数集合与 `23:04:01.806Z` 的 fail reason 文本——**两组字符串零交集**：

- 判据本体读数（AC1 直跑逐字 token）：`resident.queuedCard`、`resident.row.present`、`resident.row.annotationKey`、`resident.row.annotation`、`resident.row.text`、`withdraw.visibleBefore`、`click.dispatched`、`ui.withdrawnBeforeEvent`、`ui.withdrawnAfterEvent`、`row.presentAfter`、`row.textAfter`、`turnsAfterWithdraw`、`turns.control`、`cancelPayloads`、`controlResponsesForCancel`、`cancelAckFrames`、`cancelVerdictSource`、`beforeStarted.withdrawButton`、`afterStarted.withdrawButton`、`afterStarted.annotationKey`、`afterStarted.label`、`perRun.queuedCard`、`perRun.card.text`、`perRun.card.label`、`locales.checked`、`elapsed`。
- fail reason 文本 token：`acceptance failed (exit 1)`、`[WebServer]`、`Error running migrations`、`unable to open database file`、`Failed to start server`、`SqliteError`、`Database.exec`、`runMigrations`、`server/modules/database/migrations.ts:1053:8`、`initializeDatabase`。
- **交集 = ∅**：reason 里不含任何一条判据读数 token（无 `resident.`/`ui.`/`row.`/`turns`/`cancel`/`afterStarted.`/`beforeStarted.`/`perRun.`/`locales.`/`elapsed`）；判据读数里不含任何一条 reason token（无 `migrations`/`sqlite`/`WebServer`/`database`）。

**同 treeSha 红/绿对照**：把失败那棵树 `2708492c…` 逐字检出——`git worktree add --detach <probe> 853abee54e74e18247efc214d76988c720fd9e76`，`git rev-parse 853abee5^{tree}` = `2708492cd53eaef96758fb970f2b5d75975987e4` **逐字相同**，且该树上 `e2e/resident-busy-send.spec.ts` / `playwright.config.ts` / `scripts/e2e-data-dir-selection.mjs` 与当前树 `git diff` **无输出**（逐字无差）——在其上直跑判据：`date -u` = `Thu Oct  8 11:26:49 PM UTC 2026`，`EXIT=0`，`3 passed (46.6s)`，`elapsed=46767ms`，读数与 AC1 同形且全部在场（`resident.queuedCard=0`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1`、`locales.checked=12 keys.perLocale=4 missing=0`）。跑完即 `git worktree remove --force` 拆除，不留残留。

⇒ 台账在 treeSha `2708492c…` 上 `2026-10-08T23:04:01Z` 记 **fail**，本次直跑在**同一 treeSha `2708492c…`** 上得 **pass**：**同 treeSha，红不在树里**。

### AC4 宿主读数

逐字：

```
$ mount | grep ' /data '
/dev/vdb on /data type xfs (rw,relatime,attr2,inode64,logbufs=8,logbsize=32k,usrquota,prjquota)

$ ls "$HOME/.cache/quay-e2e-tmp" | wc -l
205          # 立案时为 2072 个目录 / 149G；其间宿主缓存被回收过

$ du -sh "$HOME/.cache/quay-e2e-tmp"
16G

$ df -h /data
Filesystem      Size  Used Avail Use% Mounted on
/dev/vdb        4.0T  938G  3.1T  23% /data

$ df -i /data
Filesystem        Inodes    IUsed     IFree IUse% Mounted on
/dev/vdb       429496704 22871407 406625297    6% /data

$ echo "TMPDIR=${TMPDIR:-<unset>}"
TMPDIR=<unset>      # ⇒ scripts/e2e-data-dir-selection.mjs 的候选序把运行目录放进 $HOME/.cache/quay-e2e-tmp，与 /data/scratch/yale 同在带配额的 /data 卷
```

`df` 报 `3.1T` 空闲、`Use% 23`、inode 用 6% —— 但 **`df` 报空闲 ≠ 配额未满**：宿主 `/data` 挂载带 `usrquota,prjquota`，配额（`EDQUOT` / `errno −122`）是**用户级配额上限**，`df` 对它无读数（立案时它正是 `df` 显示 14% 却写失败；本轮实测同窗多条判据一起以 `Unknown system error -122` 启动死）。本 shell 用户读配额被拒（`xfs_quota -x -c 'report -h' /data` → `XFS_GETQUOTA: Operation not permitted`），故无法给出配额百分比，只登记 mount 选项这一机械事实。

**失败跑 data dir 签名**：在 `$HOME/.cache/quay-e2e-tmp` 里按 mtime 找 `2026-10-08T23:00Z`–`23:06Z` 窗口的目录 = **0 个**；现存 205 个目录的 mtime 全在 `2026-10-09 07:19–07:27 CST`（= 本任务这几分钟的运行）。⇒ **已回收/不可辨认**：本条**不**把任何现存目录认成这次失败跑（⛔ 不制造未核实的归因），该失败跑只登记台账读数与池级读数。

### AC5 负载余量读数（承重）

判据自带上限逐字（`e2e/resident-busy-send.spec.ts:1076`）：

```
    expect(elapsed, `the whole invocation, measured from the config's own start`).toBeLessThan(55_000);
```

- 本次直跑（当前树 `f8d37a4f`）：`elapsed=45050ms` → 对上限 `55_000` 余量 = **9950ms**（`elapsed` 占上限 **81.9%**）。
- 同 treeSha 直跑（失败树 `2708492c`）：`elapsed=46767ms` → 余量 = **8233ms**（占上限 **85.0%**）。
- 首次直跑（同一棵 `f8d37a4f`，宿主 `load1 ≈ 84`）在 `55004ms` **越过**上限被整轮看门狗打断（`EXIT=1`）。

⇒ **判法**：下次若在某条 AC 的台账上见到 `fail`，先读 `payload.reason`——

- **启动之后红、且 `elapsed` 逼近/越过 `55_000`（或 watchdog 自报 `crossed its own 55000ms ceiling … stuck at stage "browser-launch-or-cases"`）⇒ 负载跨越**（本轮首次直跑即此形态，判据读数除因被打断未跑到的末两项外全在场）。
- **reason 含 `runMigrations` / `unable to open database file`（同族 `mkdtemp` / `Unknown system error -122` / `vite-temp`）⇒ 宿主启动死**（判据本体一条断言都没跑到；鉴别指纹是**同一时间窗内跨多条互不共享文件的 AC 出现同一 errno 的 `fail`**——本节 12 条 / 7 条 AC）。
- 二者都与**判据假**（本体断言红、读数里出现错误的 token）可分开。

`df` 显示不紧张**不能**否证配额已满（配额 ≠ 容量）。

### AC6 空 delta 且不夹带

`git status --porcelain`（worktree）跑前 = 跑后 = **空**，逐字相同；`git status --porcelain`（main checkout）前后均为 **32** 行，与本任务启动快照逐字相同（全是既存未跟踪产物，非本条所造）。

`git -C <worktree> diff --name-only develop..HEAD`：经 Provider ABI 写入本条 `tasks/<id>.md` 后、未 merge `develop` 前，输出 = **`tasks/gap-ac175-criterion-ledger-red-is-host-boot-death.md`**（develop 因本条的 store 提交而前进，worktree 分支尚在其后）；merge `develop`（fast-forward）之后 = **空**。两种形态下 `--name-only` 都**不含**任何 `e2e/**`、`src/**`、`server/**`、`scripts/**`、`playwright.config.ts` 路径——即「只含本条任务文件」/「空 delta」二态皆成立，无代码夹带。

本条**未改**：`e2e/resident-busy-send.spec.ts`、`src/**`、`server/**`、`scripts/e2e-data-dir-selection.mjs`、`playwright.config.ts`，一个字节未动（上面空 delta 即机械证明）；也未改宿主配置、未删宿主缓存任何字节。remedy（驱动侧把判据运行目录换到有余量的池子、或先 `npm run e2e:reclaim`）属 **e2e 基建族**（`scripts/e2e-data-dir-*`、`playwright.config.ts`），**不在本条内修**；它是与 `gap-ac153-ledger-red-is-host-quota` 同族机制的共享资源问题，本条只登记、不夹带。

### 判法（总）

**「AC-175 台账 `2026-10-08T23:04:01Z` 那拍红 = 宿主在 server 启动迁移阶段把判据打死（sqlite `unable to open database file`，同族 EDQUOT 的写面），判据本体未跑 ⇒ 宿主启动死 ≠ 判据假」**。早先六条 AC-175 任务（`gap-claude-resident-busy-send-ui`、`gap-ac175-criterion-bounded-boot-guard`、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-ac175-criterion-anchor-retired-by-dock-consolidation`、`gap-ac175-criterion-red-is-uncommitted-composer-wip`、`gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`）各修的是**别的**机制（启动守卫 / 锚点退役 / 心跳控制帧崩合并 / 未提交 composer WIP），**没有一条**碰过「宿主资源把判据的运行目录/启动打死」这条——**本条是其外的第七条机制**。
