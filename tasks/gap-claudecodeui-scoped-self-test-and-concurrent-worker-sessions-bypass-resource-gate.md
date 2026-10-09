---
id: gap-claudecodeui-scoped-self-test-and-concurrent-worker-sessions-bypass-resource-gate
title: 跨项目资源准入未闭环：worker 自身的 scoped 自测与同项目内并发 worker session 不经过
  resource-gate.sh，疑似是 resident-server-restart 高红率的资源争抢来源
status: superseded
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

**背景**：`gap-claudecodeui-reuses-quay-resource-gate-for-fleet-admission`（声明性,done）原先的结论"共享入口存在=全局quota已闭环"覆盖面被高估——已在该任务里更正,本任务接手把更正里点名的归因假说和覆盖面缺口单独立案,避免声明性任务继续膨胀。

**覆盖面现状（已核实,非假设）**：

| 并发来源 | 是否经过 `resource-gate.sh` |
|---|---|
| 机械 fan-in 派发（`worker-driver.js` 发起全量 suite 前） | ✅ 覆盖 |
| 本地/手动直接跑 `npm test` / `bash scripts/test.sh` | ❌ 不覆盖（`grep -n "resource-gate\|process-budget" scripts/test.sh` 零命中） |
| worker 自己在 worktree 里跑的 `--for-task` scoped 自测（AC 自验的标准步骤） | ❌ 不覆盖 |
| 同项目内多个 worker session 并发在飞 | ❌ 不覆盖（`.git/fan-in.lock` 只序列化 fan-in 合并步骤本身，不序列化各 worker 在自己 worktree 里跑的任何测试） |
| 跨项目（quay/cantus/…）同时起的重活 | 部分覆盖：各项目若都接了 A 面，各自派发前读同一份宿主级 PSI/loadavg **时点快照**，不是**持有的租约/配额扣减**——N 个项目/worker 可以在同一秒都读到 GO 然后同时开始跑，运行期间互相不协调 |

**归因假说（有时间关联证据，尚未做因果验证）**：2026-10-09T02:40–04:29Z 窗口内，`.quay/worker-round.jsonl` 显示 ClaudeCodeUI 项目自己同时有 2–4 个 worker session 在不同 worktree 并发在飞（`gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged`、`gap-mcp-pending-interaction-visibility-and-idempotent-answer`、`gap-voice-realtime-live-session-send-wiring`、`gap-voice-realtime-connection-resilience`）。同一窗口 `.quay/verification-round.jsonl` 的 9 轮机械 fan-in 里 8 轮红，失败文件高度集中在 `server/modules/session-hosts/tests/resident-server-restart.test.ts`（6/9 轮）——该判据是已知的、owner 已承认「触发源（lane 并发下真实 claude 重拉延迟）不在本仓可控范围」的负载敏感判据（`gap-resident-server-restart-criterion-wait-headroom-under-lane-load`，done，margin 修法，非根治）。本任务要验证：这 2–4 个并发 worker session 自己在各自 worktree 里跑的 scoped 自测（会拉起真实 `claude` resident 进程）是否正是把 lane 负载推过已有余量（`ROUND_TIMEOUT_MS` 60s = 38.9s×1.5）的那个来源——如果是，说明问题不在判据本身的余量够不够，而在准入层完全没有计入这类并发源。

**本任务的范围边界（重要）**：
- 不重新修 `resident-server-restart.test.ts` 本身（它的余量修法已 done，且明确声明"若红仍复发，按宿主负载归因，不得栽到该任务头上"）。
- 不弱化 `resource-gate.sh` 现有的 fail-closed 语义，不降低任何现有的全局上限（`quay-fleet.slice` MemoryMax=64G 等）。
- 覆盖面扩展若需要 quay 侧（`worker-driver.ts`/`resource-gate.sh`/`process-budget.sh`）的机制改动，本任务只负责验证归因 + 提出设计方向，不代表 quay 侧已认领；需要另行与 quay 侧协同（参考本仓与 quay 侧 2026-10-09 已有的一次对等会话协同记录）。

## 调查记录（AC1 实验 + AC3 归因，2026-10-09）

**结论一句话**：AC1 的因果假说**未证实**（不成立）。判据不是"时间关联不够强"，而是两点独立证据都指向**另一条机制**：(1) 实测 `waitForResidentPid` 延迟随并发数**平坦**、离余量 ~1000×；(2) 本仓 773 轮 verification-round 里 resident-server-restart 的红**全部**是 `swept=0` 家族，`waitForResidentPid` 超时家族**一次都未出现**。真实机制是测试自己已逐字登记的**宿主级清扫竞态**，不是重拉延迟被负载推过余量。按 AC3 分支关闭。

### 一、AC1 可控复现（真实测得，非推断）

**方法**：对 `server/modules/session-hosts/tests/resident-server-restart.test.ts` 做**可还原**的最小埋点（`waitForResidentPid` 成功/超时各打 `PROBE waitForResidentPid elapsed_ms=`；`bootServer` 打 `PROBE bootServer ready_ms=`；清扫腿打 `PROBE sweep-attempt swept=`），加 `PROBE_WORKER` 区分实例；再以 N∈{1,2,4} **并发同跑同一判据**（runner：`tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test <file>`）。跑完 `git checkout --` 还原，`git diff` 为空（判据文件一字未留）。这是"同类会真实拉起 `claude` resident 进程的 scoped 测试"的**上界**：同一个最重的真进程判据并发，比 worker 各跑轻量 scoped 自测更压。

**宿主对照变量**：`nproc --all = 128`，MemTotal 252897MB；`resource-gate.sh` 的过载线 = nproc×LOAD_OVER_FACTOR = 128×2 = **256**。各相位 1-min loadavg：N=1 → 31.0–36.4；N=2 → 25.2–31.0；N=4 → 23.6–25.2（全部在 GO 带内）。

| N | 并发总墙钟 | 每实例 exit | `waitForResidentPid` 实测（ms，三处调用点） | `bootServer` ready（ms） | 清扫读数 | 结果 |
|---|---|---|---|---|---|---|
| 1 | 18s | 0 | 4 / 65 / 4 | 4253 / 3938 / 4388 | swept=1 | 绿 |
| 2 | 19s | 0, 0 | (4/65/3), (3/61/3) | 3793–4994 | swept=2, swept=2 | 绿 |
| 4 | 19s | 0, 0, 0, 0 | 全部 ≈ (3–4)/(43–62)/3 | 3791–5754 | swept=4 ×4 | 绿 |

**判定**：`waitForResidentPid` 实测在 N=1/2/4 三点上**无单调上升**（最坏一处 65ms），对 `ROUND_TIMEOUT_MS = 60_000ms` 余量约 **1000×**；`bootServer` ready 亦平坦（~3.8–5.8s）。**不存在**"并发 worker 数越多，重拉延迟越逼近/越过已有余量"的因果关系。

### 二、跨径证据（比单次实验更强）：红家族分类

把 `.quay/verification-round.jsonl` 全 773 轮的 resident-server-restart 失败断言行分类：

- `the next boot swept nothing in N attempt(s) (swept=0); the orphan was not there to reap` → **16** 条
- `Timed out after …ms waiting for …`（`waitForResidentPid` 超时家族）→ **0** 条

窗口 02:30–04:40Z 的 6 轮 resident-server-restart 红（round 758/760/763/766/769/771）全是 `swept=0`，其 `perFile.durationMs` ≈ 27032–27911ms——**远低于** 60000ms 等待；若红落在 `waitForResidentPid` 超时，单文件时长必 ≥60s。这 6 轮所在窗口 load 跨 22.8–56.3，全历史红轮 load 跨 15.6–90.1，与 load **不单调** ⇒ `swept=0` 不是负载驱动。

### 三、假设的前件核实：窗口内 worker 的 scoped 自测是否真拉真 `claude`

窗口内 in-flight 的 4 个 worker 任务的 `## Touches` 落到哪些测试，以及那些测试是否 spawn 真 `claude`（`grep -cE "spawnSync?\('?(claude|npx)'?|'claude'|\"claude\""`）：

- `gap-voice-false-forms-…` → voice false-forms 测试（无 real-claude resident）
- `gap-voice-realtime-live-session-send-wiring` → voice-realtime 测试
- `gap-voice-realtime-connection-resilience` → voice-realtime 测试
- `gap-mcp-pending-interaction-…` → 含 `server/modules/providers/tests/claude-resident-permissions.test.ts`，该文件实拉真 `claude` 的处数 = **0**

⇒ 该窗口的 worker scoped 自测**不会**拉起真实 `claude` resident 进程。假说前件（"会真实拉起 `claude` resident 进程的 scoped 自测"）在我们观察的那段窗口里并未成立。

### 四、覆盖面核实（缺口属实，但后果不是本假说）

`grep -rn "resource-gate\|process-budget" scripts/ server/ .github/`（去 node_modules）= **零命中**。⇒ scoped/手跑路径确无 `resource-gate` hook，覆盖面缺口属实。但该缺口在数据里的后果**不是** resident-server-restart 的超时家族。

### 五、真实的红机制（本仓已登记，非本假说）

`resident-server-restart` 的红是 `swept=0`：leg2 SIGKILL 留下孤儿 scope，leg3 期望"下次 boot 清扫它"；而清扫**是宿主级**的（任何 boot 收敛**所有**属主已死的 scope），于是**任何并发 boot**（同轮 suite 的兄弟 real-server 测试，lane≈127；或别的 worktree 的 server boot）会**先**扫掉本腿的孤儿 ⇒ 本腿 `swept=0`。判据自己已在 `resident-server-restart.test.ts:1083-1092` 逐字登记该机制（"The sweep is HOST-WIDE by design … another server booting … reaps the orphan first, and this boot then honestly reads `swept=0`"），并用 `SWEEP_ATTEMPTS=3` 有界重试兜住（`:1166`）。窗口里 6 轮红 = 3 次重试仍全 `swept=0`（并发 boot 足够密）。

⇒ 归因落回 **`gap-resident-server-restart-criterion-wait-headroom-under-lane-load`（done）已登记的同一 flake 的"兄弟形态 swept=0"**，与该判据"若复发，按同一类别登记、不重实现产品代码"的记载一致；本仓记忆中该形态亦记为 scope-collection race。

### 六、为什么走 AC3 而非 AC2

AC2 的前件是"AC1 证实因果关系"——前件为假，故不提出/不采纳覆盖方案；AC3 又明文"不新增覆盖机制"。范围门（AC4）：本次**零源码改动**（唯一落账为任务文件本身经 `task_write`），typecheck/lint 无新增风险面；未改 `resource-gate.sh`/`process-budget.sh`，无需 quay 侧协同；未降低任何全局并发/内存上限。

### 七、未验证项（如实声明）

实验落在 load 24–36（`resource-gate` GO 带内，≪ nproc×2=256），**未**在 ≥1×nproc 的重过载窗口复测该曲线。该限制不动摇结论，因为：(a) 被解释的红轮本身也在 load 15.6–90.1，跨度覆盖该区间；(b) 历史 in-lane 膨胀（38.9s）本仓已记为"瞬态、不可按需复现"；(c) 红家族在 773 轮里从未出现超时形态——若是延迟机制，超时形态本应出现过。

## AC

- [x] AC1 因果验证（不是时间关联）：构造一个可控复现——同时起 N 个（N∈{1,2,4}）会真实拉起 `claude` resident 进程的 scoped 测试（如 `resident-server-restart.test.ts` 本身或同类 `claude-resident-*.test.ts`），分别单独跑与并发跑，记录 `resident-server-restart.test.ts` 的 `waitForResidentPid` 实测延迟随并发 worker 数的变化曲线，判定是否存在"并发 worker 数越多，重拉延迟越逼近/越过已有余量"的因果关系（而非仅仅时间上吻合）。 ——**已执行，假说未证实**：N=1/2/4 的 `waitForResidentPid` 实测 3–65ms、无单调上升（余量 60000ms ≈ 1000×），boot ready 平坦，N=4 全绿；跨径证据 773 轮中该判据红 16/16 全 `swept=0`、超时家族 0 次。读数见「调查记录」一/二节。
- [x] AC2 若 AC1 证实因果关系：提出并评估至少一种覆盖方案，二选一或组合——(a) worker 自己的 scoped 自测调用 `resource-gate.sh`（需要机制上区分"轻量单文件判据"与"全量 suite"，避免把检查成本本身变成新的开销）；(b) 同项目内对"会拉起真实 resident 进程的测试文件"引入一个项目内的轻量互斥（例如基于 flock 的命名资源槛，而非笼统的 suite 级锁），使同一时刻只有一个真实 `claude` resident 进程在跑。每个方案都要回答：是否保持 fail-closed（机制故障时默认 WAIT 而非默默放行）；是否保持现有全局上限不变；对现有 worker 吞吐的预期影响量级。 ——**前件为假，不适用（vacuous satisfied）**：AC1 未证实因果，不提出/不采纳覆盖方案；AC3 明文"不新增覆盖机制"。
- [x] AC3 若 AC1 不能证实因果关系（如实记录,不得假装证实）：如实记录"时间关联存在、因果未坐实"，并将归因重新指向 `gap-resident-server-restart-criterion-wait-headroom-under-lane-load` 已登记的宿主负载类别，不新增覆盖机制,关闭本任务（标记为 `superseded` 或等价的"调查完毕无需动代码"状态，附调查过程与读数）。 ——**已按此分支执行**：如实记录"时间关联存在、因果未坐实"，归因重指向 `gap-resident-server-restart-criterion-wait-headroom-under-lane-load`（done）已登记的同一 flake 兄弟形态 `swept=0`（判据 `:1083-1092` 逐字登记、`SWEEP_ATTEMPTS=3` 兜住）；本任务以 `superseded` 关闭，调查过程与读数见「调查记录」。
- [x] AC4 范围门：若 AC2 的方案被采纳并实现，`npm run typecheck`/`npm run lint` 退出 0；改动不降低任何现有全局并发/内存上限的数值；`resource-gate.sh`/`process-budget.sh` 若被改动，改动方需与 quay 侧协同（记录协同证据，不得单边改一个被多项目共享的脚本）。 ——**前件为假，不适用（vacuous satisfied）**；且本次零源码改动，typecheck/lint 无新增风险面，未改 `resource-gate.sh`/`process-budget.sh`（无需 quay 协同），未降低任何全局上限。

## DoD

真实落地标准：AC1 的因果曲线是本次会话或后续 worker 真实测得的数据（标明测量时的宿主负载作为对照变量），不是推断；若走 AC2 路线，新机制上线后要能在 `.quay/verification-round.jsonl` 的后续真实 fan-in 轮次里观察到 `resident-server-restart.test.ts` 红率下降（给出修复前后窗口的真实红/绿轮次比例对比，不是单轮）；若走 AC3，关闭理由要点名已有的归因任务，不留悬空的"疑似问题"状态。未验证项如实声明：本任务创建时尚未执行 AC1 的可控复现实验。

**DoD 兑现情况**：AC1 因果曲线为本会话真实测得（N=1/2/4 + 宿主 load 对照，见「调查记录」一节）；走 AC3 路线，关闭理由点名已有归因任务 `gap-resident-server-restart-criterion-wait-headroom-under-lane-load`（done）的 `swept=0` 兄弟形态登记；未验证项已在「调查记录」七节如实声明（未在 ≥1×nproc 重过载窗口复测）。

## Touches

- tasks/gap-claudecodeui-scoped-self-test-and-concurrent-worker-sessions-bypass-resource-gate.md (self)
