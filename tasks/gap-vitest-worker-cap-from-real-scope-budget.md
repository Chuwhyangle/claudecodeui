---
id: gap-vitest-worker-cap-from-real-scope-budget
title: vitest worker 宽度只看核数、允许 34.8GiB 堆而套件 cap 只有 16GiB：改为按真实 scope
  预算（effective CPU ∩ 自身 memory.max）推导，并用 4/6/8 × ≥3 整轮实测选值
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-effective-capacity-scope-own-budget-and-actual-concurrency-display
---
## Proposal

**本轮只读诊断实测（2026-10-14）：** `vitest.config.ts:21-24` 的 worker 宽度是

```ts
const CLIENT_MAX_WORKERS = 8;
const maxWorkers = Math.min(CLIENT_MAX_WORKERS, Math.max(1, Math.floor(availableParallelism() / 2)));
```

**只看核数**；而每个 worker 允许 `--max-old-space-size=4352`（`:131`）。于是配置允许的 JS 堆是
**8 × 4352 MB = 34.8 GiB**，而套件 scope 的 `memory.max` 只有 **16 GiB**（实测
`.quay/suite-cgroup-evidence.txt`：`limits_applied=1 memoryMax=16G`）—— **配置允许的堆比 cgroup cap 大 2.2 倍**。

⚠️ **堆上限不是预分配。** 34.8 GiB 是**理论上限**（V8 允许长到这么多，不是它一定会用），**不得当实测峰值**。
实测单文件堆峰 1401 MB（`vitest.config.ts:38-40` 记录），8 × 1.4 ≈ 11 GB，对应观测到的
12–13 GiB 套件 `memory.peak`（149 次记录 p50 10.81 / p90 12.71）。**实测峰值一律以 cgroup `memory.peak` 为准。**

**本任务做两件事：**

1. **把 worker 宽度改成由「真实 scope 预算」推导**，且**可覆盖**。预算 = 三个量的交集的**最小值**：
   - cgroup 有效 CPU（`cpu.max` / `CPUQuotaPerSecUSec` / cpuset，来自
     `gap-effective-capacity-scope-own-budget-and-actual-concurrency-display` 的读数）；
   - 祖先约束；
   - **自身所在 scope 的 `memory.max`**。
   ⛔ sibling suite（16GiB）里必须拿到 `16384`，**不能拿外层 8GiB 会话 cap 当预算**。
   ⛔ **保底 4 workers 不得突破真实预算** —— 若真实预算算下来低于 4，就必须低于 4，不许为了"保底"越界。

2. **用同一 commit + 同一完整测试集，做 4 / 6 / 8 三档 × ≥3 整轮的实测比较**，用读数而不是理论值选值。

**⛔ 预算不扩大：** suite 16GiB、server 并发 16、anchor 26GiB **一个数都不改**。
**⛔ 覆盖不减：** 不许靠减少测试来掩盖资源压力。

<!-- dedup-ref -->
复用关系（均 `done`，不要重复实现）：`gap-vitest-worker-heap-limit`（建了 4352 堆上限）、`gap-vitest-worker-pool-adapts-to-effective-cpu`（把它从 `availableParallelism()` 改成读 effective CPU —— 本任务改的是**内存侧**，那是它没做的一半）、`gap-effective-capacity-probe-cgroup-cpu-mem-quota`。本任务 `depends_on` 上面的 scope-own-budget 任务，因为"自身 scope 的 memory.max"那个读数是它交付的。

## AC

- [x] AC1：worker 宽度由「真实 scope 预算」推导 —— 取 **effective CPU** 与**自身 scope `memory.max`** 的交集，不再是 `min(8, floor(cores/2))` 的纯核数式；推导函数有独立单元测试，覆盖四档：16GiB scope、8GiB scope、无 cgroup、`cpuset=2`。
- [x] AC2：推导结果**可覆盖**（环境变量或既有 seam），且**覆盖值仍受真实预算夹取** —— 判据：给一个超过预算的覆盖值，实际宽度仍被夹回预算内，不越界。
- [x] AC3：**同一 commit + 同一完整测试集**下，4 / 6 / 8 workers 各 **≥3 整轮**（≥9 轮）。逐轮记录：commit 哈希、测试文件集标识、wall、CPU（user+sys）、cgroup `memory.peak`、anon/file（`memory.stat`）、swap、PSI（`memory.pressure` some/full avg300）、完整度（`# tests` / `# pass` / `# fail` / 文件数）。**全表入 Evidence**，缺任一列即不算。
- [x] AC4：由 AC3 的读数给出选值依据，选值在 16GiB scope 内留有**可量化**余量 —— 写出算式，余量 ≥ 实测 peak 的 1.3×。
- [x] AC5：**预算不变**：`git diff` 不修改 suite 16GiB、`CEILING_CAP=16`、anchor 26GiB 相关的任何数值。
- [x] AC6：**覆盖不减**：改动前后一次全量 `scripts/test.sh` 的 `# tests` 计数与收集文件数**相同**（逐字记录两个数）。不许靠跳过/删除/标记 skip 来降低资源压力。
- [x] AC7：**非预分配性质写进配置注释**：明写 34.8 GiB 是理论上限而非实测峰值，实测以 `memory.peak` 为准；并写明"保底宽度不得突破真实预算"这条不变式。

## Evidence

**测量 commit（AC3 全部 9 轮 + 下面那次全量套件）：`fad6cc9134b608a352094942de0978ecbb01d084`** ——
本分支 HEAD，实现本身在 `bc5be0804`（推导）+ `cfe5e7b22`（`.mjs` 化）+ `fad6cc913`（注释里的文件名）。
其后唯一要做的 `merge develop` 只带进一个 commit `898257e9b`（对**无关任务**文件
`tasks/gap-ac345-pending-card-absent-hold-not-engaged.md` 的 task_write），因此 `## Touches` 里
的每个文件测量后都不再变化。**改动代码：**

```
vitest.config.ts
- const CLIENT_MAX_WORKERS = 8;
- const maxWorkers = Math.min(CLIENT_MAX_WORKERS, Math.max(1, Math.floor(availableParallelism() / 2)));
+ import { resolveWorkerWidth } from './scripts/vitest-worker-budget.mjs';
+ const maxWorkers = resolveWorkerWidth();
```

### AC1 —— 宽度来自真实 scope 预算（effective CPU ∩ 自身 `memory.max`）

新模块 `scripts/vitest-worker-budget.mjs`：

```js
deriveWorkerWidth(budget) = Math.max(1, Math.min(CLIENT_MAX_WORKERS, cpuWorkers, memWorkers))
  cpuWorkers = Math.max(1, Math.floor(effectiveCpu))                  // 无读数 -> CLIENT_MAX_WORKERS
  memWorkers = Math.max(1, Math.floor(scopeMemMaxMb / 2048))          // Infinity -> CLIENT_MAX_WORKERS
```

`readScopeBudget()` 用 `bash scripts/effective-capacity.sh --json` 读 `effective_cpu`（含祖先链）与
**自身 scope** 的 `scope_mem_max_mb`；探测失败则 fail-open（本机并行度 + 无内存上限），配置永远能加载。
**没有任何"保底 4"** —— 返回式就是 `min(budget, …)`，下界只有 1。

**独立单元测试 `scripts/vitest-worker-budget.test.mjs`：16/16 pass**（`node --test`）。四档：

| # | 形态 | 输入 | 期望 | 实测 |
|---|---|---|---|---|
| 1 | 16 GiB scope | `{effectiveCpu:128, scopeMemMaxMb:16384}` | 8 | 8 |
| 2 | 8 GiB scope | `{effectiveCpu:128, scopeMemMaxMb:8192}` | 4 | 4 |
| 3 | 无 cgroup | `{effectiveCpu:128, scopeMemMaxMb:Infinity}` | 8 | 8 |
| 4 | `cpuset=2` | `{effectiveCpu:2, scopeMemMaxMb:16384}` | 2 | 2 |

另含交集两向（CPU 侧绑定 / 内存侧绑定）与**低于保底**（3 GiB→1、1 GiB→1）；四档另有一组经
`EFFECTIVE_CAPACITY_TEST_*` seam 走**真实探针**的同形断言（不是第二份手写解析）。

**真实 cgroup 读数**（`systemd-run --user --scope -p MemoryMax=…`，落成 `app.slice` 下的 sibling，
所以进程读到的就是**它自己的** limit）：

```
$ systemd-run --user --scope -p MemoryMax=8G -- bash -c 'node scripts/vitest-worker-budget.mjs --json'
{"workers":4,"budget_derived_workers":4,"effective_cpu":128,"scope_mem_max_mb":8192,
 "per_worker_budget_mb":2048,"client_max_workers":8,"source":"cgroup","override":null}

$ systemd-run --user --scope -p MemoryMax=16G -- bash -c 'node scripts/vitest-worker-budget.mjs --json'
{"workers":8,"budget_derived_workers":8,"effective_cpu":128,"scope_mem_max_mb":16384,
 "per_worker_budget_mb":2048,"client_max_workers":8,"source":"cgroup","override":null}
```

8G 那次嵌在 26 GiB 会话 scope 内，却按 `8192` 预算 —— 即"**拿自身 scope 的 memory.max，不拿外层 cap**"
（⛔ sibling suite 拿 16384 的那条同理）。无 scope 时（本会话 self scope `scope_mem_max_mb=26624`）
`workers 8 source cgroup`；用裸 node `await import('…/vitest.config.ts')` 取值 ⇒ `maxWorkers 8`。

### AC2 —— 可覆盖，且覆盖值仍被真实预算夹取

覆盖变量 `QUAY_VITEST_MAX_WORKERS`，解析为 `Math.min(Math.floor(override), derived)`。
**在一个真实 16 GiB scope 内实测：**

```
MemoryMax=16G, QUAY_VITEST_MAX_WORKERS=100  ->  workers: 8   （夹回预算，不是 100）
MemoryMax=16G, QUAY_VITEST_MAX_WORKERS=3    ->  workers: 3   （低于预算的覆盖被尊重）
```

不可用的覆盖值（`nope` / `0` / `-3`）告警后退回推导值（单测覆盖）；CLI `--json` 与裸行两种输出都有单测。

### AC3 —— 4/6/8 × 3 整轮实测表（全表）

- **commit（逐轮，同一）**：`fad6cc9134b608a352094942de0978ecbb01d084`
- **测试集标识（逐轮，同一）**：`client-vitest-full` = 完整 client vitest 套件
  `npx vitest run`（`include: src/**/*.test.ts(x)`），**209 个文件 / 1516 个用例**
- 每轮都是一次独立的 `systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0`（具名 unit），
  串行（并发 scope 会互相争抢，读数就描述宿主机而不是宽度）；宽度走**生产配置路径**（`QUAY_VITEST_MAX_WORKERS`
  → `vitest.config.ts` → `resolveWorkerWidth()`），每轮 `budget_derived_workers=8 source=cgroup`。
- `memory.peak` 是内核水位线；anon/file/swap/current 是 0.5 s 采样取的**峰值时刻**读数（不是 vitest 退出后的残值）。

| tag | commit | testset | W | wall_s | rc | cpu_user_s | cpu_sys_s | cpu_tot_s | peak_GiB | peak_MB | sampled_cur_MB | anon_MB | file_MB | swap_cur_MB | swap_peak_MB | psi_some300 | psi_full300 | #tests | #pass | #fail | files |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r1-w4 | fad6cc913 | client-vitest-full | 4 | 60.188 | 0 | 243.0 | 33.6 | 276.7 | 2.47 | 2529 | 2403 | 2314 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |
| r1-w6 | fad6cc913 | client-vitest-full | 6 | 45.914 | 0 | 271.2 | 36.1 | 307.3 | 3.24 | 3323 | 3320 | 3199 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |
| r1-w8 | fad6cc913 | client-vitest-full | 8 | 44.370 | 0 | 306.5 | 39.4 | 345.9 | 3.69 | 3780 | 3647 | 3518 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |
| r2-w4 | fad6cc913 | client-vitest-full | 4 | 60.593 | 0 | 241.7 | 32.7 | 274.4 | 2.61 | 2671 | 2635 | 2539 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |
| r2-w6 | fad6cc913 | client-vitest-full | 6 | 41.100 | 0 | 244.9 | 33.2 | 278.2 | 3.24 | 3317 | 2972 | 2859 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |
| r2-w8 | fad6cc913 | client-vitest-full | 8 | 35.488 | 0 | 242.6 | 33.0 | 275.6 | 3.75 | 3841 | 3472 | 3343 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |
| r3-w4 | fad6cc913 | client-vitest-full | 4 | 59.601 | 0 | 241.1 | 33.0 | 274.1 | 2.49 | 2546 | 2446 | 2355 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |
| r3-w6 | fad6cc913 | client-vitest-full | 6 | 40.591 | 0 | 240.2 | 32.0 | 272.2 | 3.23 | 3306 | 3035 | 2924 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |
| r3-w8 | fad6cc913 | client-vitest-full | 8 | 35.976 | 0 | 244.8 | 33.8 | 278.6 | 3.75 | 3840 | 3641 | 3506 | 23 | 0 | 0 | 0 | 0 | 1516 | 1515 | 0 | 209 |

列义：`peak_*` = cgroup `memory.peak`（GiB 与 MB 两种单位，同一读数）；`sampled_cur` = `memory.current`
峰值；`anon`/`file` = `memory.stat` 对应字段峰值；`swap_cur`/`swap_peak` = `memory.swap.current` 峰值 /
`memory.swap.peak`；`psi_*300` = `memory.pressure` some/full 的 `avg300` 峰值；`#tests/#pass/#fail/files`
= vitest JSON reporter 的 `numTotalTests` / `numPassedTests` / `numFailedTests` / `testResults.length`。

**9/9 轮 rc=0，swap 全 0，PSI some/full avg300 全 0，每轮 1516 / 1515 / 0 / 209 逐轮相同** —— 即三档宽度
在完整度上没有任何差别，差异只在 wall 与峰值上。（`#tests` 1516 与 `#pass` 1515 差 1 是套件自带的一例
`todo`/`skip` 计数口径，三档一致，与本任务无关。）

### AC4 —— 选值与可量化余量

**选值 = 8 workers**，也正是预算在 16 GiB scope 内自己推出的宽度：
`min(CLIENT_MAX_WORKERS=8, floor(effectiveCpu=128), floor(16384/2048)=8) = 8` —— **池子恰好按预算定尺寸，不再多要**。

算式（全部用实测 `memory.peak`，不用理论堆上限）：

- 全量套件（DoD 那次）`memory.peak = 7294578688 B = 6956.6 MiB`；
  `16384 MiB ÷ 6956.6 MiB = 2.355×` ≥ 1.3 ✓
- client 相位最坏一轮（AC3 里最高的 r2-w8）`3841 MB`；
  `16384 MB ÷ 3841 MB = 4.265×` ≥ 1.3 ✓
- 对照理论值：`8 × 4352 MB = 34.8 GiB` 是 V8 **允许**的上限，不是预分配（AC7 注释）；
  若拿它当峰值，16 GiB 会"不够" 2.2 倍 —— 而实测峰值只有它的 1/5 量级。**这就是不能用理论值选宽度的理由。**

选 8 而不是 6 或 4 的读数依据（AC3 表）：三档全绿，但 wall 中位数
w4 60.188s / w6 41.100s / w8 35.976s —— 8 最快；峰值随宽度**次线性**上升
（w4 ≈2.47–2.61 GiB，w6 ≈3.23–3.24 GiB，w8 ≈3.69–3.75 GiB），且最坏一轮仍留 4.27× 余量，
所以在 16 GiB 预算内 8 是可用宽度里最快的一档。

### AC5 —— 预算一个数都没改

`git diff --name-status develop..HEAD`（代码 + 配置侧）：

```
A  scripts/vitest-worker-budget.mjs
A  scripts/vitest-worker-budget.test.mjs
M  scripts/vitest-worker-pool-effective-cpu-check.test.mjs
M  vitest.config.ts
M  tasks/gap-ac345-pending-card-absent-hold-not-engaged.md   <- develop 侧 commit，merge 时消失
```

`scripts/test.sh`、`scripts/with-memory-cap.sh`、`scripts/effective-capacity.sh`、`scripts/full-suite-runner.js`
**均未被本分支改动**；`CEILING_CAP=16`（`scripts/test.sh:84`）两侧逐字相同。对整份 diff 扫预算字面量：

```
$ git diff develop..HEAD -- vitest.config.ts scripts | grep -nE '^[+-].*(CEILING_CAP|MemoryMax|SUITE_MEMORY|26624|"16G"|\b26G\b|16384)'
33:+//     an 8 GiB session cap must budget from 16384, never from the outer 8192.
```

**唯一命中是一条注释**（模块 header 复述需求本身），不是任何被改的数值。driver 自己的
`SUITE_MEMORY_MAX_CEILING = "16G"` 在仓库外的 bundle（`…/scripts/dist/fan-in-ac-completion-gate.js`），未触碰。

### AC6 —— 覆盖不减

同一 `scripts/test.sh`，**改动前**（在 `develop`=`898257e9b` 上检出的临时 worktree）与**改动后**
（本分支）各一次，各自在独立 `MemoryMax=16G` 具名 scope 内串行跑：

| 读数 | BEFORE（develop） | AFTER（本分支） |
|---|---|---|
| scope `memory.max` | 17179869184 | 17179869184 |
| scope `memory.peak` | 7555407872 B (7.04 GiB) | 7294578688 B (6.79 GiB) |
| `memory.swap.peak` | 0 | 0 |
| `memory.events` | low/high/max/oom/oom_kill = 0 | 全 0 |
| suite rc | 0 | 0 |
| `__PERFILE__` 行数 | 542 | 542 |
| `server.test.*` 文件数 | 330 | 330 |
| **`# tests`** | **542** | **542** |
| `# pass` / `# fail` / `# cancelled` | 542 / 0 / 0 | 542 / 0 / 0 |
| wall_s | 411.517 | 416.586 |

⇒ **`# tests` 542 == 542，收集文件数 542 == 542（逐字）**；`src/`、`server/` 无 diff，无任何 skip/删除/标记 skip。
（本任务的 `scripts/**/*.test.mjs` 不入 `scripts/test.sh` 的收集面 —— 它没有 scripts lane，
`SERVER_FILES = find server …`、`CLIENT_FILES = ["__all__"]` —— 所以这两个数不受新测试文件影响。）

### AC7 —— 非预分配与不变式写进配置注释

`vitest.config.ts:22-29`：

```
// ⛔ The heap ceiling is NOT a reservation. 8 × 4352 MB = 34.8 GiB is what V8 is *allowed* to grow to
// per worker — a theoretical upper bound, never a measured peak. The measured peak of a run is that
// run's cgroup `memory.peak`, and the budget is sized against THAT (see the module header). Do not
// re-derive the width from 34.8.
//
// ⛔ Invariant (enforced in scripts/vitest-worker-budget.mjs, not restated as a loose knob here): a
// "minimum width" may never push the pool past the budget. If the budget works out below any floor,
// the width goes below the floor too — the only lower bound is 1.
```

同一段话在模块 header（`scripts/vitest-worker-budget.mjs:1-41`）里更完整地写了一遍（含"4352 MB 是
ceiling 不是 reservation"、"34.8 GiB 是理论值、实测只见 `memory.peak`"、"没有 4 的保底"）。

### 测量口径说明（避免把构造读数当落地读数）

- AC3 的"完整测试集"取**完整 client vitest 套件**（209 文件 / 1516 用例），因为它正是
  `vitest.config.ts` 的 `maxWorkers` 所作用的那一支；把全量 `scripts/test.sh` 跑 9 遍代价过大，
  该端到端形态由 DoD 那一次全量覆盖。此口径在 AC3 表里以 `testset=client-vitest-full` 明写。
- AC6 的"改动前后"取**全量 `scripts/test.sh`**（`# tests` 542），因为它才是"覆盖"的载体。
- 两处都是**真实运行**（真实 vitest / 真实 `scripts/test.sh`、真实 cgroup scope），不是构造探针；
  理论值 34.8 GiB 只在 AC4 里作为**反例**出现，选值依据全部是实测 `memory.peak`。

## DoD

真实落地：一次**真实 fan-in 全量套件**按新推导的 worker 宽度跑完并**绿**，该轮的 `memory.peak` 与 `# tests` 都被记录；且 Evidence 里 AC3 的 ≥9 轮读数表齐全（4/6/8 各 ≥3，列全）。只跑构造探针、或用理论总量代替实测峰值，都不算落地。

**本轮的落地读数（真实 `scripts/test.sh`，16 GiB 具名 scope，新宽度经生产配置路径解析为 8）：`suite_rc=0`、
`memory.peak=7294578688`（B）、`# tests 542` / `# pass 542` / `# fail 0`、`memory.swap.peak=0`、
`memory.events` 全 0。** 该 run 与 AC3 的 9 轮表都在 commit `fad6cc9134b608a352094942de0978ecbb01d084` 上。
（真正的 fan-in 全量套件由 worker-driver 在合入时再跑一次，是本 DO 的最终判据；此处先给出同口径的实测读数。）

## Touches

- vitest.config.ts
- scripts/vitest-worker-budget.mjs
- scripts/vitest-worker-budget.test.mjs
- scripts/vitest-worker-pool-effective-cpu-check.test.mjs
- tasks/gap-vitest-worker-cap-from-real-scope-budget.md
