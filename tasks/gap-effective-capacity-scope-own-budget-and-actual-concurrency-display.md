---
id: gap-effective-capacity-scope-own-budget-and-actual-concurrency-display
title: effective-capacity 的 CPU 项实为惰性回落、内存项读的是祖先而非自身 scope 预算；消费侧记的是请求并发（128）而非实际（16）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**本轮只读诊断实测（2026-10-14，仓库 `/data/home/yale/work/claudecodeui`）：**

```
$ bash scripts/effective-capacity.sh
effective_cpu=128   cpu_source=nproc-fallback        ← 从未真正读到 cgroup 配额
effective_mem_mb=8192  mem_source=cgroup-memory-max  ← 读的是最近【祖先】，不是自身 scope
nproc=128  cgroup_v2=true
```

两个读数都偏离了调用者真正需要的语义：

1. **CPU 项一直是回落值。** `scripts/test.sh:100` 的 `adaptive_ceiling()` 名义上算 `min(16, effective_cpu × K)`，但 `effective_cpu` 恒为 `nproc-fallback`=128，于是自适应那一项在本机**惰性**，真正生效的是字面量 `CEILING_CAP=16`（`scripts/test.sh:84`）。128 核机上结论正确，但这是**巧合**：本机若被套上 CPUQuota，它照样给 16，而不是缩到配额允许的值。`scripts/test.sh:75-79` 的注释承诺了一个没在工作的机制。

2. **内存项读的是祖先链的最小 cap，不是"我所在的 scope 有多少预算"。** 本会话读到 `effective_mem_mb=8192`，那是 8GiB 会话 scope 的 `memory.max`。而 sibling suite 跑在**16GiB 套件 scope** 里。把 8192 当预算去推并发/worker 宽度，就是把**外层会话 cap 错套到 16GiB 套件**上。

3. **消费侧看到的是请求值，不是实际值。** `.quay/full-suite-state.json` 记 `laneCount: 128`，实际跑的是夹取后的 16。唯一的"实际值"证据是 suite stderr 里的
   `test.sh: --test-concurrency=128 exceeds the server-phase ceiling 16 -> clamped to 16`，
   要人去 grep 才能拿到。

**范围（消费者 / 本地侧）。** ⛔ 不在本 repo 复制共享 runner 的机制：`full-suite-runner` 的 OOM / telemetry / 完整性改动由 Quay 协调会话 **c744a2cf** 承接，本任务只做**消费者升级 + 核验**（本 repo 无 `plugin/scripts/full-suite-runner.*` 副本，`plugin/scripts/` 下只有 `runner-static-gate.ts`）。⛔ 不扩大任何预算：suite 16GiB、server 并发 16、anchor 26GiB 全部不变。⛔ 不减少任何覆盖判据去掩盖资源压力。

<!-- dedup-ref -->
复用关系（均 `done`，不要重复实现）：`gap-effective-capacity-probe-cgroup-cpu-mem-quota`（建了探测脚本）、`gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu`（建了自适应夹取）、`gap-with-memory-cap-default-adapts-to-effective-memory`、`gap-vitest-worker-pool-adapts-to-effective-cpu`。本任务是它们**留下未闭环的那一半**：CPU 项惰性 + 消费者侧读到请求值而非实际值。

## AC

- [ ] AC1：`bash scripts/effective-capacity.sh` 的 CPU 项在 cgroup v2 主机上读真实配额来源（`cpu.max` / `CPUQuotaPerSecUSec` / cpuset 之一），并在输出里给出来源标注。判据：输出含 `cpu_source=`；在一个用 `systemd-run --user --scope -p CPUQuota=200%` 施加配额的 scope 里跑，`cpu_source` 不再是 `nproc-fallback`，且 `effective_cpu` ≤ 该配额核数。主机确实无配额时，来源必须**如实**写成 `nproc-fallback`（显式"无配额"语义），不得静默回落。
- [ ] AC2：新增"**自身 scope 预算**"读数（读调用者 cgroup **自己的** `memory.max`，建议键名 `scope_mem_max_mb`），与现有"最近祖先 cap"读数**分别**输出、互不覆盖。判据：在 `systemd-run --user --scope -p MemoryMax=16G` 里跑，`scope_mem_max_mb=16384`，同时 `effective_mem_mb` 仍反映祖先链最小值；两个键都出现，且允许不同。
- [ ] AC3：sibling suite 场景**不得**退化成外层会话 cap。判据：把 `-p MemoryMax=16G` 的 scope 嵌套在 8GiB 会话 scope 内运行时，`scope_mem_max_mb` 读出 `16384` 而**不是** `8192`。（这是本任务存在的首要理由。）
- [ ] AC4：**实际生效并发在消费侧可见**，不靠 grep stderr。判据：`scripts/test.sh` 在自己这一侧写出实际生效并发（与请求值分开的两个数，落到既有工件或结构化 stderr 行），一次真实 fan-in 套件跑完后，消费侧读到的 actual 等于该轮 `test.sh` 夹取日志里的数（`16`），requested 仍可见为 `128`。
- [ ] AC5：`node --test scripts/effective-capacity.test.mjs` 全绿；新增用例覆盖 AC1（有配额 / 无配额 fail-closed 两分支）、AC2、AC3 四档。
- [ ] AC6：**预算不变**：`git diff` 不修改 suite 16GiB、`CEILING_CAP=16`、anchor 26GiB 相关的任何数值。
- [ ] AC7：**覆盖不减**：改动前后一次全量 `scripts/test.sh` 的 `# tests` 计数与收集文件数相同（逐字记录两个数），不得靠减少测试掩盖资源压力。

## DoD

真实落地：在某次**真实 fan-in 全量套件**（不是构造的探针）里，consumer 侧同时可读到 requested 与 actual 两个并发数，且 `scope_mem_max_mb` 在该套件自己的 16GiB scope 里读出 `16384` —— 即消费者真的读到了**自己所在 scope 的预算**，而不是外层的 8GiB。构造探针上的绿不算落地。

## Touches

- scripts/effective-capacity.sh
- scripts/effective-capacity.test.mjs
- tasks/gap-effective-capacity-scope-own-budget-and-actual-concurrency-display.md
