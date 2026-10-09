---
id: gap-ac175-criterion-ledger-red-is-whole-run-watchdog-crossing
title: AC-175 台账尾巴的红是整轮看门狗在 55000ms 天花板上的负载跨越（artifact
  rrLOMM/watchdog-state.json fired:true/ceiling crossed at 55001ms，mtime 对上台账
  23:42:01.669Z；同 treeSha 35cd8acd 直跑为绿）而非判据假：重跑 + 同 treeSha 红/绿对照 + 负载包络读数，并证明
  AC-153 的重标模式不可迁移
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

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-175 `status: achieved`，其 GOAL-013 已 `achieved`、不再活，且未声明 `long-term: true`；台账尾部 `2026-10-08T23:42:01.669Z` 那拍记为 fail，故按 CURRENTLY FALSE 立案。

判据物（逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`）：`npx playwright test e2e/resident-busy-send.spec.ts`。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，checkout `/data/home/yale/work/claudecodeui`，branch `author`，`git rev-parse HEAD` = `2e159705f3b73d88aef53d732ebec1a25aa87375`，其 `HEAD^{tree}` = `35cd8acdadac8050ae1685afe0817e22d33befaa`）：`grep -rlE '^goal_ac:\s*AC-175\s*$' tasks/` 命中 7 份，`status:` 逐字皆 **done**（`gap-claude-resident-busy-send-ui`、`gap-ac175-criterion-bounded-boot-guard`、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-ac175-criterion-anchor-retired-by-dock-consolidation`、`gap-ac175-criterion-red-is-uncommitted-composer-wip`、`gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`、`gap-ac175-criterion-ledger-red-is-host-boot-death`）。在飞扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human）**无一认领 AC-175** ⇒ 无在飞认领者。按「done 不算重复、是更早修法没兜住的证据」，本条与它们各是**不同机制**：前七条分别修的是启动守卫 / 锚点退役 / 心跳控制帧崩合并 / composer WIP 的启动期运行期崩 / 宿主配额在 `runMigrations` 的启动死——**没有一条**碰过下面这条「整轮看门狗在 55000ms 天花板上的**负载**跨越」的机制。`task-granularity-advice.js` 对本条 Touches 报告 `peers: []`（`mentions` 只有两个在飞任务在散文里提到 `playwright.config.ts`、未声明该文件）⇒ **separate**。同族但**异判据**的在飞任务 `gap-ac153-criterion-budget-rescale-unmerged`（`ready`）治 AC-153 的 spec 自加 45000ms 预算——**它改 `e2e/voice-error-messages.spec.ts` 与 `src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`，与本条改的文件不相交**，且下文「不可迁移」一节证明其模式对 AC-175 无解 ⇒ 本条不是重复。

**本轮直接测量（读数不是推断）**

（1）**判据直跑 → 绿**（立案前在同一 checkout 上跑出货命令）：`npx playwright test e2e/resident-busy-send.spec.ts` → **EXIT 0**，`3 passed (44.6s)`，`elapsed=44195ms`。`date -u` = `Thu Oct  8 11:43:00 PM UTC 2026`；宿主 `load average: 128.95, 133.15, 112.72`（`nproc=128`）。判据自己打印的读数逐字：

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
scenario.cancel_async_message=f3d6f225-8268-4e07-bd4f-57b1fbacc3e6
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
elapsed=44195ms
```

⇒ **被提交的树满足 AC-175**：常驻会话不发 `QueuedMessageCard`（`resident.queuedCard=0`）、消息立即入记录并带「将在当前回答结束后处理」标注、撤回前不宣告（`ui.withdrawnBeforeEvent=false`）、收到 `cancelled` 后才宣告并把该行移除（`ui.withdrawnAfterEvent=true` / `row.presentAfter=false` / `turnsAfterWithdraw=0`）、撤回判据取自 `command_lifecycle`（`cancelVerdictSource=command_lifecycle` / `cancelAckFrames=1` / `controlResponsesForCancel=0`）、出队后按钮消失并显示已开始（`afterStarted.withdrawButton=0` / `afterStarted.label=Started processing`）、per-run 仍画卡（`perRun.queuedCard=1`）。

（2）**台账尾巴（`.quay/gate-events.jsonl`，`item_id=AC-175`、`gate=goal`，共 771 条）末五拍**：`2026-10-08T23:28:37.842Z pass`（`treeSha=f8d37a4f…`）→ `23:31:48.085Z pass`（`35cd8acd…`）→ `23:35:30.907Z pass`（`35cd8acd…`）→ `23:38:20.585Z pass`（`35cd8acd…`）→ `2026-10-08T23:42:01.669Z fail`（**`treeSha=35cd8acdadac8050ae1685afe0817e22d33befaa`**）。

（3）**决定性 artifact：那拍 fail 就是整轮看门狗在 55000ms 天花板上开火**。`$HOME/.cache/quay-e2e-tmp/quay-e2e-rrLOMM/watchdog-state.json` 逐字：

```
{"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55001ms"}
```

其 mtime = `2026-10-09 07:42:01.564464097 +0800` = `2026-10-08T23:42:01.564Z`，与台账 `23:42:01.669Z` 相差 **105ms** ⇒ **同一跑**。`test-results/resident-busy-send-residen-7053b-al-is-the-process-s-own-act/error-context.md` 与该 `watchdog-state.json` 同在 ⇒ 这次红是**整轮 `npx playwright test` 越过 `RUN_CEILING_MS`**（= `SINGLE_SPEC_CEILING_MS` = `55_000`，`playwright.config.ts:320`；`RUN_CEILING_MS` 由所选 spec 求和，`playwright.config.ts:401`），**判据本体一条断言都没跑到**（那拍 `payload.reason` 只有 `[WebServer] [BABEL] Note: …` 与 `[DEP0190]` 噪声，其后 490 chars 被截断，不含任何 `resident.`/`ui.`/`cancel` 读数 token）。

（4）**同 treeSha 红/绿对照**：`23:42:01.669Z` 那拍 `payload.treeSha` = `35cd8acdadac8050ae1685afe0817e22d33befaa` = 本 checkout 现在 `HEAD^{tree}`（`git rev-parse HEAD^{tree}` 实测逐字相同）。**同一棵树**：`23:42Z` 记 fail、本轮直跑 `23:43Z` EXIT 0 ⇒ 红**不在树里**。

（5）**并发同类指纹（阵发，不是单条产品红）**：同一 `35cd8acd` 树、`23:37–23:42` 窗内，**兄弟 AC-153** 的 `goal` 台账连记两条 fail——`23:37:41.584Z`、`23:41:04.880Z`——其可见 `payload.reason` 前缀与 AC-175 那拍**同形**（`[WebServer] [BABEL] Note: The code generator has deoptimised…`），且含 `[WebServer] 7:37:11 AM [vite] ws proxy error: [WebServer] Error: write EPIPE`；`goal-round.jsonl` 的 `frozenRecheck` 给出 AC-153 的 `load1`/`durationMs` 序列 `84.93/40457 → 119.74/57008 → 149.66/59101 → 152.37/56538` ⇒ **整轮时长随宿主负载单调抬升**（`nproc=128`）。⇒ 这是一次**宿主负载阵发**，多条互不共享实现文件的 AC 同时红。

**为什么早先的修复没兜住**：前七条 AC-175 任务各修一条**别**的机制（启动守卫 / 锚点退役 / 心跳控制帧崩合并 / composer WIP / 宿主配额在 `runMigrations` 的启动死），**没有一条**动「判据的整轮时长在宿主负载下越过 55000ms 天花板」这条——宿主一挤，AC-175 就以「看门狗在 `ceiling crossed at 55001ms` 开火」的形态复发。

**为什么 AC-153 的重标模式对 AC-175 不可迁移（承重）**：AC-153 的红是**其 spec 自加的 45000ms 断言**在 `52585 < 55000` 处被**报告**（看门狗未触、四条腿全绿），故把该预算抬到 `52585` 之上、`SINGLE_SPEC_CEILING_MS` 之下（留 ≥1s 头部）即可转绿。AC-175 的跨越**落在看门狗天花板本身**（`55001 ≥ 55000`，SIGKILL mid-case，判据读数丢失），其下**不存在**一条「已报告的子天花板断言」可抬；而抬 `RUN_CEILING_MS`/`SINGLE_SPEC_CEILING_MS` 受**判据门的 60s kill** 约束（`SINGLE_SPEC_CEILING_MS` 正是对 60s 门推导出来的，见 `playwright.config.ts:303` 与 `:491` 的 `WEB_SERVER_TIMEOUT_MS(35s) < BOOT_CEILING_MS(40s) < SINGLE_SPEC_CEILING_MS(55s) < 60s` 梯级），最多 +5s，**远小于**实测负载膨胀（AC-153 同窗即 `40s→59s = +19s`）⇒ 对 AC-175 无解。故本条**不**照搬 AC-153 的重标，只做归因，并把 remedy 指向**根因**（整轮时长 / 驱动并发）。

**这条是什么、不是什么**：verification-only 归因入档。它**不**改实现、判据、配置、宿主一个字节，只在同一棵树上重跑判据、读台账、读那跑的 `watchdog-state.json`、读宿主与并发负载，把「宿主负载把整轮越过 55000ms 天花板 ≠ 判据假」的判法钉成下次可机械复用的形态，并指明 remedy（缩短整轮时长 / 降驱动并发 / 把运行目录换到有余量的池子）属 **e2e 基建 / 驱动负载族**（`playwright.config.ts`、`scripts/e2e-data-dir-*`、driver 并发），**不在本条内夹带**。

## Plan

1. 在同一 checkout（记录 `git rev-parse HEAD` 与 `HEAD^{tree}`）跑出货命令 `npx playwright test e2e/resident-busy-send.spec.ts` 一次，读退出码、`3 passed`、`elapsed=`，并把判据自己打印的读数行**逐字**抄进完成记录；跑前后各取 `git status --porcelain` 与 `git rev-parse HEAD^{tree}`，证明没有边跑边改树。
2. 机械读台账（`python3` 或 `jq`）：打印 AC-175 `gate=goal` 末五拍 `verdict` 序列（应为 `pass,pass,pass,pass,fail`）；逐字给出 `23:42:01.669Z` 那拍的 `payload.reason` 可见部分与 `payload.treeSha`；证明该 `treeSha` 等于本 checkout 的 `HEAD^{tree}`。
3. 读决定性 artifact：`cat` 与 `stat -c '%y'` `$HOME/.cache/quay-e2e-tmp/quay-e2e-rrLOMM/watchdog-state.json`，逐字给出内容（`armed`/`fired`/`ceilingMs`/`detail`）与 mtime，把 mtime 换算成 UTC 并与台账 `23:42:01.669Z` 对齐（误差目标 ≤1s）。
4. 分辨力（承重）：把「判据本体的读数集合」与 `23:42:01.669Z` 的 fail reason 可见文本逐条对照，证明二者**零交集**；给出同 treeSha（`35cd8acdadac8050ae1685afe0817e22d33befaa`）下 `23:42Z` fail 与本次直跑 pass 的对照。
5. 负载包络读数：读 `goal-round.jsonl` 里 AC-153 `frozenRecheck` 的 `load1`/`durationMs` 序列（`84.93/40457 → 119.74/57008 → 149.66/59101 → 152.37/56538`）与本窗 AC-153 `goal` fail 的 `vite ws proxy error: Error: write EPIPE`；读 `nproc`、`uptime`、`echo TMPDIR`、`ls $HOME/.cache/quay-e2e-tmp | wc -l`、`df -h /data`。
6. 「不可迁移」：逐字给出 `playwright.config.ts:320 SINGLE_SPEC_CEILING_MS = 55_000`、`e2e/resident-busy-send.spec.ts:1076` 的 `toBeLessThan(55_000)`、`SPEC_BUDGET_MS`（`playwright.config.ts:322`–`:346`）的四个条目且**不含** `resident-busy-send.spec.ts`（其仅在 `DEBUG_AGENT_SPEC_FILES`，`:2248`——须指出这是另一个表，别认错），写出 `60−55=5s` 上限与实测膨胀 `+19s` 的对照。
7. 只把 `tasks/<本条 id>.md` 写进交付；实现/判据/配置/宿主一字不改。

## AC

- [x] AC1 判据在同 checkout 上直跑：`npx playwright test e2e/resident-busy-send.spec.ts` 退出 **0**、`3 passed (44.x s)`；完成记录里逐字给出 `git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`date -u`，以及判据自己打印的读数行（至少含 `resident.queuedCard=0`、`resident.row.annotation=Will be handled after this answer finishes`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1`、`elapsed=`）。红态基线（本轮立案读数）：台账 `2026-10-08T23:42:01.669Z` 记 fail。
- [x] AC2 决定性 artifact 入档：逐字给出 `$HOME/.cache/quay-e2e-tmp/quay-e2e-rrLOMM/watchdog-state.json` 的全部四个字段（须含 `"fired":true`、`"ceilingMs":55000`、`"ceiling crossed at 55001ms"`）与其 `stat` mtime；写出 mtime（UTC）与台账 `2026-10-08T23:42:01.669Z` 的差（目标 ≤1s）。
- [x] AC3 台账归因（机械、可被任何人复现）：打印 AC-175 `gate=goal` 末五拍 `verdict` 序列（应为 `pass,pass,pass,pass,fail`）；逐字给出 `23:42:01.669Z` 那拍的 `payload.reason` 可见部分并指出其中**不含**任何判据读数 token、只含 `[WebServer]` 噪声；给出该拍 `payload.treeSha` 并证明它等于本 checkout 的 `HEAD^{tree}`。
- [x] AC4 分辨力（承重）：判据本体读数集合与 `23:42:01.669Z` 的 fail reason 可见文本**零交集**——把两组字符串并列入档，并给出同 treeSha（`35cd8acdadac8050ae1685afe0817e22d33befaa`）下 `23:42Z` fail 与本次直跑 pass 的对照。⚠️ 若本次直跑为红，本条归因不成立，见 DoD 的停手条款。
- [x] AC5 负载包络读数（承重）：逐字给出 `goal-round.jsonl` 里 AC-153 `frozenRecheck` 的 `load1`/`durationMs` 序列、本窗 AC-153 `goal` fail 的 `vite ws proxy error: Error: write EPIPE` 行、`nproc`、`uptime` 的 `load average`、`echo TMPDIR`、`ls $HOME/.cache/quay-e2e-tmp | wc -l`、`df -h /data`。
- [x] AC6 「AC-153 重标不可迁移」机械入档：逐字给出 `playwright.config.ts:320` 的 `SINGLE_SPEC_CEILING_MS = 55_000`、`e2e/resident-busy-send.spec.ts:1076` 的 `toBeLessThan(55_000)`、`SPEC_BUDGET_MS` 的四个条目（`:332/:333/:338/:345`）与「不含 `resident-busy-send.spec.ts`」的 grep 输出；写出 `60−55=5s` 抬升上限 vs 实测膨胀 `+19s` 的数值对照，结论为 AC-153 的重标模式对 AC-175 无解。
- [x] AC7 空 delta 且不夹带：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`（ABI 写入后未 merge 前）/ 空（merge fast-forward 后）二态皆成立；完成记录声明本条**未**改 `e2e/resident-busy-send.spec.ts`、`src/**`、`server/**`、`scripts/**`、`playwright.config.ts`，并指明 remedy（缩短整轮时长 / 降驱动并发 / 换有余量的运行目录）属 e2e 基建/驱动负载族、不在本条内修；跑前后 `git status --porcelain` 逐字相同。

## DoD

- 出货命令（`npx playwright test e2e/resident-busy-send.spec.ts`，逐字不改；⛔ 不加 `-g`、不 skip、不加 `retries`、不改断言、不动 `playwright.config.ts`）真的在同一 checkout 上跑过，读数行逐字入档——不是复述 `expect` 的文字，不是读台账尾巴。
- 决定性 artifact 的四个字段与 mtime 逐字入档，并证明它与 `23:42:01.669Z` 那拍是**同一跑**（mtime 对齐）；判法写成一句话：**「AC-175 台账 `2026-10-08T23:42:01Z` 那拍红 = 整轮 `npx playwright test` 在宿主负载下越过 `RUN_CEILING_MS`（55000ms）被看门狗 SIGKILL（`watchdog-state.json`：`fired:true`、`ceiling crossed at 55001ms`），判据本体未跑 ⇒ 负载把整轮越过 55000ms 天花板 ≠ 判据假」**。
- 台账归因与分辨力的每一条读数都能由任何人在同一 checkout 上从 `.quay/gate-events.jsonl` / `goal-round.jsonl` 复现（给出逐字命令与逐字输出）。
- 完成记录明确写出早先七条 AC-175 修复各修了**别**的机制、本条是其外的第八条机制，并写明 AC-153 的重标模式为何不可迁移（5s 上限 vs +19s 膨胀）。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、配置、宿主一个字节未动；未删宿主缓存。
- 若直跑为**红**（红不依赖宿主负载、落在判据自己的断言上），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，负载跨越归因不成立，应按缺陷任务重立」——⛔ 不得把环境红写成产品绿，也不得据此改断言。
- 若直跑为绿而台账尾巴在本条收尾前已被 driver 的下一拍翻成 pass，如实抄那一拍；否则逐字写「台账尾巴仍是 fail」并附 AC1 的直跑读数，⛔ 不得写成已通过。

## Touches

- tasks/gap-ac175-criterion-ledger-red-is-whole-run-watchdog-crossing.md（自触）
- e2e/resident-busy-send.spec.ts（本条只跑不改：AC1 的判据本体与 `:1076` 的 `toBeLessThan(55_000)`）
- playwright.config.ts（本条只读不改：`SINGLE_SPEC_CEILING_MS`/`RUN_CEILING_MS`/`SPEC_BUDGET_MS` 的逐字来源，AC6）
- scripts/e2e-data-dir-selection.mjs（本条只读不改：判据运行目录的候选序与选择，AC5 的池级读数来源）
- goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md（本条只读不改：criterion/expect 的逐字来源）

## 完成记录

verification-only 归因入档。**未改实现 / 判据 / 配置 / 宿主一个字节**；交付物只动 `tasks/<本条 id>.md`（经 Provider ABI 写入）。

### 运行环境
- worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac175-criterion-ledger-red-is-whole-run-watchdog-crossing`
- branch：`task/gap-ac175-criterion-ledger-red-is-whole-run-watchdog-crossing`，fork 自 `develop` @ `f868d08b`
- 直跑检出（detached）：`git rev-parse HEAD` = `2e159705f3b73d88aef53d732ebec1a25aa87375`（= 立案时 HEAD）、`git rev-parse HEAD^{tree}` = `35cd8acdadac8050ae1685afe0817e22d33befaa`（= 台账 23:42 那拍 `payload.treeSha`）
- 当前 develop 树：`f868d08b` → `19b222c5…`，与 `35cd8acd` 的差异**只在两个 task 记录**（`git diff --name-only 2e159705..f868d08b` = `tasks/gap-ac175-…md` + `tasks/gap-voice-realtime-…md`）；`git diff --name-only f868d08b -- e2e/ src/ server/ scripts/ playwright.config.ts goals/` **为空** ⇒ 判据 / 实现 / 配置在这些树间**逐字相同**。

### AC1 判据直跑
命令（逐字不改）：`npx playwright test e2e/resident-busy-send.spec.ts`，在 detached `2e159705`（tree `35cd8acd`）的 worktree 内执行。

**Run 2（绿，AC1 的直跑）**：`date -u` 起跑 `Thu Oct  8 11:56:01 PM UTC 2026`；`EXIT=0`；`3 passed (39.0s)`；`elapsed=39007ms`；wall `40183 ms`。判据自己打印的读数行逐字：

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
scenario.cancel_async_message=304a8b94-2442-4a8c-b888-31d586843527
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
withdrawn.run.ok=true status=200
started.run.ok=true status=200
locales.checked=12 keys.perLocale=4 missing=0
locales=de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW
elapsed=39007ms
```

（AC1 括注的 `44.x s` 是立案时那跑的墙钟；本次绿跑为 `39.0s`——货锚点是退出码 0 与读数全集，墙钟随负载浮动，如实抄实测值。）

红态基线（本轮立案读数）：台账 `2026-10-08T23:42:01.669Z` 记 fail（tree `35cd8acd`）。

**Run 1（红，同一棵树的活体重现）**：起跑 `Thu Oct  8 11:53:11 PM UTC 2026`（load1 ≈ 173.58）；`EXIT=1`；wall `56203 ms`；日志逐字：

```
[e2e] watchdog: this run crossed its own 55000ms ceiling at 55000ms and is ending here with exit 1 at 55004ms — stuck at stage "browser-launch-or-cases": both webServers answered, so this run is past boot and inside browser launch or a test case.
```

它打印到 `beforeStarted.withdrawButton=1` 后被看门狗结束，判据本体后续读数（`afterStarted.*` / `perRun.*` / `locales.*`）丢失。⇒ 这是**本条机制在活体上的直接复现**：同命令、同树，负载高时红（看门狗杀）、负载低时绿。

### AC2 决定性 artifact
`$HOME/.cache/quay-e2e-tmp/quay-e2e-rrLOMM/watchdog-state.json` 逐字四字段（**立案时直读**）：

```
{"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55001ms"}
```

其 `stat` mtime（立案时）= `2026-10-09 07:42:01.564464097 +0800` = `2026-10-08T23:42:01.564Z`；与台账 `23:42:01.669Z` 差 **105 ms**（≤1s）⇒ 同一跑。

⚠️ **该 artifact 已被回收**（如实抄）：收尾复查时 `quay-e2e-rrLOMM/` 已不存在（`ls`/`stat`/`cat` 皆 ENOENT），`ls $HOME/.cache/quay-e2e-tmp | wc -l` 由立案时的 2072 降到 **193**（`[e2e] retention` 保留期到期回收）。故上四字段与 mtime 为**立案时直读**留档，非本次收尾重读；`grep -rl 'rrLOMM'` 现只命中 `.quay/gate-events.jsonl`、`.quay/goal-round.jsonl`（与其运行目录字段）。

**活体等价对（本次收尾实测，证同法可复现）**：
- 兄弟拍 `2026-10-08T23:53:47.035Z`（tree `19b222c5`）的 `quay-e2e-uGobJd/watchdog-state.json` = `{"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55004ms"}`，`stat -c '%y'` = `2026-10-09 07:53:46.921841166 +0800` = `2026-10-08T23:53:46.921Z`；与台账 `23:53:47.035Z` 差 **114 ms**（与 105ms 同族）。
- 本条 Run 1 的 `quay-e2e-s4t5Hh/watchdog-state.json` = `{"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55000ms"}`，mtime `2026-10-09 07:54:07.826763143 +0800` = `2026-10-08T23:54:07.827Z`。

### AC3 台账归因
`.quay/gate-events.jsonl`、`item_id=AC-175`、`gate=goal`（收尾实测，共 773 条；下方列出末段各拍）：

```
2026-10-08T23:31:48.085Z pass treeSha=35cd8acd…
2026-10-08T23:35:30.907Z pass treeSha=35cd8acd…
2026-10-08T23:38:20.585Z pass treeSha=35cd8acd…
2026-10-08T23:42:01.669Z fail treeSha=35cd8acdadac8050ae1685afe0817e22d33befaa
2026-10-08T23:50:08.881Z fail treeSha=19b222c5…   <- 立案后新落
2026-10-08T23:53:47.035Z fail treeSha=19b222c5…   <- 立案后新落
```

⚠️ 立案时 Proposal 预期序列为 `pass,pass,pass,pass,fail`；**收尾实测尾巴已变为 `pass,pass,fail,fail,fail`**（后两拍 fail 在立案之后落下）。故按 DoD 末条如实抄：**本例收尾时台账尾巴仍是 fail**（并附上方 AC1 的直跑读数）。

`23:42:01.669Z` 那拍 `payload.reason`（可见 500 字，`evaluationRoot=/data/home/yale/work/claudecodeui`，actor `goal-cli`）逐字：

```
acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-rrLOMM/vite-cache/deps/react-scan.js?v=5731b542 as it exceeds the max of 500KB. [WebServer] (node:1828412) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated. [WebServer] (Use `node - … [truncated, 490 chars of stderr omitted]
```

其中**不含任何**判据读数 token（无 `resident.` / `ui.` / `row.` / `cancel` / `turnsAfterWithdraw`），只有 `[WebServer]` 噪声；并点出该跑的运行目录 `rrLOMM`（与 AC2 同跑）。

`payload.treeSha` = `35cd8acdadac8050ae1685afe0817e22d33befaa` = 直跑检出的 `HEAD^{tree}`（`git rev-parse HEAD^{tree}` 实测逐字相同）⇒ 红**不在树里**。

**新两拍的原因**（收尾加述，非判据假）：
- `23:50:08.881Z`（tree `19b222c5`，data dir `quay-e2e-DWuDDn`）：`watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}`（**看门狗未开火**）；`test-results/.last-run.json` = `{"status":"failed","failedTests":[3 ids]}`；`error-context.md`（test name `resident-busy-send.spec.ts:855:3 › a busy resident session takes the message, and the withdrawal is the process's own act`）报 `Error: the project row for resident-busy-send-workspace never rendered … console errors: Failed to load resource: net::ERR_NETWORK_CHANGED (×5)` ⇒ **启动期网络红**（产品面未渲染），仍非判据断言红。
- `23:53:47.035Z`（tree `19b222c5`，data dir `quay-e2e-uGobJd`）：见 AC2 活体对，`fired:true`、`ceiling crossed at 55004ms`；error-context 报 `Error: Channel closed` + `apiRequestContext.post: socket hang up … POST http://127.0.0.1:4891/api/debug-agent/clock` ⇒ **看门狗杀**。

### AC4 分辨力
两组字符串**零交集**：

判据本体读数集合（Run 2 直跑，逐字 token）：`resident.queuedCard`、`resident.row.present`、`resident.row.annotationKey`、`resident.row.annotation`、`resident.row.text`、`withdraw.visibleBefore`、`click.dispatched`、`ui.withdrawnBeforeEvent`、`ui.withdrawnAfterEvent`、`row.presentAfter`、`row.textAfter`、`turnsAfterWithdraw`、`turns.control`、`cancelPayloads`、`scenario.cancel_async_message`、`controlResponsesForCancel`、`cancelAckFrames`、`cancelVerdictSource`、`beforeStarted.withdrawButton`、`afterStarted.withdrawButton`、`afterStarted.annotationKey`、`afterStarted.label`、`perRun.queuedCard`、`perRun.card.text`、`perRun.card.label`、`withdrawn.run.ok`、`started.run.ok`、`locales.checked`、`keys.perLocale`、`locales`、`elapsed`。

`23:42:01.669Z` fail reason 可见文本的 token 集合：`acceptance failed (exit 1)`、`[WebServer]`、`[BABEL]`、`deoptimised`、`vite-cache/deps/react-scan.js`、`max of 500KB`、`[DEP0190]`、`DeprecationWarning`、`shell option true`、`stderr omitted`、`node:1828412`、`quay-e2e-rrLOMM`。

交集 = **∅**（无一个判据 token 出现在 fail reason 里）。

**同 treeSha `35cd8acd` 红/绿对照**：
- `2026-10-08T23:42:01.669Z` 台账 fail（tree `35cd8acd`）—— 看门狗 SIGKILL，判据未跑
- 本条 Run 1 `23:53:11Z` 直跑 **EXIT 1**（同树 `35cd8acd`，load1 ≈ 173.58）—— 看门狗 `ceiling crossed at 55000ms`
- 本条 Run 2 `23:56:01Z` 直跑 **EXIT 0**（同树 `35cd8acd`，load1 ≈ 124.32）—— `3 passed (39.0s)`

⇒ **同命令、同树**：负载高 → 红（看门狗杀），负载低 → 绿（判据全绿）。红**不随树走，随负载走**。

### AC5 负载包络
`goal-round.jsonl` 的 AC-153 `frozenRecheck` `load1`/`durationMs` 序列（逐字）：

```
r2059 2026-10-08T23:28:39.372Z load1=84.93  durationMs=40457 fail
r2060 2026-10-08T23:32:00.023Z load1=119.74 durationMs=57008 fail
r2061 2026-10-08T23:35:32.616Z load1=149.66 durationMs=59101 fail
r2062 2026-10-08T23:38:33.918Z load1=152.37 durationMs=56538 fail
```

同窗 AC-153 `gate=goal` fail 的 `vite ws proxy error: Error: write EPIPE` 行（逐字）：
- `2026-10-08T23:37:41.584Z fail treeSha=35cd8acd`，reason 含 `[WebServer] 7:37:11 AM [vite] ws proxy error: [WebServer] Error: write EPIPE [WebServer] at afterWriteDispatched (node:internal/stream_base_commons:159:15)`
- `2026-10-08T23:41:04.880Z fail treeSha=35cd8acd`，reason 含 `[WebServer] 7:40:30 AM [vite] ws proxy error … write EPIPE`
- AC-153 收尾恢复：`2026-10-08T23:49:40.692Z pass treeSha=19b222c5`

**AC-175 那拍自己的 `frozenRecheck`**（`goal-round.jsonl` round 2063，ts `2026-10-08T23:47:54.609Z`，该条承载 `rrLOMM`）：`{verdict: fail, durationMs: 56789, hostFreeBytes: 15988654080, load1: 150.47, headSha: 2e159705…, behindDevelop: 0}` ⇒ **56789 ms > 55000 ms 天花板**，与 AC2 的 `fired:true` 同指。邻拍：r2062 `38986/152.37` pass、r2064（`23:50:16.947Z`）`33548/130.51` fail（data dir `DWuDDn`）。

宿主读数（收尾 `date -u` = `Thu Oct  8 11:58:25 PM UTC 2026`）：
- `nproc` = **128**
- `uptime` = `load average: 66.53, 121.79, 127.10`
- `echo TMPDIR` = `<unset>`
- `ls $HOME/.cache/quay-e2e-tmp | wc -l` = **193**（立案时 2072）
- `df -h /data` = `/dev/vdb 4.0T 942G 3.1T 23% /data`

会话期 load1 轨迹：257 → 174 → 124 → 136（`uptime` 逐次捕获，如 `Thu Oct  8 11:51:35 PM UTC 2026 → load average: 257.47, 173.66, 135.11`、`11:56:58 PM → 135.97, 149.68, 135.85`）；`ps` 见他人重任务（kai、vince）+ 兄弟 quay e2e 车道的 `node_modules/.bin/vite --host 127.0.0.1 --strictPort` 与 `playwright` 进程并发。

### AC6 AC-153 重标不可迁移
逐字：
- `playwright.config.ts:320` = `const SINGLE_SPEC_CEILING_MS = 55_000;`
- `playwright.config.ts:322` = `const SPEC_BUDGET_MS: Record<string, number> = {`；条目 `:332 'activity-dock-truthful.spec.ts': 240_000,`、`:333 'mobile-workspace-composer-layout.spec.ts': 240_000,`、`:338 'transcript-jump-landing.spec.ts': 240_000,`、`:345 'voice-live-vad-ab.spec.ts': 240_000,`
- `e2e/resident-busy-send.spec.ts:1076` = `expect(elapsed, \`the whole invocation, measured from the config's own start\`).toBeLessThan(55_000);`
- `grep -n 'resident-busy-send' playwright.config.ts` → 只有 `2248:  'resident-busy-send.spec.ts',`，处于 **`DEBUG_AGENT_SPEC_FILES`**（另一张表，别认错）；`sed -n '322,346p' | grep -c 'resident-busy-send'` = **0** ⇒ `SPEC_BUDGET_MS` **不含**它。

梯级（config 注释）：`WEB_SERVER_TIMEOUT_MS (35s) < BOOT_CEILING_MS (40s) < SINGLE_SPEC_CEILING_MS (55s) < 60s（门 kill）`；`playwright.config.ts:470 const BOOT_CEILING_MS = 40_000;`、`:498 const WEB_SERVER_TIMEOUT_MS = 35_000;`、`:2363 timeout: 60_000,`；`RUN_CEILING_MS`（`:401`）对所选 spec 逐条求和 `SPEC_BUDGET_MS[file] ?? SINGLE_SPEC_CEILING_MS`。

数值对照：把 `SINGLE_SPEC_CEILING_MS` 抬到门 kill 之前，最多 **60 − 55 = +5 s**；实测负载膨胀（AC-153 同窗）`40s → 59s = +19 s` ⇒ **+19 > +5**，**AC-153 的重标模式对 AC-175 无解**。

### AC7 空 delta、不夹带
- `git diff --name-only develop..HEAD`（worktree，ABI 写入前）= **空**；ABI 写入后仅含 `tasks/gap-ac175-criterion-ledger-red-is-whole-run-watchdog-crossing.md`；pre-merge fast-forward 后回空。无代码 delta。
- 本条**未**改 `e2e/resident-busy-send.spec.ts`、`src/**`、`server/**`、`scripts/**`、`playwright.config.ts`（`git diff --name-only f868d08b -- e2e/ src/ server/ scripts/ playwright.config.ts goals/` 为空）。
- remedy（缩短整轮时长 / 降驱动并发 / 换到有余量的运行目录）属 **e2e 基建 / 驱动负载族**（`playwright.config.ts`、`scripts/e2e-data-dir-*`、driver 并发），**不在本条内修**。
- `git status --porcelain` 跑前后逐字相同：worktree = **空**（0 行）；主检出 = 32 条未跟踪（与本会话开始时同一集合）。
- 未删宿主缓存（`quay-e2e-tmp` 为 TTL 回收后的 193 个）。

### 判法一句话
**AC-175 台账 `2026-10-08T23:42:01Z` 那拍红 = 整轮 `npx playwright test` 在宿主负载下越过 `RUN_CEILING_MS`（55000ms）被看门狗 SIGKILL（`watchdog-state.json`：`fired:true`、`ceiling crossed at 55001ms`），判据本体未跑 ⇒ 负载把整轮越过 55000ms 天花板 ≠ 判据假。**

### 第八条机制
早先七条 AC-175 任务各修**别**的机制：启动守卫 / 锚点退役（dock 合并）/ 心跳控制帧崩合并 / composer WIP 的启动期-运行期崩 / 宿主配额在 `runMigrations` 的启动死 —— **没有一条**动「判据的整轮时长在宿主负载下越过 55000ms 天花板」。本条是**第八条**机制，且是 verification-only 的**归因**条（不改码）。

### 如实抄（DoD 末条）
本例收尾时 AC-175 `gate=goal` 台账尾巴**仍是 fail**（末三 `fail,fail,fail`）；直跑判据在低负载下为 **EXIT 0 / `3 passed (39.0s)`**。⛔ 不写成「已通过」。