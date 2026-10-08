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

- [ ] AC1 判据在同 checkout 上直跑：`npx playwright test e2e/resident-busy-send.spec.ts` 退出 **0**、`3 passed (44.x s)`；完成记录里逐字给出 `git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`date -u`，以及判据自己打印的读数行（至少含 `resident.queuedCard=0`、`resident.row.annotation=Will be handled after this answer finishes`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1`、`elapsed=`）。红态基线（本轮立案读数）：台账 `2026-10-08T23:42:01.669Z` 记 fail。
- [ ] AC2 决定性 artifact 入档：逐字给出 `$HOME/.cache/quay-e2e-tmp/quay-e2e-rrLOMM/watchdog-state.json` 的全部四个字段（须含 `"fired":true`、`"ceilingMs":55000`、`"ceiling crossed at 55001ms"`）与其 `stat` mtime；写出 mtime（UTC）与台账 `2026-10-08T23:42:01.669Z` 的差（目标 ≤1s）。
- [ ] AC3 台账归因（机械、可被任何人复现）：打印 AC-175 `gate=goal` 末五拍 `verdict` 序列（应为 `pass,pass,pass,pass,fail`）；逐字给出 `23:42:01.669Z` 那拍的 `payload.reason` 可见部分并指出其中**不含**任何判据读数 token、只含 `[WebServer]` 噪声；给出该拍 `payload.treeSha` 并证明它等于本 checkout 的 `HEAD^{tree}`。
- [ ] AC4 分辨力（承重）：判据本体读数集合与 `23:42:01.669Z` 的 fail reason 可见文本**零交集**——把两组字符串并列入档，并给出同 treeSha（`35cd8acdadac8050ae1685afe0817e22d33befaa`）下 `23:42Z` fail 与本次直跑 pass 的对照。⚠️ 若本次直跑为红，本条归因不成立，见 DoD 的停手条款。
- [ ] AC5 负载包络读数（承重）：逐字给出 `goal-round.jsonl` 里 AC-153 `frozenRecheck` 的 `load1`/`durationMs` 序列、本窗 AC-153 `goal` fail 的 `vite ws proxy error: Error: write EPIPE` 行、`nproc`、`uptime` 的 `load average`、`echo TMPDIR`、`ls $HOME/.cache/quay-e2e-tmp | wc -l`、`df -h /data`。
- [ ] AC6 「AC-153 重标不可迁移」机械入档：逐字给出 `playwright.config.ts:320` 的 `SINGLE_SPEC_CEILING_MS = 55_000`、`e2e/resident-busy-send.spec.ts:1076` 的 `toBeLessThan(55_000)`、`SPEC_BUDGET_MS` 的四个条目（`:332/:333/:338/:345`）与「不含 `resident-busy-send.spec.ts`」的 grep 输出；写出 `60−55=5s` 抬升上限 vs 实测膨胀 `+19s` 的数值对照，结论为 AC-153 的重标模式对 AC-175 无解。
- [ ] AC7 空 delta 且不夹带：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`（ABI 写入后未 merge 前）/ 空（merge fast-forward 后）二态皆成立；完成记录声明本条**未**改 `e2e/resident-busy-send.spec.ts`、`src/**`、`server/**`、`scripts/**`、`playwright.config.ts`，并指明 remedy（缩短整轮时长 / 降驱动并发 / 换有余量的运行目录）属 e2e 基建/驱动负载族、不在本条内修；跑前后 `git status --porcelain` 逐字相同。

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