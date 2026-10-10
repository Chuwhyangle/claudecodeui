---
id: gap-vitest-worker-pool-adapts-to-effective-cpu
title: vitest.config.ts 的 CLIENT_MAX_WORKERS 从 availableParallelism() 改为读
  effective CPU（cgroup bandwidth quota 感知）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-effective-capacity-probe-cgroup-cpu-mem-quota
---
## Proposal

**依赖**：`gap-effective-capacity-probe-cgroup-cpu-mem-quota`（已实现，worktree `task/gap-effective-capacity-probe-cgroup-cpu-mem-quota`，commit `34e8a369`，尚未经机械 fan-in 落地到 develop——本任务的 worktree 直接从该分支切出，带着探测脚本，不等它先落地）。

**现状（已核实部分 + 待验证部分，不得混为一谈）**：`vitest.config.ts:18-21`：
```
const CLIENT_MAX_WORKERS = 8;
const maxWorkers = Math.min(CLIENT_MAX_WORKERS, Math.max(1, Math.floor(availableParallelism() / 2)));
```

**AC0 结论（已验证，见 Evidence）**：`os.availableParallelism()` 在本仓运行环境（Node v24.21.0）下**确实**正确反映 cgroup v2 CPU bandwidth quota。走的是 **AC-verify-only** 分支：不替换公式，只补一条可证伪的锁定测试。

`DEFAULT_WORKER_HEAP_MB`（4352，per-worker V8 堆上限）保持不变，由 `gap-with-memory-cap-default-adapts-to-effective-memory` 任务处理内存相关的那一半。

**不做**：不改 `WORKER_HEAP_MB`/`QUAY_VITEST_HEAP_MB` 的既有语义；不改 `pool: 'forks'`/`poolOptions.forks.execArgv` 之外的 vitest 配置项；不弱化 `testTimeout`/`hookTimeout` 的既有数值；不修改 `vitest.config.ts` 本身（AC0 证实其公式已经正确）。

## AC

- [x] AC0 验证 `availableParallelism()` 的 quota 感知性：三档 `systemd-run -p CPUQuota=200%/400%/800%` 下，`availableParallelism()` 读数与 `scripts/effective-capacity.sh` 的 `effective_cpu` 读数一致，均为 2/4/8。见 Evidence。
- [x] AC-verify-only：新增 `scripts/vitest-worker-pool-effective-cpu-check.test.mjs` 锁定"`availableParallelism()` 与 `effective_cpu` 一致"这一事实；负控制（`EFFECTIVE_CAPACITY_TEST_NPROC` 注入一个与真实读数不同的值）证明比较不是恒真；不修改 `maxWorkers` 公式本身；`npm run typecheck`/`npm run lint` 退出 0。AC1-4（公式替换一支）不适用——AC0 证实一致，按 Proposal 原定分支直接走 AC-verify-only。
- [x] AC5 范围受控：`npm run typecheck`/`npm run lint` 退出 0；`git diff` 只落在 `## Touches`（含新增的 `scripts/vitest-worker-pool-effective-cpu-check.test.mjs`，已补进 Touches）。

## DoD

真实落地标准：AC0 的三档对照读数已贴进 Evidence，是本任务走向 AC-verify-only 分支的真实依据——没有跳过 AC0 假定答案。换实现是不必要的，这个结论本身就是本任务的产出；锁定测试已落地且含负控制，`npm run typecheck`/`npm run lint`/`npm run test:scripts`（含本文件与依赖任务新增的探测脚本测试）全部真实跑过。未验证项：三档读数来自本机 `systemd-run -p CPUQuota=` 模拟的 cgroup scope，不是真实不同规格的物理机，如实声明这一局限（与依赖任务的声明一致）。

## Touches

- vitest.config.ts（本次未改动，保留在 Touches 里是因为任务标题/原意指向它；AC0 证实不需要改）
- scripts/vitest-worker-pool-effective-cpu-check.test.mjs (new)
- tasks/gap-vitest-worker-pool-adapts-to-effective-cpu.md

## Evidence（完成记录，2026-10-09；worktree `/data/home/yale/work/claudecodeui-worktrees/gap-vitest-worker-pool-adapts-to-effective-cpu`，branch `task/gap-vitest-worker-pool-adapts-to-effective-cpu`，base 分支 `task/gap-effective-capacity-probe-cgroup-cpu-mem-quota`@`0e848223`，commit `816416dc`，pre-exit merge 干净）

**AC0（三档实测，`availableParallelism()` vs `effective_cpu`）**：
```
CPUQuota=200% -> availableParallelism()=2  effective_cpu=2  (一致)
CPUQuota=400% -> availableParallelism()=4  effective_cpu=4  (一致)
CPUQuota=800% -> availableParallelism()=8  effective_cpu=8  (一致)
```
三档逐一一致，结论：**AC0 证实一致，走 AC-verify-only 分支**，不替换 `maxWorkers` 公式。

**自测（真实跑过）**：
- `node --test scripts/vitest-worker-pool-effective-cpu-check.test.mjs` → `tests 6 / pass 6 / fail 0`：
  1. 无 seam：`availableParallelism()` 与探测一致（PASS）。
  2. 负控制：注入 `EFFECTIVE_CAPACITY_TEST_NPROC=<real+37>`，探测读数与真实读数**不等**——证明比较不是恒真（PASS）。
  3-5. 真实 `systemd-run CPUQuota=200%/400%/800%` 下 `availableParallelism()` 各自读 2/4/8（PASS）。
  6. 静态检查：`vitest.config.ts` 仍含 `availableParallelism() / 2`，且不含对 `effective-capacity.sh` 的任何引用——确认本任务确实没有改它（PASS）。
- `npm run typecheck` → 退出 0（修了一处 `TestContext` 参数缺类型标注的 TS7006）。
- `npm run lint` → 退出 0（仅既有 warning）。
- `npm run test:scripts`（全量，含依赖任务与本任务新增的两个测试文件）→ `tests 403 / pass 403 / fail 0`，duration 94441ms。

**范围**：`git diff --name-only` 相对 `develop` 的集合 = `scripts/effective-capacity.sh`、`scripts/effective-capacity.test.mjs`（来自依赖任务，本任务分支携带但不是本任务的改动）、`scripts/vitest-worker-pool-effective-cpu-check.test.mjs`（本任务新增）；`vitest.config.ts` **未改动**——`git diff develop -- vitest.config.ts` 为空，证实 AC0 的结论（公式本身不需要动）。