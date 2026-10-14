---
id: gap-vitest-worker-cap-from-real-scope-budget
title: vitest worker 宽度只看核数、允许 34.8GiB 堆而套件 cap 只有 16GiB：改为按真实 scope
  预算（effective CPU ∩ 自身 memory.max）推导，并用 4/6/8 × ≥3 整轮实测选值
status: todo
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

- [ ] AC1：worker 宽度由「真实 scope 预算」推导 —— 取 **effective CPU** 与**自身 scope `memory.max`** 的交集，不再是 `min(8, floor(cores/2))` 的纯核数式；推导函数有独立单元测试，覆盖四档：16GiB scope、8GiB scope、无 cgroup、`cpuset=2`。
- [ ] AC2：推导结果**可覆盖**（环境变量或既有 seam），且**覆盖值仍受真实预算夹取** —— 判据：给一个超过预算的覆盖值，实际宽度仍被夹回预算内，不越界。
- [ ] AC3：**同一 commit + 同一完整测试集**下，4 / 6 / 8 workers 各 **≥3 整轮**（≥9 轮）。逐轮记录：commit 哈希、测试文件集标识、wall、CPU（user+sys）、cgroup `memory.peak`、anon/file（`memory.stat`）、swap、PSI（`memory.pressure` some/full avg300）、完整度（`# tests` / `# pass` / `# fail` / 文件数）。**全表入 Evidence**，缺任一列即不算。
- [ ] AC4：由 AC3 的读数给出选值依据，选值在 16GiB scope 内留有**可量化**余量 —— 写出算式，余量 ≥ 实测 peak 的 1.3×。
- [ ] AC5：**预算不变**：`git diff` 不修改 suite 16GiB、`CEILING_CAP=16`、anchor 26GiB 相关的任何数值。
- [ ] AC6：**覆盖不减**：改动前后一次全量 `scripts/test.sh` 的 `# tests` 计数与收集文件数**相同**（逐字记录两个数）。不许靠跳过/删除/标记 skip 来降低资源压力。
- [ ] AC7：**非预分配性质写进配置注释**：明写 34.8 GiB 是理论上限而非实测峰值，实测以 `memory.peak` 为准；并写明"保底宽度不得突破真实预算"这条不变式。

## DoD

真实落地：一次**真实 fan-in 全量套件**按新推导的 worker 宽度跑完并**绿**，该轮的 `memory.peak` 与 `# tests` 都被记录；且 Evidence 里 AC3 的 ≥9 轮读数表齐全（4/6/8 各 ≥3，列全）。只跑构造探针、或用理论总量代替实测峰值，都不算落地。

## Touches

- vitest.config.ts
- scripts/vitest-worker-budget.ts
- scripts/vitest-worker-budget.test.mjs
- tasks/gap-vitest-worker-cap-from-real-scope-budget.md
