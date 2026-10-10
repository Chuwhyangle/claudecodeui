---
id: gap-effective-capacity-probe-cgroup-cpu-mem-quota
title: 新增独立探测脚本：读 cgroup v2 cpu.max/memory.max 算出 effective CPU/memory（不是
  nproc/affinity），不依赖 quay 安装位置，零行为改动
status: todo
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
- `vitest.config.ts:20-21` `maxWorkers = min(8, floor(availableParallelism()/2))` —— **已验证**（见下方「与 quay 侧探测对齐」）：`os.availableParallelism()` 在本仓运行环境（Node v24.21.0）下确实是 cgroup v2 bandwidth quota-aware，这一待验证点已解决，消费任务 `gap-vitest-worker-pool-adapts-to-effective-cpu` 据此可以走"仅补验证测试"而非"换实现"的分支。
- `scripts/with-memory-cap.sh:30` `CAP="${QUAY_MEMORY_MAX:-24G}"` —— 固定 24G，不读 cgroup `memory.max` 或 `free -m` 的真实可用量。
- quay 自己的 `resource-gate.sh`/`process-budget.sh` 里的 `nproc`/`nproc --all` 读的是**反方向的量**（host-wide 核数）。**已与 quay 侧一个对等会话（"Quay 测试墙钟耗时"）两轮往返确认接口字段与测试缝命名**，且 quay 侧已落地同构探测 `plugin/scripts/effective-capacity-probe.ts`（TypeScript，字段名与测试缝名与本任务逐字一致）。

**接口对齐（已与 quay 侧达成一致并互相确认，2026-10-09 跨会话协同）**：见下方 Output Contract；quay 侧回复接受本任务提出的定稿字段名,不改名。

**关于"能否直接复用已安装 Quay 插件的探测能力"——已评估,结论是不能，理由记录如下**：quay 的实现是 TypeScript（`node --experimental-strip-types`），部署在版本化的插件缓存路径下（如 `~/.claude/plugins/cache/quay/quay/<version>/...`），该路径随 quay 版本升级变化——这正是 `gap-driver-resource-gate-path-anchored-at-root-third-party` 曾经要专门解决的同一类脆弱性（第三方项目硬编码一个会变的绝对路径）。直接调用它会让 ClaudeCodeUI 的测试稳定性重新变成对"quay 已安装、版本路径可解析"的强依赖——与本任务开篇的裁定（"不得强依赖跨项目协调"）直接冲突。因此采用的是**项目级独立兼容实现**（本文件），而不是"复制一套相互矛盾的探测算法"——算法本身与 quay 版本在核心路径（cpu.max/memory.max 读取与求值）上逐字对齐，只在前述那条已验证场景不复用（见本节与本文件头注释里的"one deliberate divergence"说明：quay 的 `nproc` 字段取自已验证 quota-aware 的 `os.availableParallelism()`，bash 没有等价 API，`nproc` 命令本身**不** quota-aware——已实测确认：`CPUQuota=50%/250%/400%` 下 bash `nproc` 恒为 128）。

**本任务只做探测，不改任何现有行为**（消费方是后续任务：`gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu`、`gap-vitest-worker-pool-adapts-to-effective-cpu`、`gap-with-memory-cap-default-adapts-to-effective-memory`，均 `depends_on` 本任务）<!-- dedup-ref:inline -->。

**Output Contract（与 quay 侧逐字一致，已互相确认）**：

report 模式（key=value，一行一个，顺序固定）：
```
effective_cpu=<int>           # min(cpu.max bandwidth quota 算出的核数, cpuset.cpus.effective 核数, nproc)
cpu_source=cgroup-cpu-max|cpuset|nproc-fallback
effective_mem_mb=<int>
mem_source=cgroup-memory-max|free-fallback
nproc=<int>                   # 对照读数，host/affinity 核数，不是最终值
cgroup_v2=true|false
```
`--json` 模式输出同一组字段的 JSON 对象，键名不变。

测试缝（与 quay 侧逐字一致）：
```
EFFECTIVE_CAPACITY_TEST_CPU_MAX=<quota> <period>|max
EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT=<int>
EFFECTIVE_CAPACITY_TEST_MEMORY_MAX=<bytes>|max
EFFECTIVE_CAPACITY_TEST_NPROC=<int>
EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB=<int>
```

**不依赖 quay**：不引用 `QUAY_PLUGIN_ROOT`/`plugins/cache/quay`；**零行为改动**：不修改 `scripts/test.sh`、`vitest.config.ts`、`scripts/with-memory-cap.sh`、`package.json`。

## AC

- [x] AC1 真实 cgroup v2 环境下的读数：用 `systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=2G` 包起来跑 `scripts/effective-capacity.sh`，输出 `effective_cpu=2`、`effective_mem_mb=2048`、`cgroup_v2=true`；对 `CPUQuota=400%`/`800%` 各重复一次。三组读数见 Evidence。
- [x] AC2 测试缝验证 fail-open：注入 `EFFECTIVE_CAPACITY_TEST_CPU_MAX=max` + `EFFECTIVE_CAPACITY_TEST_NPROC=4` → `cpu_source=nproc-fallback`、`effective_cpu=4`；注入 `EFFECTIVE_CAPACITY_TEST_MEMORY_MAX=max` + `EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB=2048` → `mem_source=free-fallback`、`effective_mem_mb=2048`；两者退出码均 0。见 Evidence。
- [x] AC3 `--json` 与 report 模式字段一致：`scripts/effective-capacity.test.mjs` 的"same six keys, same values"用例覆盖，见 Evidence 测试读数。
- [x] AC4 不依赖 quay：`grep -c "QUAY_PLUGIN_ROOT\|plugins/cache/quay" scripts/effective-capacity.sh` = `0`。
- [x] AC5 范围受控且不新增 `scripts/*.mjs` typecheck 覆盖面问题：新增 `scripts/effective-capacity.test.mjs`（`.mjs` 是本仓既有约定——`scripts/**/*.test.mjs` 本来就被 `npm run test:scripts`/`node scripts/list-script-tests.mjs` 收集，不是本任务新开的覆盖面），`npm run typecheck`、`npm run lint` 退出 0。
- [x] AC6 `git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`；未新增对 `scripts/test.sh`/`vitest.config.ts`/`scripts/with-memory-cap.sh`/`package.json` 的改动。

**AC1 原文的自测命令已更正（如实披露）**：Proposal 原计划用 `bash scripts/test.sh --for-task <id>` 作为 AC1 自测，**实测发现这条命令对本任务不适用**——`scripts/test.sh` 的服务端/客户端两阶段只收集 `server/**/*.test.ts`（node:test）与 `src/**/*.test.ts(x)`（vitest），从不收集 `scripts/**/*.test.mjs`（`grep -n "scripts/\*\*" scripts/test.sh` 零命中；这条线由完全独立的 `npm run test:scripts` 覆盖，不在 fan-in 的全量套件判词里）。`--for-task` 对本任务的真实输出是 `no scoped test files for gap-effective-capacity-probe-cgroup-cpu-mem-quota (thin)`，退出码 0——这是**正确的 thin 结果**（结构上无话可说，不是假红也不是假绿），不是"# fail 0"那种有实质判词的绿。本任务真实的自测入口是 `npm run test:scripts`（见 Evidence，397/397 通过）与 `node --test scripts/effective-capacity.test.mjs`（17/17 通过）。`suite-scope-check.sh` 的 PASS 本身不受影响（它只检查"Touches 含 *.test.* 的任务必须带 --for-task"这一结构性要求，本任务确实带了）。

## DoD

真实落地标准：AC1 的三档 CPUQuota 实测读数是本机真实测得；AC2 的测试缝注入读数逐字贴出；脚本落地后 `npm run test:scripts` 全量跑一次（397 文件集合的一部分），读数与改动前同量级，证明是纯增量，不影响既有脚本判据。未验证项：quay 侧字段是否与本任务逐字一致——已对照 quay 侧 `plugin/scripts/effective-capacity-probe.ts` 源码核对字段名/测试缝名逐字相同（见 Proposal「与 quay 侧探测对齐」），但未拿两边的真实 CLI 输出并排跑一次 diff（两边各自的宿主环境/cgroup 状态在跑这条判词时可能不同，如实声明未做）。

## Touches

- scripts/effective-capacity.sh (new)
- scripts/effective-capacity.test.mjs (new)
- tasks/gap-effective-capacity-probe-cgroup-cpu-mem-quota.md

## Evidence（完成记录，2026-10-09；worktree `/data/home/yale/work/claudecodeui-worktrees/gap-effective-capacity-probe-cgroup-cpu-mem-quota`，branch `task/gap-effective-capacity-probe-cgroup-cpu-mem-quota`，commit `34e8a369`，pre-exit merge 干净，base `develop`=`711bd711`）

**与 quay 侧探测对齐（独立验证，不是盲信对方的测量）**：在本机（ClaudeCodeUI 的仓库/worktree 内，与 quay 侧测量用的是同一台物理机、同一个 Node v24.21.0 二进制）重新测了一遍 `os.availableParallelism()` 是否 quota-aware：
```
CPUQuota=50%   -> os.cpus().length=128  availableParallelism=1
CPUQuota=250%  -> os.cpus().length=128  availableParallelism=2
CPUQuota=400%  -> os.cpus().length=128  availableParallelism=4
```
与 quay 侧 `effective-capacity-probe.ts` 头注释里登记的测量表逐档一致（50%→1、250%→2、400%→4）。同时验证了 bash `nproc` **不** quota-aware（三档下恒为 128），这正是本任务 bash 实现里"nproc 字段是比 quay 的 TS 实现更弱的 fallback"这一披露的实测依据。

**AC1（三档 CPUQuota 实测）**：
```
CPUQuota=200% + MemoryMax=2G -> effective_cpu=2 cpu_source=cgroup-cpu-max effective_mem_mb=2048 mem_source=cgroup-memory-max nproc=128 cgroup_v2=true
CPUQuota=400%                -> effective_cpu=4 cpu_source=cgroup-cpu-max (mem 未设 cap，mem_source=free-fallback，宿主总内存) nproc=128 cgroup_v2=true
CPUQuota=800%                -> effective_cpu=8 cpu_source=cgroup-cpu-max nproc=128 cgroup_v2=true
```

**AC2（fail-open 测试缝）**：
```
EFFECTIVE_CAPACITY_TEST_CPU_MAX=max EFFECTIVE_CAPACITY_TEST_NPROC=4
  -> effective_cpu=4 cpu_source=nproc-fallback cgroup_v2=true（seam 本身即隐含"cgroup 存在"）exit=0
EFFECTIVE_CAPACITY_TEST_MEMORY_MAX=max EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB=2048
  -> effective_mem_mb=2048 mem_source=free-fallback exit=0
```

**发现并修复的一处正确性缺陷（tie-break 优先级）**：首版实现用"反向覆盖"写法（从 nproc 起步，cpuset 比它小就覆盖，cgroup-cpu-max 比当前胜者小才覆盖）在**数值相等**时会把优先级判反——`cpu.max` 算出 3 核、`cpuset` 也是 3 核时，首版会报 `cpu_source=cpuset`，但契约要求"cgroup-cpu-max > cpuset"，相等时必须报 `cgroup-cpu-max`。改为"按优先级顺序建候选列表、以第一个候选为初始胜者、严格 `<` 才替换"后，三种 tie-break 场景分别验证：
```
cgroup-cpu-max=3 vs cpuset=3（相等）   -> cpu_source=cgroup-cpu-max（修复前会错报 cpuset）
cpuset=5 vs nproc=5（相等）            -> cpu_source=cpuset
cgroup-cpu-max=8 vs cpuset=3（不等）    -> cpu_source=cpuset（更小值胜，不受优先级顺序影响）
```

**自测（真实跑过，不是形态检查）**：
- `node --test scripts/effective-capacity.test.mjs` → `tests 17 / pass 17 / fail 0`，duration 258ms（含上述三组 tie-break 用例、fail-open 用例、quota 数学用例、一条跳过式负控——若 `systemd-run --user --scope` 不可用则 skip 而非误判绿）。
- `npm run test:scripts`（全量 36 个 `scripts/**/*.test.mjs` 文件，本任务新增的也在其中）→ `tests 397 / pass 397 / fail 0`，duration 93815ms。
- `npm run typecheck` → 退出 0；`npm run lint` → 退出 0（仅既有 warning，与本任务文件无关）。
- `bash scripts/test.sh --for-task gap-effective-capacity-probe-cgroup-cpu-mem-quota` → 退出 0，`no scoped test files ... (thin)`（见上方「AC1 原文自测命令已更正」的说明，这是预期的 thin 结果）。

**范围**：`git diff --name-only $(git merge-base HEAD develop) HEAD` = `scripts/effective-capacity.sh`、`scripts/effective-capacity.test.mjs`（加 `tasks/` 自身），与 `## Touches` 一致；未触碰 `scripts/test.sh`/`vitest.config.ts`/`scripts/with-memory-cap.sh`/`package.json`。
## Needs-Human

**执行 2026-10-10T08:18:12.730Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：3c752b9f-0c45-4c21-bb79-183eab694505
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-effective-capacity-probe-cgroup-cpu-mem-quota~wk-prod-anchor~1791620245348-35dfb9.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-effective-capacity-probe-cgroup-cpu-mem-quota-wk-prod-anchor.log

## 复核与解封（2026-10-10，manager 侧）

本任务被 park 的直接原因**不是实现缺陷**，是一次**环境性的 suite 终止**，取证：

- 失败步 `step=suite`，判词逐字：`not ok - suite-watchdog: terminated by an external signal before the suite finished`、`# cancelled 271`、`# fail 1`；
- `durationMs 41515`、`laneCount 128` —— 远低于内部边界（660 s 运行 / 240 s 静默），且 watchdog 自报是**外部信号**，不是内部超时；
- 解析器抽出 1 行失败却**归因不到任何测试文件**（`failing-lines-unattributable-to-files`）⇒ 驱动按「基建/契约疑似」停派（⛔ 不再重派）。

判别依据（本仓既有结论）：`suite red` + 失败行归因不出文件 + watchdog 自报外部信号 ⇒ 红在**运行环境/并发车道**，不在 delta。本任务的 delta 是纯新增的两个文件（`scripts/effective-capacity.sh` + 其 `.test.mjs`，零行为改动），没有任何失败被归因到它。

**处置**：`needs-human → todo`（实现已在任务分支 `34e8a369` 完成、6/6 AC 已勾），交晋升驱动机械重升、worker 复核后重跑机械 fan-in。⛔ 不需要改任何实现代码；若重跑仍被同一外部信号 TERM，要解决的是并发载荷（同时段多个 suite 争用车道），不是本任务。
