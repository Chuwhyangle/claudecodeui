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

- [ ] AC1 判据在同 checkout 上直跑：`npx playwright test e2e/resident-busy-send.spec.ts` 退出 **0**、`3 passed`；完成记录里逐字给出 `git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`date -u`，以及判据自己打印的读数行（至少含 `resident.queuedCard=0`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1`、`elapsed=`）。红态基线（本轮立案读数）：台账 `2026-10-08T23:04:01.806Z` 记 fail。
- [ ] AC2 台账归因（机械、可被任何人复现）：打印 AC-175 `gate=goal` 末五拍 `verdict` 序列（应为 `pass,pass,fail,pass,fail`）；逐字给出 `23:04:01.806Z` 那拍的 `payload.reason` 并指出其中含 `runMigrations` 与 `unable to open database file`；给出该拍 `payload.treeSha` 并证明它等于本 checkout 的 `HEAD^{tree}`；统计全库 `unable to open database file` 条数（应为 1）与 `Unknown system error -122` 启动死的 AC-175 历史条数（应为 3）及同窗 AC 名单（至少 AC-151/153/171/172/173/174）；逐字给出 `23:03:55.361Z AC-153 pass` 这条。
- [ ] AC3 分辨力（承重）：判据本体读数集合与 `23:04:01.806Z` 的 fail reason 文本**零交集**——把两组字符串并列入档，并给出同 treeSha（`2708492cd53eaef96758fb970f2b5d75975987e4`）下 `23:04:01Z` fail 与本次直跑 pass 的对照。⚠️ 若本次直跑为红，本条归因不成立，见 DoD 的停手条款。
- [ ] AC4 宿主读数：逐字给出 `mount | grep ' /data '` 一行（含 `usrquota`/`prjquota`）、`ls $HOME/.cache/quay-e2e-tmp | wc -l`、`du -sh $HOME/.cache/quay-e2e-tmp`、`df -h /data`；并写明「`df` 报空闲 ≠ 配额未满」。失败跑 data dir 的 `auth.db`/`auth.db-journal` 签名**只在核实其对得上 `23:04Z` 时才入档**，否则如实写「已回收/不可辨认」。
- [ ] AC5 负载余量读数（承重）：给出本次直跑 `elapsed=` 与其对判据自带上限 `elapsed < 55_000`（`e2e/resident-busy-send.spec.ts:1076` 逐字）的余量，写成「下次若在启动**之后**红且 `elapsed` 逼近/越过 55_000 ⇒ 负载跨越，与本次『启动死』可分开」。
- [ ] AC6 空 delta 且不夹带：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；完成记录声明本条**未**改 `e2e/resident-busy-send.spec.ts`、`src/**`、`server/**`、`scripts/e2e-data-dir-selection.mjs`、`playwright.config.ts`，并指明 remedy（驱动侧换有余量的运行目录 / 先 `npm run e2e:reclaim`）属 e2e 基建族、不在本条内修；跑前后 `git status --porcelain` 逐字相同。

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
