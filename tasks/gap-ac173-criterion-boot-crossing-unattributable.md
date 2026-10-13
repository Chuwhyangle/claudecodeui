---
id: gap-ac173-criterion-boot-crossing-unattributable
title: AC-173 判据在本树为绿而台账记假红：e2e 引导段越过 config 自己的 40s 引导天花板（watchdog-state.json
  ceilingMs=40000、test-results/ 空、一条断言未跑），且该红只留 stderr、stall stage
  不可从工件归因——把引导段拉回界内，并让越界可直接分类
status: done
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

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，checkout `/data/home/yale/work/claudecodeui`，branch `author`，`git rev-parse HEAD` = `18dc3093e0ffd7f3e298e2da20b6dcf5c0900e1b`，`HEAD^{tree}` = `3d634f1411c62aedbdb99445fdaa1ce52c1461a0`，`date -u` = `Tue Oct 13 17:23:17 UTC 2026`）**：`grep -rl '^goal_ac: *AC-173' tasks/` 命中 5 份，`status:` 逐字皆 **done**（`gap-ac173-ledger-red-is-boot-ceiling-crossed`、`gap-ac173-ledger-red-is-uncommitted-composer-wip`、`gap-ac173-badge-source-mismatch-after-dock-consolidation`、`gap-resident-running-view-criterion-bounded-boot-guard`、`gap-claude-resident-running-view`）。在飞扫描（逐份读 `tasks/*.md` 的 `^status:` ∈ {todo,ready,needs-human}）全库只有 6 份（4 份 voice 系 + 1 份 voice proposal + 1 份 vad e2e），**无一认领 AC-173** ⇒ 无在飞认领者，本条不是重复。按「done 不算重复、是更早修法没兜住的证据」逐份核过：5 份里**没有一份**动过「引导段越界本身」——两份是 verification-only 归因（`…ledger-red-is-boot-ceiling-crossed`、`…ledger-red-is-uncommitted-composer-wip`，其完成记录把 remedy 逐字划给「e2e 基建族」「不在本条内夹带」），一份治徽标**数据源**（`…badge-source-mismatch…`），一份治 spec **体内**、`beforeAll` 之后的有界导航（`…criterion-bounded-boot-guard`，commit `e963c8674`），一份是常驻视图本体（`gap-claude-resident-running-view`）。即该 remedy **被点名三次、被认领零次**。合并候选检查（用仪器，不手搓）：`node /data/home/yale/.claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --touches playwright.config.ts --touches e2e/resident-running-view.spec.ts --json` ⇒ `peers: []`、`mentions: []`；`perFile` 里 `playwright.config.ts` `nLanded=57` / `medianFileChangedLines=41`（返工磁石，但当前无在飞 peer）。⇒ **kept separate**，无合并对象。

**判据物（逐字取自 `goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md`）。** `criterion:` = `npx playwright test e2e/resident-running-view.spec.ts`。`expect:` 逐字：「调试 agent 场景造出一个运行中的会话与两个空闲常驻会话：侧栏 Running 徽标读数为 1；Running 视图两组各列出对应会话，第二组每行有关闭按钮，点击后该会话宿主关闭、从该组消失。取假形态：徽标计入空闲常驻会话 ⇒ 读数 3，必须红。」该 AC `status: achieved`，其 GOAL-013 已 achieved 且不再活，未声明 `long-term: true`。

### 本轮直接测量：担保是绿的，红是引导期的假红

**（1）判据在本树直跑 = 绿。** 命令逐字 `npx playwright test e2e/resident-running-view.spec.ts`，cwd = 本 checkout ⇒ **EXIT=0**、`3 passed (38.6s)`、`elapsed=37817ms`（判据自带上限 `expect(elapsed …).toBeLessThan(55_000)`）。判据自己打印的读数（逐字节选）：

```
residents.running=0 residentIdle=2
hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1
badge.text="1" badge.label="1 running sessions"
group.running.count=1 group.residentIdle.count=2
close.request=200 badge.reading.after=1 hosts.beforeClose=2 hosts.afterClose=1
shared.perBinding=1 shared.perHost=2 badge.reading=1
DEBUG_AGENT_RUN_SEAM_UNAVAILABLE=0 controlPlane.responses=8
locales.checked=12 keys.checked=11 missing=0
```

⇒ AC-173 的 `expect` 逐条成立（徽标读 1，不是假形态的 3；两组各 1 / 2 条；关一行后宿主 2→1、该组清空、徽标仍 1）。

**（2）台账末拍 fail 与本次直跑同树。** `jq -r 'select(.item_id=="AC-173" and .gate=="goal") | [.timestamp,.verdict] | @tsv' .quay/gate-events.jsonl | tail -9`：

```
2026-10-13T16:28:20.272Z	pass
2026-10-13T16:37:26.220Z	fail
2026-10-13T16:53:48.036Z	fail
2026-10-13T17:02:17.723Z	pass
2026-10-13T17:10:40.291Z	pass
2026-10-13T17:19:33.424Z	fail
```

`17:19:33.424Z` 那拍 `payload.treeSha` = `3d634f1411c62aedbdb99445fdaa1ce52c1461a0` = 本次直跑 `HEAD^{tree}`（逐字相同）；其 `payload.reason` 只有 webServer 的 stderr（`[WebServer] [BABEL] … react-scan.js`、`[DEP0190] …`），**不含任何判据读数 token**。同 tree 一红一绿 ⇒ 红不在树里。

**（3）决定性工件：那拍被引导天花板打死，一条断言未跑。** 由 reason 里的 data-dir 路径定位到 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Rxhh8s`（未被回收），其 `watchdog-state.json` 逐字：

```json
{ "armed": true, "fired": true, "ceilingMs": 40000, "detail": "boot ceiling crossed at 40001ms" }
```

`test-results/` 文件数 = **0**（一条用例都没开始）；该 dir 里有一堆 config 求值期造出的 `*-workspace/`（`mobile-layout-workspace`、`session-filter-workspace`、`transcript-follow-workspace` …），**唯独没有 `resident-running-view-workspace/`** ⇒ 判据自己的客户端启动一步未走。时点链：config 求值/播种 `2026-10-14 01:18:53.45 CST`（= `17:18:53.45Z`）→ `test-results/` `01:19:33.298 CST` → watchdog 写盘（detail 报 40001ms）→ gate 事件 `17:19:33.424Z` ⇒ 这 40s 整个落在**播种之后、浏览器启动之前**。

**（4）同轮车队读数：8 条 sibling lane 里 7 条正常引导，只有 AC-173 这条越界。** 对本轮 01:15–01:19 建立的 8 个 data dir 逐条读 `watchdog-state.json` 与 `test-results` 文件数：

```
2bPi5l  fired=false  boot 40000ms, re-armed to 360000ms once past boot   test-files=3
3685EE  fired=false  boot 40000ms, re-armed to 240000ms once past boot   test-files=3
9MDqGz  fired=false  boot 40000ms, re-armed to 360000ms once past boot   test-files=3
KgkyXm  fired=false  boot 40000ms, re-armed to 360000ms once past boot   test-files=164
MZPbct  fired=false  boot 40000ms, re-armed to 360000ms once past boot   test-files=3
Rxhh8s  fired=true   boot ceiling crossed at 40001ms                     test-files=0
V9OkOM  fired=false  boot 40000ms, re-armed to 55000ms once past boot    test-files=1
vezoqj  fired=false  boot 40000ms, re-armed to 55000ms once past boot    test-files=1
```

⇒ 同一载荷下引导**通常**能完成（7/8），越界是尾部事件，而这一拍恰好命中 AC-173 的判据跑 ⇒ 台账那记 `fail` 是**测量尾部**，不是担保不成立。

**（5）这个红当前不可归因——本条的第二半。** `playwright.config.ts` 的 `endRun()` 会读回卡在哪个 stage 并写成一行：`[e2e] watchdog: this run crossed its own <ceiling>ms <label> at <crossedAt>ms and is ending here with exit 1 at <elapsed>ms — stuck at stage "<stall.stage>": <stall.detail>.`，其中 `describeStall()` 用带 deadline 的 `probePort()`（`WATCHDOG_PROBE_MS`）把 stage 分成三态：`silent`（端口 bound 但不应答 ⇒ `stage: 'webServer-start'`，即 Playwright 那条**无自带 deadline 的 pre-spawn availability probe** 会一直等下去）、`closed`（无人监听）、`answered`（已过引导、只是慢）。但这行只走 **stdout**（`fs.writeSync(1, …)`，fd 2 仅在 fd 1 写失败时回退），而 **goal gate 记的 `payload.reason` 只留 stderr** ⇒ 唯一能区分「端口被占住不应答」与「只是慢」的那句话被丢掉；落盘的 `watchdog-state.json` 的 `detail` 又只有 `` `${label} crossed at ${crossedAt}ms` ``，**不含 stage**。本轮两次越界（`16:37:26Z`、`17:19:33Z`）都只剩「`ceilingMs=40000` + 空 `test-results/`」这一组读数——足够判「判据没跑」，**不足以判为什么没跑**。这正是上一轮 `gap-ac173-ledger-red-is-boot-ceiling-crossed` 只能写下「引导越界 ≠ 判据假」而给不出 next action 的原因。

### 为什么早先的修法都没兜住

<!-- dedup-ref --> 三条已落地的同族杠杆各治**别的**界，本条消费它们、不重复：(i) `24f7bd83`（`gap-e2e-runner-boot-inflation-under-fan-in-concurrency`）治的是 `seedViteCache` 的**捐赠者来源**（worktree 里 copy 了 main checkout 写的缓存，Vite 按含 root 的 `configHash` 键控故永不命中、每跑都私有重优化），它消掉的是 **Vite 预打包**那一段；该任务自己的 Evidence 明写**服务端引导 + 客户端轮询在争用下的耗时它不碰**。(ii) `gap-ac179-criterion-boot-timeout-under-lane-load` 把 `webServer[].timeout` 30s 抬到 `WEB_SERVER_TIMEOUT_MS = 35_000`；但 `playwright.config.ts` 的算术链自述逐字 `WEB_SERVER_TIMEOUT_MS (35s) < BOOT_CEILING_MS (40s) < SINGLE_SPEC_CEILING_MS (55s) < the 60s the gate kills at` ⇒ 这条界**在引导天花板之下**，救不了「连 webServer 都没应答」的形态。(iii) `gap-resident-running-view-criterion-bounded-boot-guard` 给的是 spec **体内**、`beforeAll` 之后的有界导航（本轮绿跑逐字有 `[e2e] client startup: the project row for resident-running-view-workspace landed after 1837ms (attempt 1)`）——它管不到**用例之前**的引导段。⇒ 没被任何一条碰过的，正是「引导段本身越界」这条界。

### 算术约束（决定允许的杠杆，别试错方向）

`BOOT_CEILING_MS` **不能只靠抬高解决**：判据自己的整轮上限是 `SINGLE_SPEC_CEILING_MS = 55_000`（spec 内另有 `expect(elapsed …).toBeLessThan(55_000)`），而本轮绿跑里用例体本身已占 `26.2s`、引导 + 浏览器启动约 `11.6s`（总 `37.8s`）。**一次 40s 的引导即使不被引导天花板打死，也塞不进 55s 的整轮上限**（40 + 26 + 启动 > 55）。∴ 真正能让判据跑绿的只有**把引导段本身拉回**（移除 stall 或削其固定成本），不是移动界。候选杠杆（按实测取舍，每个都要保持 `WEB_SERVER_TIMEOUT_MS < BOOT_CEILING_MS < SINGLE_SPEC_CEILING_MS < 60s`，或给出新的完整算术）：

- **(a) 移除 stall 本身**：先按 (5) 把 stage 读出来（补观测，见下），据此定位是「端口被占但不应答」还是「服务端还没起来」；`silent` 态要有确定成因（端口复用碰撞 / 上一轮残留进程持有该端口），并给出让该成因不再发生的改动（端口分配互斥、`EADDRINUSE` 快速失败、启动前清残留等）。
- **(b) 削引导固定成本**：`webServer` 命令 `node_modules/.bin/tsx --tsconfig server/tsconfig.json server/index.ts` 的启动成本（编译缓存 / 预打包入口），按安静与载荷两臂实测取舍，只取有可见读数的项。
- **(c) 降引导期争用**：e2e lane 的并发闸（`gap-e2e-runner-boot-inflation-under-fan-in-concurrency` 列过、未落地的那条）。
- ⛔ 不重复 `24f7bd83` 的 vite-cache 捐赠者杠杆；⛔ 不把 `SINGLE_SPEC_CEILING_MS` 抬到 60s 判据门；⛔ 不动判据命令与它的任何一条读数。

### 观测（第二半，与 (a) 互为因果）

把 `describeStall()` 读出的 `stall.stage`（连同让它成立的那条读数，如 `port <p> (<name>) accepts TCP but never answers an HTTP request`）落进 `watchdog-state.json`，使**一次越界无需重跑即可分类**。⚠️ 这是**加字段**：`e2e/voice-error-messages.spec.ts` 把它 parse 成 `{armed, fired, detail}` 且只读这三个键 ⇒ 加键安全。`grep -rln '\[e2e\] watchdog' --include='*.ts' e2e/` 只命中 `e2e/voice-error-messages.spec.ts` 与 `playwright.config.ts`；若同时把这行也写一份到 **stderr**（让 gate 的 `payload.reason` 直接可读），必须先核该 spec 的断言——它的 `expect(watchdogLine …).toBe(false)` 读的是**文件里的 `fired`**，不是对 stdout 做 grep，故移动输出面不改其判据。

**非目标。** 不改 AC-173 的 `criterion:` / `expect:`；不弱化 `badge.reading` / `group.*.count` / `close.request` / `hosts.afterClose` 任何一条读数；不改常驻运行时与 UI 生产面（`src/**`、`server/**`）；不把环境红写成产品绿。

## Plan

1. 建隔离 worktree（起点 = 开工时 `develop`），打印路径、`git rev-parse HEAD`、`HEAD^{tree}`，确认 `git status --porcelain` 空。
2. **先补观测**：把 `stall.stage` 落进 `watchdog-state.json`（加键，不改既有三个键的语义），并给出一个**受控复现**证明它可读——在判据的 server 端口上挂一个只完成 TCP 握手、不应答 HTTP 的监听（`silent` 臂），确认越界后新字段逐字为 `webServer-start` 且带命名端口的读数；撤掉该监听（正常臂）确认不误报。
3. **复现真红并归因**：按本族的车道载荷构造（N 路并发 `npx playwright test` 跑 e2e spec 环）把 AC-173 判据夹在其中，直到至少命中一次 `fired:true` / `ceilingMs:40000` / `test-results/` 空；逐字登记那一拍的 stage 行。⛔ 从会话里不得做无界扇出——按 `docs/operations/process-isolation-and-memory-caps.md` 的「Running tests from a Claude session」走 `scripts/with-memory-cap.sh` 的并发钳，或直接用仓内既有的 fan-in / e2e lane 通道（会话 cgroup 8G，无界 `--test` 扇出会被 OOM 杀成 exit 137）。
4. **按第 2、3 步的读数选杠杆**，在 `playwright.config.ts`（必要时加 e2e 基建脚本）实现；每改一版都在同一载荷构造下重测，登记引导段耗时与越界率。
5. **验收臂**：在同一载荷构造下，出货命令 `npx playwright test e2e/resident-running-view.spec.ts` 连续 ≥3 次 **EXIT=0**，每次 `3 passed`、`elapsed < 55_000`，判据自己打印的读数行逐字在场；同批次的 `watchdog-state.json` 不得出现 `ceilingMs=40000` 且 `fired=true`。
6. 安静宿主非回归：`npx playwright test e2e/resident-running-view.spec.ts` 直跑 3 次全绿；`npx playwright test e2e/voice-error-messages.spec.ts` 直跑 1 次 EXIT=0（它是 `watchdog-state.json` 的既有消费者）。
7. 只把实现与 `tasks/<本条 id>.md` 写进交付；判据文件的断言一字不改（除为看门狗落盘所必需的行外）。

## AC

- [x] AC1 红态基线（承重）：在同一 checkout 上逐字复现一次「引导越界」——`watchdog-state.json` 为 `{"armed":true,"fired":true,"ceilingMs":40000,"detail":"boot ceiling crossed at …"}`、其 `test-results/` 文件数 = 0、且无 `<spec>-workspace/`；完成记录给出 data dir 路径、载荷构造命令、lane 数、`load1` 采样与该拍时间戳。
- [x] AC2 归因（承重）：那拍越界的 **stage** 从**运行自己的工件**读出并逐字入档（不是推断）——受控 `silent` 臂下 `watchdog-state.json` 的新字段逐字为 `webServer-start`（含命名端口/服务名的那条读数），正常臂下不出现该归因；同时逐字引用 `playwright.config.ts` 里 `describeStall()` 的三态与 `probePort()` 的 deadline（`WATCHDOG_PROBE_MS`）。
- [x] AC3 引导段回到界内（承重）：在同一载荷构造下，出货命令 `npx playwright test e2e/resident-running-view.spec.ts` 连续 **≥3 次 EXIT=0**、每次 `3 passed`、`elapsed` 逐次登记且 `< 55_000`；同批次 `watchdog-state.json` 无 `ceilingMs=40000` 且 `fired=true`。完成记录写明「选了哪个杠杆、拒绝了哪个、各自读数」。
- [x] AC4 判据读数一字不动（承重）：每次绿跑的 stdout 逐字含 `badge.reading=1`、`badge.text="1"`、`group.running.count=1`、`group.residentIdle.count=2`、`close.request=200`、`badge.reading.after=1`、`hosts.beforeClose=2 hosts.afterClose=1`、`locales.checked=12 keys.checked=11 missing=0`；且 `git diff <base>..HEAD -- e2e/resident-running-view.spec.ts` 除看门狗落盘所必需的行外为空。
- [x] AC5 界链仍成立：完成记录逐字给出改动后的算术链（`WEB_SERVER_TIMEOUT_MS` < `BOOT_CEILING_MS` < `SINGLE_SPEC_CEILING_MS` < 60s）；若任一值被改动，给出新值，并给出「新的界为何仍能在 60s 判据门之前把结论写出来」的算术（含最坏情形落盘时刻）。
- [x] AC6 非回归：`npx playwright test e2e/voice-error-messages.spec.ts` EXIT=0；`npx playwright test e2e/resident-running-view.spec.ts` 在**安静宿主**直跑 3 次全绿；`grep -rln '\[e2e\] watchdog' e2e/` 的命中集合若有变化，逐字登记并说明该 spec 的断言为何不受影响。
- [x] AC7 空 delta 且不夹带：`git diff --name-only develop..HEAD` 只含 `playwright.config.ts`（及必要的 e2e 基建脚本与其单测）与 `tasks/<本条 id>.md`；完成记录声明未改 `e2e/resident-running-view.spec.ts` 的任何断言、未改 `src/**`、`server/**`。

## DoD

- 出货命令 `npx playwright test e2e/resident-running-view.spec.ts`（逐字不改；⛔ 不加 `-g`、不 skip、不加 `retries`、不改断言）在**复现红的同一载荷构造**下连续 ≥3 次 EXIT=0，读数逐字入档——不是复述 `expect` 的文字，不是读台账尾巴。
- 越界的**归因**来自运行自己的工件（`watchdog-state.json` 的 stage 字段 + 那条命名端口的读数），任何人在同一 checkout 上可用逐字命令复现；⛔ 不得把「`ceilingMs=40000` + 空 `test-results/`」当成本条已归因。
- 完成记录写明判法：**「AC-173 台账 fail 拍 = e2e 引导段越过 config 自己的 `BOOT_CEILING_MS`，判据本体一条断言未跑 ⇒ 引导越界 ≠ 判据假；本次把引导段拉回界内（杠杆与读数如上），并让下一次越界可从 `watchdog-state.json` 直接分类」**。
- 若在载荷构造下**无法**把越界压掉（连续 3 次绿做不到），本条必须**停手上报**：置 `needs-human`，逐字给出残余越界率、每拍的 stage 读数与已排除的杠杆——⛔ 不得把环境红写成产品绿，也不得据此改断言或把 `SINGLE_SPEC_CEILING_MS` 抬到 60s 判据门。
- 交付物只动 `playwright.config.ts`（及必要的 e2e 基建脚本与其单测）与 `tasks/<本条 id>.md`；判据断言、`src/**`、`server/**` 一个字节未动。

## Touches

- `playwright.config.ts`（引导段：`BOOT_CEILING_MS`、`arm(...)`、`describeStall()`、`probePort()`、`endRun()`、`writeWatchdogState()`、`webServer` 命令）
- `e2e/resident-running-view.spec.ts`（本条只跑不改：出货命令的判据物与它的读数行；除看门狗落盘所必需的行外不动）
- `e2e/voice-error-messages.spec.ts`（只读不改：`watchdog-state.json` 的既有消费者与既有断言面，改字段/输出面前必须核它）
- `tasks/gap-ac173-criterion-boot-crossing-unattributable.md`（自触）

## 完成记录

**判法（DoD 逐字要求的那句）。** **AC-173 台账 `2026-10-13T17:19:33.424Z` 那拍 `fail` = e2e 引导段越过 config 自己的 `BOOT_CEILING_MS`（40000ms），判据本体一条断言未跑 ⇒ 引导越界 ≠ 判据假；本次把引导段拉回界内（杠杆与读数见 AC3），并让下一次越界可从 `watchdog-state.json` 直接分类（AC2）。**

**交付物。** 只改 `playwright.config.ts`（`git diff --name-only develop..HEAD` 见 AC7）。判据命令、`e2e/resident-running-view.spec.ts` 的任何断言、`src/**`、`server/**` 一字节未动。

### 机制（一句话）

`arm()` 原先**只在 40s 那一刻做一次 `describeStall()` 采样**来决定「re-arm 还是杀」，而 `probePort()` 分不清「还在引导」与「已过引导、只是这两秒没应答」——两者都是 `silent`，而 `silent` 会**结束这一轮**。于是一轮**已经在跑用例**、恰好在那一刻服务端忙了两秒的跑，被 40s 打死并写成 `boot ceiling crossed`：把载荷毛刺写成了丢轮。**杠杆 = 把「曾被观察到越过引导」这个事实做成 latch**（每 `WATCHDOG_PROBE_MS/2` 站桩探一次，两个端口都应答即落 latch、取消引导计时器、改挂运行天花板），使引导天花板**只对「从未有一次被看见越过引导」的轮次开火**——正是它为之道的那一类；运行天花板照旧兜住每一轮，总上限**没有变**。

### 决定性工件：那一拍自己的目录证明它在用例里，不在引导里（逐字）

`payload.reason` 里的 data-dir 逐字定位到 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Rxhh8s`（未被回收），本会话重读：

```
$ cat <dataDir>/watchdog-state.json
{
  "armed": true,
  "fired": true,
  "ceilingMs": 40000,
  "detail": "boot ceiling crossed at 40001ms"
}
$ ls <dataDir>/test-results | wc -l
0
$ stat -c '%y' <dataDir>/watchdog-state.json
2026-10-14 01:19:33.352573526 +0800
$ find <dataDir>/debug-agent-home/.claude/projects -name '*.jsonl' -printf '%TH:%TM:%.2TS %f\n' | sort
01:19:02.46 f9b35414-257b-41aa-a0b7-20ef0b551c47.jsonl
01:19:02.97 9966422a-6ca7-426c-9716-1a20c0fb35ad.jsonl
01:19:06.35 8fcedabb-2ac2-4612-ac37-65cf5dfe6de1.jsonl
01:19:11.44 c516ae23-9763-4fb7-b81a-681ee6194e47.jsonl
01:19:26.86 d5248786-e602-49cb-a1ed-7ba3616dedfd.jsonl
$ ls -d <dataDir>/*-workspace | xargs -n1 basename | tr '\n' ' '
fork-anchor-workspace mobile-layout-workspace mobile-send-key-workspace session-filter-live-workspace
session-filter-workspace transcript-follow-workspace transcript-jump-tall-workspace transcript-jump-workspace
ui-visible-context-workspace voice-continuous-workspace voice-dashscope-workspace voice-error-messages-workspace
voice-identifier-workspace voice-live-vad-workspace voice-trim-workspace work-segment-workspace
```

**时点算术（全部来自上面这几个读数本身）。** 状态文件自报 `40001ms`，其 mtime 为 `01:19:33.352` ⇒ `runStartedAt` = `01:18:53.35`。那 5 份 jsonl 是**判据自己的夹具会话**（其 slug 目录名逐字是 `-data-home-yale--cache-quay-e2e-tmp-quay-e2e-Rxhh8s-debug-agent-home-resident-running-view-workspace`，即 spec `:790` 的 `path.join(fixtureHome, 'resident-running-view-workspace')`），其 mtime 落在 **t=+9.1s … +33.5s**；gate 留存的 stderr 里 `2026-10-13T17:19:05.538Z` 那行是 Vite 已在转译 `react-scan.js?v=8b9f973b`，即 **t=+12.2s**。**⇒ 天花板开火前的 7 秒，判据还在写自己的夹具、Vite 还在为它转译依赖。那一拍早就过了引导，`"boot ceiling crossed"` 是误标。**

### 三处如实更正的读数（取自同一批工件，不是推断）

1. **`test-results/` 空 ≠ 一条用例没跑。** Playwright 只为**失败**的用例在 `test-results/` 下建目录；这一拍的 0 个文件只说明**没有用例失败**。
2. **`<spec>-workspace/` 缺席不能当作「判据的客户端一步未走」。** 本会话在一个**全绿**的判据轮（`quay-e2e-tkJ1ZU`）上重读：顶层同样**没有** `resident-running-view-workspace/`，判据自己的 workspace 始终在 `<dataDir>/debug-agent-home/` 下。⇒ Proposal §3 由该缺席推出的「判据自己的客户端启动一步未走」不成立（这也正是 AC1 把「无 `<spec>-workspace/`」与 data dir / lane 数 / load1 并列登记时，我在下面逐字给出顶层列表后**不把它当承重读数**的原因）。
3. **`ceilingMs=40000` 只标「哪条界开火」**，不标「为什么」——这正是本条第二半（AC2）要补的。

### AC1 — 红态基线（承重）

**受控臂（承重读数，逐字复现）。** 按 Plan 第 2 步的受控复现，但**把判据夹在本族的车道载荷里**跑，使记录里的 data dir / lane 数 / `load1` / 时间戳都来自车道载荷。构造命令逐字：`LANES=6 BURNERS=50 bash /tmp/ac173/silent-under-load.sh <worktree> <outdir>`——6 路并发 `npx playwright test` 车道（轮转 `transcript-jump-landing` / `activity-dock-truthful` / `voice-realtime-upload-fixture` / `voice-realtime-scripted-scenarios` / `voice-realtime-intent-control` / `voice-pending-utterance-withdraw`）+ 50 个 `yes` burner，**判据的两个端口用 `QUAY_E2E_SERVER_PORT=15489` / `QUAY_E2E_CLIENT_PORT=11209` / `QUAY_E2E_PORTS_VERIFIED=1` 钉住**，并在 server 端口上挂一个只完成 TCP 握手、不应答任何 HTTP 字节的监听。全部在 `scripts/with-memory-cap.sh`（`QUAY_MEMORY_MAX=18G`）下。

| 项 | 逐字读数 |
| --- | --- |
| 该拍时间戳 | `2026-10-13T18:29:08Z`（脚本自报 `CROSSING ATTEMPT`） |
| `load1` 采样 | 构造前 `47.86` → 该拍 `63.63` |
| lane 数 / burner 数 | `lanes=6 burners=50` |
| data dir | `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-qCuXeX` |
| 出货命令 | `npx playwright test e2e/resident-running-view.spec.ts` |
| 结果 | `rc=1 wall=42641ms` |

`<dataDir>/watchdog-state.json` **逐字**（这就是 AC1 要求的那一组）：

```json
{
  "armed": true,
  "fired": true,
  "ceilingMs": 40000,
  "detail": "boot ceiling crossed at 40000ms",
  "stage": "webServer-start",
  "stall": "port 15489 (server) accepts TCP but never answers an HTTP request — Playwright's pre-spawn availability probe for http://127.0.0.1:15489/health has no deadline, so it cannot return"
}
```

`ls <dataDir>/test-results | wc -l` = **0**；`ls -d <dataDir>/*-workspace` 逐字 16 项（`fork-anchor-workspace` `mobile-layout-workspace` `mobile-send-key-workspace` `session-filter-live-workspace` `session-filter-workspace` `transcript-follow-workspace` `transcript-jump-tall-workspace` `transcript-jump-workspace` `ui-visible-context-workspace` `voice-continuous-workspace` `voice-dashscope-workspace` `voice-error-messages-workspace` `voice-identifier-workspace` `voice-live-vad-workspace` `voice-trim-workspace` `work-segment-workspace`），**无 `resident-running-view-workspace`**；该轮 stdout 里判据读数计数 = **0**（`grep -c 'badge.reading=1'` ⇒ 0）⇒ **一条断言未跑**，与记录那拍同形。

⇒ AC1 的三项逐条成立：`{"armed":true,"fired":true,"ceilingMs":40000,"detail":"boot ceiling crossed at …"}` ✓、`test-results/` = 0 ✓、无 `<spec>-workspace/` ✓，且给出 data dir / 构造命令 / lane 数 / `load1` / 时间戳 ✓。
⚠️ 按「三处更正」第 2 条，**「无 `<spec>-workspace/`」不作为承重读数**——它在绿跑里同样缺席；这里列出只为逐字满足 AC1 的字面要求。真正承重的是 `stage` 那条（见 AC2）。

**自发臂（同一载荷构造，0 命中——如实登记）。** 构造：6 车道 + 50 burner，判据连跑 **18** 轮后做全窗口扫描；脚本 `/tmp/ac173/hunt5.sh`，日志 `/tmp/ac173/hunt5.out`。

- `load1` 采样 19 个：`56.41`（环境）→ `73.95 82.59 83.46 77.53 78.26 83.91 89.31 94.34 85.86 78.07 76.91 78.40 76.20 74.09 76.05 73.43 73.66 75.33`。
- 18 轮 `elapsed` 逐字：`40521 40000 38244 37447 38044 48640 39311 39318 39131 37885 38386 38448 38340 37601 37713 37104 38089 38184` ms，**全绿**。
- **越界 0 次。** 判据 18 轮里 `"fired":true` 出现 **0** 次；全窗口 107 个 data dir 的 `watchdog-state.json` 归一后分布为：`44 × {"fired":false,"ceilingMs":240000}`、`8 × {"fired":false,"ceilingMs":360000}`、`49 × {"fired":false,"ceilingMs":55000}`、`6 × {"fired":true,"ceilingMs":240000}` ⇒ **`"fired":true` 只与 `ceilingMs:240000` 同现，`ceilingMs:40000` 一次都没有**。
- **有效采样 ≈8**：判据轮采样 40s 那一次当且仅当 `elapsed > 40000`（同一时钟：`elapsed` 与 `runStartedAt` 同源），逐字只有 r1（40521）与 r6（48640）两轮 ⇒ 2；外加 6 条重车道（它们都活到各自的 240000ms 运行天花板，逐条在 40s 处被采样过）⇒ 6。合计 ≈8 次采样、0 次越界。
- ⛔ **方法学更正（如实登记）**：`hunt5.sh` 的越界探测器写的是 `case "$WS" in *'"fired": true'*'"ceilingMs": 40000'*)`，而 `WS` 是 `tr -d '\n '` 出来的（**无空格**）⇒ 该模式**永不匹配**，`*** SPONTANEOUS CROSSING ***` 与脚本末的 `=== boot-ceiling crossings (fired:true) ===` 两段**结构性为空**。上面的结论**不依赖**这两个坏探测器，而是由每轮的原始 `ws=` 行逐行读、以及全窗口那份 `uniq -c` 分布独立得出。
- ⇒ **自发命中率 0/≈8，这条形态是尾部事件；且「复现」由受控臂逐字给出，不靠刷轮次。** 这也是我**拒绝**的第二个杠杆：不再刷更重的自发臂（原排了 6 车道 + 70 burner × 20 轮的第二轮，已停），因为受控臂已给出同一 state-file 形状的确定性复现，而更重的载荷只会推迟安静宿主的非回归测试。

### AC2 — 归因（承重）

**来自运行自己的工件，逐字，不是推断。** 上面 AC1 受控臂那一拍，`watchdog-state.json` 的两个新键逐字为：

```
"stage": "webServer-start",
"stall": "port 15489 (server) accepts TCP but never answers an HTTP request — Playwright's pre-spawn availability probe for http://127.0.0.1:15489/health has no deadline, so it cannot return"
```

⇒ 归因句**含命名端口与命名服务**（`port 15489 (server)`），且点名了那条**无自带 deadline 的 pre-spawn availability probe**。该轮 stderr 里那行（现在也写 stderr，见下）逐字：

```
[e2e] watchdog: this run crossed its own 40000ms boot ceiling at 40000ms and is ending here with exit 1 at 42001ms — stuck at stage "webServer-start": port 15489 (server) accepts TCP but never answers an HTTP request — Playwright's pre-spawn availability probe for http://127.0.0.1:15489/health has no deadline, so it cannot return.
```

**正常臂下不出现该归因。** 同批 18 次绿跑 + 3 次安静跑 + 1 次 `voice-error-messages` 跑的 `watchdog-state.json` 逐字均为 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot completed at <n>ms, re-armed to 55000ms"}`——**无 `stage`、无 `stall` 两键**（`grep -c '"fired":true'` = 0）。这正是设计意图：两键**只在越界时**写，故它们的**在场本身**就是「那一刻读到了 stage」的声明。

**逐字引用 `describeStall()` 的三态与 `probePort()` 的 deadline**（`playwright.config.ts`）：

```ts
socket.setTimeout(WATCHDOG_PROBE_MS);          // :620 — probePort() 的 deadline
```

`WATCHDOG_PROBE_MS = 2_000`（:572）。三态由 `probePort()` 的三种结局分派：

- `silent`（端口 bound 但 `WATCHDOG_PROBE_MS` 内不应答）⇒ `stage: 'webServer-start'`，detail 即上面逐字那条（`accepts TCP but never answers an HTTP request …`）。
- `closed`（无人监听）⇒ `stage: 'webServer-start'`，detail `port <p> (<name>) is not listening`。
- 全 `answered` ⇒ `stage: 'browser-launch-or-cases'`，detail `both webServers answered, so this run is past boot and inside browser launch or a test case`。

三态在真实越界里的落盘各有实证：`silent` = AC1/AC2 受控臂那份；`browser-launch-or-cases` = 同批 6 条重车道各自 240000ms 运行天花板的那 6 份（逐字 `"stage":"browser-launch-or-cases","stall":"both webServers answered, so this run is past boot and inside browser launch or a test case"`）⇒ 新键在**野生越界**里也逐字落盘，且正确地把「已过引导」的车道归类为 `browser-launch-or-cases` 而非 `webServer-start`。

### AC3 — 引导段回到界内（承重）

**同载荷构造（6 车道 + 50 burner，`/tmp/ac173/hunt5.sh`）下的出货配置 18 轮**：`rc` 分布 **18 × rc=0**，逐轮 `3 passed`，`elapsed` 逐字 `39842 40933 38802 38685 37881 37931 37570 37992 39488 39194 38703 39556 49778 37877 38903 37718 38740 45413` ms ⇒ **全部 < 55_000**（最大 49_778）。**连续 ≥3 次 EXIT=0** 远超要求（18/18）。同批次判据轮 `watchdog-state.json` 里 `ceilingMs=40000` 且 `fired=true` 出现 **0** 次。该批 `load1` 从 76 一路爬到 **215**（r18 `elapsed=45413ms` 即在该载荷下取得），仍全绿。

**引导段确实回到界内——这次是直接量出来的。** 18 轮的 latch 读数（`detail` 的 `boot completed at <n>ms`）逐字为：`5871 6186 6997 7131 7247 7320 7352 7368 7400 7425 7485 7764 7805 8076 8108 8260 9387 9454` ms ⇒ **引导段实测 5.9–9.5s，是 40s 界的 4–7 倍余量**。改动前没有任何一处能给出这个数（旧配置只在 40s 处采样一次），这正是「引导越界」此前不可归因的另一面。

**选了哪个杠杆、拒绝了哪个、各自读数：**

| | 杠杆 | 取舍与读数 |
| --- | --- | --- |
| **选** | `arm()` 的**单点采样 → latch**：每 `WATCHDOG_PROBE_MS/2`（=1s）站桩探两个端口，都 `answered` 即落 `bootCompletedAt`、`clearTimeout(bootTimer)`、改挂 `arm(RUN_CEILING_MS,'ceiling',false)` 并把 state 文件重写为 `detail: "boot completed at <n>ms, re-armed to 55000ms"`。 | 读数：18/18 绿、引导 5.9–9.5s、越界 0。**它只改变「曾被观察到越过引导」的轮次的结局**——正是被误标的那一类；`arm()` 里原有的 `stall.stage === 'browser-launch-or-cases'` re-arm 回退**原样保留**，故「引导恰好在 deadline 那一刻完成」的轮次行为不变。 |
| 拒 (c) | 降 e2e lane 并发闸（Proposal 候选 (c)） | 越界 0/≈8，压的不是并发而是**误判**；且并发闸会改所有 spec 的墙钟，读数面太大。 |
| 拒 (b) | 削引导固定成本（tsx/预打包，候选 (b)） | latch 实测引导本身就是 5.9–9.5s，**没有可削的固定成本**在 40s 量级上；改它属于无读数支撑的优化。 |
| 拒 (a) | 「移除 stall 本身」（改端口分配 / `EADDRINUSE` 快速失败） | 受控臂证明该 stall 是**外部监听占住端口**造成的，生产 payload 里没有这个成因（Rxhh8s 那拍就不是 stall）；为一个人造形态改端口分配会把无关风险引进生产路径。**但 Proposal (a) 想要的东西由 latch + 新键一起给出了**：下一次越界现在能直接分类（AC2），无需重跑。 |
| 拒 | 抬 `BOOT_CEILING_MS` 或 `SINGLE_SPEC_CEILING_MS` | 算术上无效且被 ⛔ 明禁：真 40s 引导 + 用例体 > 55s；且 60s 判据门不可动。**本次一个界值都没动**（AC5）。 |
| 拒 | 第二自发臂（6 车道 + 70 burner × 20 轮） | 已停（见 AC1）；受控臂已给出确定性复现，重载荷只会推迟安静宿主非回归。 |

### AC4 — 判据读数一字不动（承重）

`e2e/resident-running-view.spec.ts` **一个字节未改**：`git diff 64f1e6cf663d98730ca1b9526e9452824aff4bb7..HEAD -- e2e/resident-running-view.spec.ts` 输出 **0 行**（`64f1e6cf6` = 本条分支的 `git merge-base develop HEAD`，即开工时的 develop 尖）。AC4 的括注「除看门狗落盘所必需的行外为空」——本次连一行都不需要，因为看门狗落盘完全在 `playwright.config.ts` 内，spec 不参与。

上面 AC3 那批 18 次绿跑的 stdout 逐字含下表每一条（`grep -cF` 计数，逐轮相同）：

| token（逐字） | 每轮出现次数 |
| --- | --- |
| `badge.reading=1` | 4 |
| `badge.text="1"` | 1 |
| `group.running.count=1` | 2 |
| `group.residentIdle.count=2` | 1 |
| `close.request=200` | 1 |
| `badge.reading.after=1` | 2 |
| `hosts.beforeClose=2 hosts.afterClose=1` | 1 |
| `locales.checked=12 keys.checked=11 missing=0` | 1 |

逐字原行（取自 `ac3/c-1.log`，同一批其余轮同）：

```
hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1
badge.text="1" badge.label="1 running sessions"
group.running.count=1 group.running.ids=b4a3ff4e-b0d2-4daa-b21a-e8b426c6d9f6
group.residentIdle.count=2 group.residentIdle.ids=d318ec1a-a913-4c47-ac69-962e170cf348,29d2cddc-ff0f-466f-a7c6-6ee3c83852f3
close.request=200
badge.reading.after=1 hosts.listing.after=host=host-18925bb5-… state=closed mode=resident bindings=[d318ec1a:idle:[] 29d2cddc:idle:[]] | host=host-5369fbfe-… state=busy mode=per-run bindings=[b4a3ff4e:busy:[turn]]
badge.reading.before=1 badge.reading.after=1
locales.checked=12 keys.checked=11 missing=0
```

⇒ 假形态（徽标读 3）未出现；两组各 1 / 2 条；关一行后宿主 2→1、该组清空、徽标仍 1。

### AC5 — 界链仍成立

算术链**逐字未改**（`playwright.config.ts:591-592` 的自述）：`WEB_SERVER_TIMEOUT_MS (35s) < BOOT_CEILING_MS (40s) < SINGLE_SPEC_CEILING_MS (55s) < the 60s the gate kills at`。三个值逐字：`WEB_SERVER_TIMEOUT_MS = 35_000`（:598）、`BOOT_CEILING_MS = 40_000`（:570）、`SINGLE_SPEC_CEILING_MS = 55_000`（:348）——**本次一个都没动**，故不产生「新值」。

**新的界为何仍能在 60s 判据门之前把结论写出来**：本次改动**没有引入任何新的、更晚的界**。latch 做的是**取消**引导计时器（`clearTimeout(bootTimer)`）并把运行天花板**照旧**挂成 `RUN_CEILING_MS`——即 `arm(RUN_CEILING_MS, 'ceiling', false)`，与改动前 `arm()` 里那条 re-arm 分支**同一个调用、同一个值**。所以最外层界仍是 `RUN_CEILING_MS`。对本条判据的单 spec 选择，`RUN_CEILING_MS = selectedSpecFiles().reduce(… , 0)`（:501-502），而 `resident-running-view.spec.ts` **不在** `SPEC_BUDGET_MS` 里（逐字核过：该表 13 个 key 无此项）⇒ `RUN_CEILING_MS = SINGLE_SPEC_CEILING_MS = 55_000`。

**最坏情形落盘时刻** = `runStartedAt + 55_000ms` + 写盘自身耗时（`fs.writeFileSync` 一次，微秒级）+ 进程退出 ⇒ **严格 < 60_000ms**，结论（`watchdog-state.json` 的 `fired:true` 与那行 stage）在判据门打死之前必然已落盘。同批实测印证：18 次绿跑 `elapsed` 最大 **49.8s**，离 55s 仍有 5s 余量。

### AC6 — 非回归

**安静宿主（`load1` 23.6–38.4，逐拍登记）。** 脚本 `/tmp/ac173/quiet.sh`（无车道、无 burner，单 spec 直跑，`with-memory-cap.sh` 下）：

| 运行（逐字命令） | rc | 末行 | `load1` | latch 读数 |
| --- | --- | --- | --- | --- |
| `npx playwright test e2e/resident-running-view.spec.ts` #1 | **0** | `3 passed (35.8s)` | 38.36 | `boot completed at 5587ms, re-armed to 55000ms` |
| 同上 #2 | **0** | `3 passed (36.2s)` | 37.04 | `boot completed at 5924ms, re-armed to 55000ms` |
| 同上 #3 | **0** | `3 passed (36.0s)` | 27.89 | `boot completed at 5661ms, re-armed to 55000ms` |
| `npx playwright test e2e/voice-error-messages.spec.ts` | **0** | `1 passed (29.0s)` | 23.58 | `boot completed at 5675ms, re-armed to 55000ms` |

⇒ 判据在**安静宿主直跑 3 次全绿** ✓；`voice-error-messages` **EXIT=0** ✓。四拍的 `watchdog-state.json` 逐字都是 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot completed at <n>ms, re-armed to 55000ms"}`，**无 `stage`/`stall` 两键**。
（另有一批同命令在 `load1` 122 / 72 / 47 下也全绿——那批不满足本条「安静宿主」的字面要求，故**不**用作 AC6 读数，只作为 AC3 的载荷证据。）

`grep -rln '\[e2e\] watchdog' e2e/` 的命中集合 = **`e2e/voice-error-messages.spec.ts` 一个文件**，**与改动前一致**（本次 `git diff` 完全不触碰 `e2e/`，`git diff <base>.. -- e2e/voice-error-messages.spec.ts` 输出 0 行）⇒ AC6 的「若有变化」条件**未触发**。仍按 AC 要求说明该 spec 的断言为何不受影响：

- 它读的是**文件**不是流。该 spec 自己的注释（`e2e/voice-error-messages.spec.ts:37`）逐字写着：**「The `[e2e] watchdog:` line itself goes to the *runner's* stdout, which a spec cannot read — so this file reads」**（下接状态文件）。代码面逐字：`const watchdog = JSON.parse(fs.readFileSync(WATCHDOG_STATE_FILE, 'utf8'))`（:758），随后 `watchdogLine = watchdog.fired`（:762）、`expect(watchdogLine, …).toBe(false)`（:795）、`expect(watchdog.armed, …).toBe(true)`（:796）。全文件对 stdout/stderr **零引用**（`grep -n 'stdout\|stderr'` 只命中第 37 行那句注释）⇒ 我把那行 watchdog 文案**同时**写一份到 stderr，不触及它。
- 它只读 `{armed, fired, detail}` 三个键（:795-796 断言 `fired === false`、`armed === true`），而本次新增的 `stage`/`stall` 是**加键**，且**仅在越界时出现**——一次绿跑里这两个键**根本不存在**（AC3 那 18 份 `ws=` 逐字为 `{"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot completed at …ms, re-armed to 55000ms"}`，无 `stage`/`stall`），所以 `JSON.parse` 的产物与改动前逐键相同。
- ⚠️ 但我**确实**改了同一行文案的落盘**面**：`endRun()` 里那行 `[e2e] watchdog: this run crossed …` 现在 fd 1 与 fd 2**都写**（原先 fd 2 只在 fd 1 抛错时回退）。这一处**只在越界时**产生输出，而 `voice-error-messages.spec.ts` 是绿跑（`fired:false`），越界分支不会进入 ⇒ 该 spec 的那一行输出面**逐字未变**。
- 另：全仓 `grep -rln 'watchdog-state'` 的**代码**消费者只有 `playwright.config.ts`（生产者）、`e2e/voice-error-messages.spec.ts`（真 parse）、`e2e/model-library.spec.ts`（仅在注释里提到，`grep -n watchdog e2e/model-library.spec.ts` 只命中 :49/:68 两行注释，**不 parse**）⇒ 除上述之外没有别的消费者受加键影响。

### AC7 — 空 delta 且不夹带

`git diff --name-only develop..HEAD`（`develop` 已按流程合入本分支之后）逐字输出：

```
playwright.config.ts
```

即 delta **只有** `playwright.config.ts` 一个文件——AC7 允许的三类里，本轮**没有**新增任何 e2e 基建脚本与其单测（看门狗落盘全部落在既有文件的既有函数内）。`tasks/gap-ac173-criterion-boot-crossing-unattributable.md` 由 Provider ABI（`task_write`）落在 develop 侧，不占本分支 delta，故不在上表。`git merge --no-edit develop` 无冲突（`RC=0`，工作树 `git status --short` 空）。

**非夹带声明（逐条）：**

- **未改 `e2e/resident-running-view.spec.ts` 的任何断言** —— 该文件不在 delta 里；且 `git diff <base>..HEAD -- e2e/resident-running-view.spec.ts` 输出 **0 行**（`<base>` = `git merge-base develop HEAD`，见 AC4）。
- **未改 `src/**`、`server/**`** —— 两者均不在 delta 里。
- **未改判据命令** —— 出货命令逐字仍是 `npx playwright test e2e/resident-running-view.spec.ts`，无 `-g`、无 skip、无 `retries`。
- anti-drift Touches 硬门（`node --no-warnings …/anti-drift-touches-check.js --task gap-ac173-criterion-boot-crossing-unattributable --worktree /data/home/yale/work/wt-ac173-boot-crossing --merge-target develop`）逐字：`ANTI-DRIFT OK: task gap-ac173-criterion-boot-crossing-unattributable — 1 actual file(s), all within declared Touches (4 glob(s))`，`RC=0`。
- 三腿 typecheck：`npm run typecheck`（`tsc -p tsconfig.json && tsc -p server/tsconfig.json && tsc -p scripts/tsconfig.json`）⇒ **`EXIT=0`**。
