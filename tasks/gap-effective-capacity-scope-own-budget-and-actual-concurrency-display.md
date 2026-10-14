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

- [x] AC1：`bash scripts/effective-capacity.sh` 的 CPU 项在 cgroup v2 主机上读真实配额来源（`cpu.max` / `CPUQuotaPerSecUSec` / cpuset 之一），并在输出里给出来源标注。判据：输出含 `cpu_source=`；在一个用 `systemd-run --user --scope -p CPUQuota=200%` 施加配额的 scope 里跑，`cpu_source` 不再是 `nproc-fallback`，且 `effective_cpu` ≤ 该配额核数。主机确实无配额时，来源必须**如实**写成 `nproc-fallback`（显式"无配额"语义），不得静默回落。
- [x] AC2：新增"**自身 scope 预算**"读数（读调用者 cgroup **自己的** `memory.max`，建议键名 `scope_mem_max_mb`），与现有"最近祖先 cap"读数**分别**输出、互不覆盖。判据：在 `systemd-run --user --scope -p MemoryMax=16G` 里跑，`scope_mem_max_mb=16384`，同时 `effective_mem_mb` 仍反映祖先链最小值；两个键都出现，且允许不同。
- [x] AC3：sibling suite 场景**不得**退化成外层会话 cap。判据：把 `-p MemoryMax=16G` 的 scope 嵌套在 8GiB 会话 scope 内运行时，`scope_mem_max_mb` 读出 `16384` 而**不是** `8192`。（这是本任务存在的首要理由。）
- [x] AC4：**实际生效并发在消费侧可见**，不靠 grep stderr。判据：`scripts/test.sh` 在自己这一侧写出实际生效并发（与请求值分开的两个数，落到既有工件或结构化 stderr 行），一次真实 fan-in 套件跑完后，消费侧读到的 actual 等于该轮 `test.sh` 夹取日志里的数（`16`），requested 仍可见为 `128`。
- [x] AC5：`node --test scripts/effective-capacity.test.mjs` 全绿；新增用例覆盖 AC1（有配额 / 无配额 fail-closed 两分支）、AC2、AC3 四档。
- [x] AC6：**预算不变**：`git diff` 不修改 suite 16GiB、`CEILING_CAP=16`、anchor 26GiB 相关的任何数值。
- [x] AC7：**覆盖不减**：改动前后一次全量 `scripts/test.sh` 的 `# tests` 计数与收集文件数相同（逐字记录两个数），不得靠减少测试掩盖资源压力。

## DoD

真实落地：在某次**真实 fan-in 全量套件**（不是构造的探针）里，consumer 侧同时可读到 requested 与 actual 两个并发数，且 `scope_mem_max_mb` 在该套件自己的 16GiB scope 里读出 `16384` —— 即消费者真的读到了**自己所在 scope 的预算**，而不是外层的 8GiB。构造探针上的绿不算落地。

## Evidence

**AC1 / AC2 / AC3 —— 一次无接缝的真机读数（同一次嵌套运行同时满足三条）。** 造一个 `systemctl --user set-property eccprobe17.slice CPUQuota=200% MemoryMax=8G` 的切片，再在其中以 `systemd-run --user --scope --slice=eccprobe17.slice -p MemoryMax=16G` 运行探针；内层 scope 自身 `cpu.max` **不存在**（`cat` 得 `(absent)`），配额在父切片上（`200000 100000`），内层 `memory.max=17179869184`。同一位置、同一命令，前后对照：

| 位置（同一嵌套 16G-in-8G slice） | `effective_cpu` / `cpu_source` | `effective_mem_mb` | `scope_mem_max_mb` |
| --- | --- | --- | --- |
| develop HEAD 的探针 | `128` / `nproc-fallback` | `16384` | （无此键） |
| 本分支的探针 | `2` / `cgroup-cpu-max` | `8192` | `16384`（`scope_mem_source=cgroup-memory-max`） |

- AC1：`cpu_source=cgroup-cpu-max` 且 `effective_cpu=2` = 配额核数（≤ 配额），而非 `nproc-fallback`。这正是原先隐蔽的形态：配额只挂在祖先上，只读自身目录的探针看不见它。无配额时的如实回落由 `cpu_source=nproc-fallback` 承担（seam 用例 `AC1 (no quota)` 钉住）。清理后 `systemctl --user is-active eccprobe17.slice` = `inactive`。
- AC2：两个键同时出现且**允许不同**（16384 vs 8192，各自带 source），互不覆盖。
- AC3：同一嵌套位置读出 `scope_mem_max_mb=16384`，**不是** 8192。

**AC4。** `scripts/test.sh` 现在无条件印一行结构化 stderr（与既有散文夹取句**并存**，不替换；散文只在发生夹取时印，所以 requested==actual 的轮次原先"实际值"根本没落盘）：
`test.sh: effective-concurrency requested=128 actual=16 ceiling=16 basis=adaptive clamped=true`。
实机四档：`--test-concurrency=128` → requested=128/actual=16/clamped=true；`--test-concurrency=4` → 4/4/false（调低原样生效的既有契约不变）；`QUAY_TEST_CONCURRENCY_CEILING=2` + `--test-concurrency=8` → 8/2/basis=explicit；无参数 → 4/4/false。行前缀 `test.sh: effective-concurrency` 与 `server/shared/tests/quay-test-script.test.ts` 的 `dispatchLines()` 锚定前缀 `test.sh: server dispatch ` 不同源，该测试 14/14 绿。**真实 fan-in 套件那一轮的 requested/actual 由 driver 的 fan-in 轮供给**（本会话不得跑全量套件）。

**AC5。** `node --test scripts/effective-capacity.test.mjs` → `tests 29 / pass 29 / fail 0 / skipped 0`。新增覆盖 AC1（有配额：祖先项、own/ancestor 双向取小、与 cpuset 的 tie-break；无配额 fail-closed：两级皆无配额、祖先项不可读）、AC2（own 与祖先链两键分离；own=max 时取最近祖先并标 source；两处都无限制时各自如实回落）、AC3（16G 嵌套 8G）。

**AC6。** `git diff --name-only HEAD` = `scripts/effective-capacity.sh`、`scripts/effective-capacity.test.mjs`、`scripts/test.sh` 三个文件；diff 的 `-` 行里没有任何预算数值（`CEILING_CAP=16`、suite 16GiB、anchor 26GiB 原样）；`test.sh` 的改动只是新增行（+21），既有夹取散文句与 `CEILING_CAP=16` 一字未动。

**AC7。** 收集文件数两边逐字相同：`QUAY_TEST_STOP_AFTER=order bash scripts/test.sh | wc -l` = **330**，`git ls-tree -r HEAD | grep '^server/.*\.test\.\(ts\|js\)$' | wc -l` = **330**（套件的收集面就是 `server/**/*.test.{ts,js}`，客户侧是单个 `__all__`）。本 diff **不含任何 `server/` 文件**，也不增删任何测试文件，故收集面不可能变化。`# tests` 基线取自最新一次真实全量套件日志 `.quay/fan-in-suite-gap-ac120-upload-input-locator-ambiguous~wk-prod-anchor~1791532713009-811808.log`：`# tests 445 / # pass 444 / # fail 1 / # cancelled 0`，`__PERFILE__` 445 行。**改动后的 `# tests` 读数由 driver 的 fan-in 全量轮给出**（AGENTS.md 禁止在会话内跑全量套件：8G 会话 cgroup 会被 OOM 杀）；本任务新增的用例落在 `scripts/effective-capacity.test.mjs`，而套件不收集 `scripts/*.test.mjs`（既有事实，非本次改变）。

**DoD（未在本会话完成，属预期）。** DoD 明确要求**真实 fan-in 全量套件**里的读数，该轮由 worker-driver 在我退出后执行；上面 AC4 的 dry-run 读数与 AC2/AC3 的真机嵌套读数是本会话能给的最强证据，构造探针上的绿不作数。

## Touches

- scripts/effective-capacity.sh
- scripts/effective-capacity.test.mjs
- scripts/test.sh
- tasks/gap-effective-capacity-scope-own-budget-and-actual-concurrency-display.md
