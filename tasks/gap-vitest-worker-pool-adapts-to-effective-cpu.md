---
id: gap-vitest-worker-pool-adapts-to-effective-cpu
title: vitest.config.ts 的 CLIENT_MAX_WORKERS 从 availableParallelism() 改为读
  effective CPU（cgroup bandwidth quota 感知）
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-effective-capacity-probe-cgroup-cpu-mem-quota
---
## Proposal

**依赖**：`gap-effective-capacity-probe-cgroup-cpu-mem-quota`。

**现状**：`vitest.config.ts:18-21`：
```
const CLIENT_MAX_WORKERS = 8;
const maxWorkers = Math.min(CLIENT_MAX_WORKERS, Math.max(1, Math.floor(availableParallelism() / 2)));
```
`os.availableParallelism()` 不读 cgroup v2 `cpu.max` bandwidth quota（只读 affinity/cpuset）。在 bandwidth-限制的环境（quota 存在但 cpuset 未限制）下，这个公式会算出偏高的 `maxWorkers`，与该文件自己的既有注释（2026-09-25 事故：多个 quay 项目的 128-way 池子叠加超订）同一机制家族，只是触发条件从"多项目叠加"换成"单项目在小 cgroup 里也会超订"。

**本任务要做的**：把 `availableParallelism()` 替换为读 `scripts/effective-capacity.sh` 的 `effective_cpu`（vitest.config.ts 是同步执行的配置文件，不适合每次都 spawn 子进程——评估是否需要一个轻量的、同步读 `/sys/fs/cgroup/cpu.max` 的 Node 实现并与 `effective-capacity.sh` 共享同一套常量/算法，而不是重复一份不同步的逻辑；若选择内联实现，必须在该文件的注释里点名与 `effective-capacity.sh` 的对应关系，并补一条两者读数一致性的测试）。`DEFAULT_WORKER_HEAP_MB`（4352，per-worker V8 堆上限）保持不变，由 `gap-with-memory-cap-default-adapts-to-effective-memory` 任务处理内存相关的那一半。

**不做**：不改 `WORKER_HEAP_MB`/`QUAY_VITEST_HEAP_MB` 的既有语义；不改 `pool: 'forks'`/`poolOptions.forks.execArgv` 之外的 vitest 配置项；不弱化 `testTimeout`/`hookTimeout` 的既有数值（那是 `AC-103` 相关任务钉死的，另一机制）。

## AC

- [ ] AC1 公式替换：`maxWorkers` 的计算改为基于 effective CPU（而非 `availableParallelism()` 直接除2）；`QUAY_VITEST_HEAP_MB=off/0` 等既有覆盖语义不变。
- [ ] AC2 一致性验证：vitest.config.ts 内读 effective CPU 的实现（内联或 shell 出）与 `scripts/effective-capacity.sh` 的 `effective_cpu` 字段在同一环境下取值相同（新增测试断言两者一致，而不是各自为政）。
- [ ] AC3 实测验证（沿用该文件已有的方法论——文件头注释本身要求"再derive it after a suite change by reading the same measurement back"）：在 `CPUQuota=200%/400%/800%` 三档 + 本机档，各跑一次 `npm run test:client`（或等价子集），记录实际 worker 数、墙钟、是否出现 `STACK_TRACE_ERROR`/`Timeout calling "fetch"` 类超订征兆，确认新公式在低核数档不过订阅。
- [ ] AC4 false-forms/AC 不被削弱：`src/shared/asr/tests/asrContractInvariants.test.ts`（该文件自己的注释点名的最重文件）在新 worker 数下仍能跑通，不产生新的内存超限。
- [ ] AC5 范围受控：`npm run typecheck`/`npm run lint` 退出 0；`git diff` 只落在 `## Touches`。

## DoD

真实落地标准：三档+本机档的实测读数（worker 数、墙钟、有无超订征兆）贴进完成记录；落地后第一轮真实 `npm run test:client`（通过 fan-in 的 client 阶段）与历史基线（round 756-773 窗口的 `src/` 侧 perFile 耗时）比较无显著劣化。未验证项如实声明同上一个任务（若无法构造真实不同规格物理机，注明用 cgroup 模拟）。

## Touches

- vitest.config.ts
- tasks/gap-vitest-worker-pool-adapts-to-effective-cpu.md (new)