---
id: gap-vitest-worker-pool-adapts-to-effective-cpu
title: vitest.config.ts 的 CLIENT_MAX_WORKERS 从 availableParallelism() 改为读
  effective CPU（cgroup bandwidth quota 感知）
status: ready
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

**现状（已核实部分 + 待验证部分，不得混为一谈）**：`vitest.config.ts:18-21`：
```
const CLIENT_MAX_WORKERS = 8;
const maxWorkers = Math.min(CLIENT_MAX_WORKERS, Math.max(1, Math.floor(availableParallelism() / 2)));
```
**待验证**：`os.availableParallelism()` 是否读 cgroup v2 `cpu.max` 的 CFS bandwidth quota，本仓没有任何测试或记录验证过（Node 文档称该 API 可能考虑容器 CPU quota，但"文档说可能"不是"本仓验证过"——已与 quay 侧对等会话核实，对方也未验证过这一点，不能当结论用）。**本任务第一步必须是验证**，不能预设答案：
- 若验证后发现 `availableParallelism()` 在本仓实际运行环境（cgroup v2 bandwidth quota 限制）下确实正确反映 effective CPU——本任务范围缩小为"补一条验证测试，锁定这一行为，不替换实现"，不做无意义的重写。
- 若验证后发现不正确（例如只反映 cpuset/affinity，不反映 bandwidth quota）——按原计划替换为读 `scripts/effective-capacity.sh` 的 `effective_cpu`。

`DEFAULT_WORKER_HEAP_MB`（4352，per-worker V8 堆上限）保持不变，由 `gap-with-memory-cap-default-adapts-to-effective-memory` 任务处理内存相关的那一半。

**不做**：不改 `WORKER_HEAP_MB`/`QUAY_VITEST_HEAP_MB` 的既有语义；不改 `pool: 'forks'`/`poolOptions.forks.execArgv` 之外的 vitest 配置项；不弱化 `testTimeout`/`hookTimeout` 的既有数值（`AC-103` 相关任务钉死的，另一机制）。

## AC

- [ ] AC0（必须先做）验证 `availableParallelism()` 的 quota 感知性：在 `systemd-run -p CPUQuota=200%/400%/800%` 三档下，对照 `availableParallelism()` 的返回值与 `scripts/effective-capacity.sh` 的 `effective_cpu` 读数，逐档记录是否一致。一致则跳到 AC-verify-only；不一致则继续 AC1-5。
- [ ] AC-verify-only（若 AC0 证实一致）：新增一条断言测试锁定"`availableParallelism()` 在本仓运行环境下与 `effective_cpu` 一致"这一事实（可证伪：用 `EFFECTIVE_CAPACITY_TEST_*` 系列注入一个与真实环境不同的核数，断言测试能检测出不一致，证明断言不是恒真）；不修改 `maxWorkers` 公式本身；`npm run typecheck`/`npm run lint` 退出 0；直接视为本任务 DoD 达成，其余 AC1-5 不适用（在完成记录里写明为何不适用）。
- [ ] AC1（若 AC0 证实不一致）公式替换：`maxWorkers` 改为基于 `effective_cpu`；`QUAY_VITEST_HEAP_MB=off/0` 等既有覆盖语义不变。
- [ ] AC2（若 AC0 证实不一致）一致性验证：vitest.config.ts 内读 effective CPU 的实现（内联或 shell 出）与 `scripts/effective-capacity.sh` 的 `effective_cpu` 字段在同一环境下取值相同。
- [ ] AC3（若 AC0 证实不一致）实测验证：三档 + 本机档，各跑一次 `npm run test:client`（或等价子集），记录实际 worker 数、墙钟、是否出现 `STACK_TRACE_ERROR`/`Timeout calling "fetch"` 类超订征兆。
- [ ] AC4（若 AC0 证实不一致）false-forms/AC 不被削弱：`src/shared/asr/tests/asrContractInvariants.test.ts` 在新 worker 数下仍能跑通，不产生新的内存超限。
- [ ] AC5 范围受控：`npm run typecheck`/`npm run lint` 退出 0；`git diff` 只落在 `## Touches`。

## DoD

真实落地标准：AC0 的三档对照读数必须贴进完成记录，是本任务一切后续走向的依据——不得跳过 AC0 直接假定答案。若走 AC1-4 路线，三档+本机档的实测读数（worker 数、墙钟、有无超订征兆）贴进完成记录；落地后第一轮真实 `npm run test:client` 与历史基线（round 756-773 窗口的 `src/` 侧 perFile 耗时）比较无显著劣化。若走 AC-verify-only 路线，如实记录"换实现是不必要的"这一结论本身就是本任务的产出。未验证项如实声明：若无法构造真实不同规格物理机，注明用 cgroup 模拟。

## Touches

- vitest.config.ts
- tasks/gap-vitest-worker-pool-adapts-to-effective-cpu.md (new)