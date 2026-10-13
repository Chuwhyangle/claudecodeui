---
id: gap-ac173-criterion-boot-crossing-unattributable
title: AC-173 判据在本树为绿而台账记假红：e2e 引导段越过 config 自己的 40s 引导天花板（watchdog-state.json
  ceilingMs=40000、test-results/ 空、一条断言未跑），且该红只留 stderr、stall stage
  不可从工件归因——把引导段拉回界内，并让越界可直接分类
status: ready
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

- [ ] AC1 红态基线（承重）：在同一 checkout 上逐字复现一次「引导越界」——`watchdog-state.json` 为 `{"armed":true,"fired":true,"ceilingMs":40000,"detail":"boot ceiling crossed at …"}`、其 `test-results/` 文件数 = 0、且无 `<spec>-workspace/`；完成记录给出 data dir 路径、载荷构造命令、lane 数、`load1` 采样与该拍时间戳。
- [ ] AC2 归因（承重）：那拍越界的 **stage** 从**运行自己的工件**读出并逐字入档（不是推断）——受控 `silent` 臂下 `watchdog-state.json` 的新字段逐字为 `webServer-start`（含命名端口/服务名的那条读数），正常臂下不出现该归因；同时逐字引用 `playwright.config.ts` 里 `describeStall()` 的三态与 `probePort()` 的 deadline（`WATCHDOG_PROBE_MS`）。
- [ ] AC3 引导段回到界内（承重）：在同一载荷构造下，出货命令 `npx playwright test e2e/resident-running-view.spec.ts` 连续 **≥3 次 EXIT=0**、每次 `3 passed`、`elapsed` 逐次登记且 `< 55_000`；同批次 `watchdog-state.json` 无 `ceilingMs=40000` 且 `fired=true`。完成记录写明「选了哪个杠杆、拒绝了哪个、各自读数」。
- [ ] AC4 判据读数一字不动（承重）：每次绿跑的 stdout 逐字含 `badge.reading=1`、`badge.text="1"`、`group.running.count=1`、`group.residentIdle.count=2`、`close.request=200`、`badge.reading.after=1`、`hosts.beforeClose=2 hosts.afterClose=1`、`locales.checked=12 keys.checked=11 missing=0`；且 `git diff <base>..HEAD -- e2e/resident-running-view.spec.ts` 除看门狗落盘所必需的行外为空。
- [ ] AC5 界链仍成立：完成记录逐字给出改动后的算术链（`WEB_SERVER_TIMEOUT_MS` < `BOOT_CEILING_MS` < `SINGLE_SPEC_CEILING_MS` < 60s）；若任一值被改动，给出新值，并给出「新的界为何仍能在 60s 判据门之前把结论写出来」的算术（含最坏情形落盘时刻）。
- [ ] AC6 非回归：`npx playwright test e2e/voice-error-messages.spec.ts` EXIT=0；`npx playwright test e2e/resident-running-view.spec.ts` 在**安静宿主**直跑 3 次全绿；`grep -rln '\[e2e\] watchdog' e2e/` 的命中集合若有变化，逐字登记并说明该 spec 的断言为何不受影响。
- [ ] AC7 空 delta 且不夹带：`git diff --name-only develop..HEAD` 只含 `playwright.config.ts`（及必要的 e2e 基建脚本与其单测）与 `tasks/<本条 id>.md`；完成记录声明未改 `e2e/resident-running-view.spec.ts` 的任何断言、未改 `src/**`、`server/**`。

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
