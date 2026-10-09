---
id: gap-effective-capacity-probe-cgroup-cpu-mem-quota
title: 新增独立探测脚本：读 cgroup v2 cpu.max/memory.max 算出 effective CPU/memory（不是
  nproc/affinity），不依赖 quay 安装位置，零行为改动
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

**背景（用户裁定，2026-10-09）**：低算力环境（2/4/8 核、cgroup 内存受限）下的测试稳定性优先于跨项目共享锁；`scripts/test.sh` 的 `--test-concurrency=16`、`vitest.config.ts` 的 `CLIENT_MAX_WORKERS=8`、`scripts/with-memory-cap.sh` 的 `QUAY_MEMORY_MAX=24G` 三处硬编码必须能按**实际 effective CPU/memory**自适应，且该适配**不得强依赖跨项目协调**（quay 的 `resource-gate.sh` 不在场时，ClaudeCodeUI 自己的测试稳定性不能受影响）。

**已核实的现状缺口**：
- `scripts/test.sh:67` `CONCURRENCY_CEILING="${QUAY_TEST_CONCURRENCY_CEILING:-16}"` —— 16 是 `scripts/server-phase-concurrency-check.sh` 的 SLOPE_TABLE 在**本机 128 核**上实测出的值，SLOPE_TABLE 本身按"坡度表支撑"fail-closed（无实测依据的阈值直接判红）——但它从未在 cgroup CPU bandwidth quota 受限的环境下重新测过。
- `vitest.config.ts:20-21` `maxWorkers = min(8, floor(availableParallelism()/2))` —— `os.availableParallelism()` 是否读 cgroup v2 `cpu.max` 的 CFS bandwidth quota **尚未在本仓验证**（Node 文档声称该 API 可能考虑容器 CPU quota，但本仓没有任何测试或记录证实过这一点对本仓运行环境成立——按"如实记录，不假定"处理，消费任务需要先验证这一点，若已经对，则该任务范围可能缩小为"补一条验证测试"而非"换实现"）。
- `scripts/with-memory-cap.sh:30` `CAP="${QUAY_MEMORY_MAX:-24G}"` —— 固定 24G，不读 cgroup `memory.max` 或 `free -m` 的真实可用量。
- quay 自己的 `resource-gate.sh`/`process-budget.sh` 里的 `nproc`/`nproc --all` 读的是**反方向的量**（host-wide 核数，用于拿 host-wide loadavg 去比；`gap-systemd-run-cpuquota-scope-distorts-nproc` 的设计笔记明确说明为什么故意不用 cgroup-scoped nproc）。**已与 quay 侧一个对等会话（"Quay 测试墙钟耗时"）核实确认**：quay 目前同样没有"cgroup bandwidth quota → effective CPU/mem"这条探测（不是我们没找到），对方正在独立立两个切片处理他们自己的内存侧缺口（`driver-anchor.ts` 的 `os.totalmem()×0.25` 包络同样不读 `memory.max`）。

**接口对齐（已与 quay 侧达成一致，2026-10-09 跨会话协同）**：

report 模式（key=value，一行一个）：
```
effective_cpu=<int>           # min(cpu.max bandwidth quota 算出的核数, cpuset.cpus.effective 核数, nproc)
cpu_source=cgroup-cpu-max|cpuset|nproc-fallback
effective_mem_mb=<int>
mem_source=cgroup-memory-max|free-fallback
nproc=<int>                   # 对照读数，host/affinity 核数，不是最终值
cgroup_v2=true|false
```
`--json` 模式输出同一组字段的 JSON 对象，键名不变。

测试缝（采纳 quay 侧 `RESOURCE_GATE_TEST_*` 的显式 env override 风格，避免必须真的构造 cgroup 才能测试 fail-open 路径）：
```
EFFECTIVE_CAPACITY_TEST_CPU_MAX=<quota> <period>|max
EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT=<int>
EFFECTIVE_CAPACITY_TEST_MEMORY_MAX=<bytes>|max
EFFECTIVE_CAPACITY_TEST_NPROC=<int>
EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB=<int>
```

**本任务只做探测，不改任何现有行为**（消费方是后续任务，分别是 `gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu`、`gap-vitest-worker-pool-adapts-to-effective-cpu`、`gap-with-memory-cap-default-adapts-to-effective-memory`，均 `depends_on` 本任务）：

新增 `scripts/effective-capacity.sh`：
- **CPU**：读 `/sys/fs/cgroup/cpu.max`。`quota`≠`max` 时 `= floor(quota/period)`（向下取整，至少 1）；`quota=max` 或文件不存在时 fail-open 退回 `nproc`。同时读 `cpuset.cpus.effective`（存在时取其基数），与 bandwidth quota 取**较小值**。
- **Memory**：读 `/sys/fs/cgroup/memory.max` 与 `free -m` 可用量，取较小值；无 cgroup v2 时 fail-open 退回 `free -m`。
- 上述 `EFFECTIVE_CAPACITY_TEST_*` 环境变量可覆盖对应的原始读数源，用于确定性测试。
- 不依赖 quay（不引用 `QUAY_PLUGIN_ROOT`/`plugins/cache/quay`）。
- 零行为改动：不修改 `scripts/test.sh`、`vitest.config.ts`、`scripts/with-memory-cap.sh`、`package.json`。

**协同记录**：已与 quay 侧对等会话（session "Quay 测试墙钟耗时"）两轮往返确认字段名与测试缝风格；quay 侧确认"不应该变成强依赖"是双向的（他们自己也要求无 ClaudeCodeUI/任何第二项目时独立工作，写进其任务体的硬性 AC）；双方各自独立实现，落地后用真实输出互相核对一次，不互相阻塞节奏。

## AC

- [ ] AC1 真实 cgroup v2 环境下的读数：用 `systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=2G` 包起来跑 `scripts/effective-capacity.sh`，输出 `effective_cpu=2`（±向下取整容差）、`effective_mem_mb` 接近 2048、`cgroup_v2=true`；对 `CPUQuota=400%`/`800%` 各重复一次，三组读数贴进完成记录。
- [ ] AC2 测试缝验证 fail-open（用 `EFFECTIVE_CAPACITY_TEST_*` 系列注入，不依赖真实缺失 cgroup v2 的环境）：注入 `EFFECTIVE_CAPACITY_TEST_CPU_MAX=max`，验证 `cpu_source=nproc-fallback` 且 `effective_cpu` 等于注入的 `EFFECTIVE_CAPACITY_TEST_NPROC`；注入 `EFFECTIVE_CAPACITY_TEST_MEMORY_MAX=max`，验证 `mem_source=free-fallback`。退出码均为 0（fail-open，不是 fail-closed）。
- [ ] AC3 `--json` 与 report 模式字段一致：两种模式下 `effective_cpu`/`effective_mem_mb`/`nproc`/`cgroup_v2` 取值相同。
- [ ] AC4 不依赖 quay：`grep -c "QUAY_PLUGIN_ROOT\|plugins/cache/quay" scripts/effective-capacity.sh` 为 `0`。
- [ ] AC5 范围受控且不新增 `scripts/*.mjs`：测试文件用 `.test.sh` 或确认能被 `node scripts/list-script-tests.mjs` 正常收集的等价形式；`npm run typecheck`、`npm run lint` 退出 0。
- [ ] AC6 `git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`；不新增 `scripts/test.sh`/`vitest.config.ts`/`scripts/with-memory-cap.sh`/`package.json` 的改动。

## DoD

真实落地标准：AC1 的三档 CPUQuota 实测读数是本机真实测得；AC2 的测试缝注入读数逐字贴出；脚本落地后 `npm test` 全链路跑一次，读数与改动前一致，证明是纯增量。未验证项：quay 侧字段是否与本任务逐字一致，需等双方都落地后再核对一次（已在协同记录里写明，不阻塞本任务落地）。

## Touches

- scripts/effective-capacity.sh (new)
- scripts/effective-capacity.test.sh (new，或等价的 node:test 文件，命名以实现时确认的收集方式为准)
- tasks/gap-effective-capacity-probe-cgroup-cpu-mem-quota.md (new)