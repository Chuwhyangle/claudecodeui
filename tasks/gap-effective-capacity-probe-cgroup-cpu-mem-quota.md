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
- `vitest.config.ts:20-21` `maxWorkers = min(8, floor(availableParallelism()/2))` —— `os.availableParallelism()`（Node/libuv）读的是 affinity/cpuset 核数，**不读 cgroup v2 `cpu.max` 的 CFS bandwidth quota**；一个被 `cpu.max = "200000 100000"`（=2 个有效核）限制的 cgroup，`availableParallelism()` 仍可能报告宿主的全部核数。
- `scripts/with-memory-cap.sh:30` `CAP="${QUAY_MEMORY_MAX:-24G}"` —— 固定 24G，不读 cgroup `memory.max` 或 `free -m` 的真实可用量；在物理内存小于 24G 的环境里这个"上限"形同虚设或本身就会把调用方的 cgroup 顶爆。
- quay 自己的 `resource-gate.sh`/`process-budget.sh` 里的 `nproc`/`nproc --all` 读的是**反方向的量**（host-wide 核数，用于拿 host-wide loadavg 去比；`gap-systemd-run-cpuquota-scope-distorts-nproc` 的设计笔记明确说明为什么故意不用 cgroup-scoped nproc）——这与本任务要的"这个 cgroup/容器自己被限制到了多少有效核"是不同的量，quay 现有脚本里没有对等实现（已与 quay 侧一个对等会话确认，见协同记录）。

**本任务只做探测，不改任何现有行为**（消费方是后续任务，分别是 `gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu`、`gap-vitest-worker-pool-adapts-to-effective-cpu`、`gap-with-memory-cap-default-adapts-to-effective-memory`，均 `depends_on` 本任务）：

新增 `scripts/effective-capacity.sh`：
- **CPU**：读 `/sys/fs/cgroup/cpu.max`（格式 `<quota> <period>` 或字面 `max`）。`quota`≠`max` 时 `effective_cpu = floor(quota/period)`（向下取整，至少 1）；`quota`=`max` 或文件不存在（非 cgroup v2 / 无 bandwidth 限制）时 fail-open 退回 `nproc`。同时读 cpuset（`/sys/fs/cgroup/cpuset.cpus.effective`，存在时取其基数）与 bandwidth quota 的**较小值**作为 `effective_cpu`（两种限制都可能同时存在）。
- **Memory**：读 `/sys/fs/cgroup/memory.max`（字面 `max` 或字节数）与 `free -m` 的可用物理内存，取较小值作为 `effective_mem_mb`；无 cgroup v2 时 fail-open 退回 `free -m`。
- **输出**：沿用 `resource-gate.sh` 的既有风格——report 模式打印多行 `key=value`（含 `effective_cpu=N source=cgroup-cpu-max|cpuset|nproc-fallback`、`effective_mem_mb=N source=cgroup-memory-max|free-fallback`、`nproc=N`（host/affinity 对照，便于诊断两者差异）、`cgroup_v2=true|false`）；`--json` 模式输出同一组字段的一个 JSON 对象。
- **不依赖 quay**：脚本自身不 `require`/`import`/`exec` 任何 `QUAY_PLUGIN_ROOT` 下的文件，不检查 quay 是否安装；在没有 quay 的环境里独立可跑可测。
- **零行为改动**：本任务不修改 `scripts/test.sh`、`vitest.config.ts`、`scripts/with-memory-cap.sh`、`package.json` 中的任何现有命令或默认值。

**协同记录**：已向 quay 侧一个对等会话（session "Quay 测试墙钟耗时"）发出接口对齐请求，提议本脚本的输出字段/模式作为 quay 生态里"effective capacity"探测的统一约定候选；回复未到前先独立推进（不强依赖对方节奏），对齐结果如与本任务的字段命名冲突，由后续一个小任务改名对齐，不阻塞本任务落地。

## AC

- [ ] AC1 真实 cgroup v2 环境下的读数：在一个用 `systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=2G` 包起来的子 shell 里跑 `scripts/effective-capacity.sh`，输出 `effective_cpu=2`（±向下取整容差）、`effective_mem_mb` 接近 2048（减去 cgroup 自身开销的合理误差范围内）、`cgroup_v2=true`。对 `CPUQuota=400%`/`800%` 各重复一次，三组读数都要贴进完成记录（这是本仓既有方法论要求的"坡度表式"实测依据，不是单点）。
- [ ] AC2 fail-open：在没有 `cpu.max`/`memory.max` 文件的环境（可用 `unshare` 或直接在非 cgroup v2 宿主上跑；若本机找不到这种环境，用临时改写 `effective-capacity.sh` 读取路径为不存在路径的方式模拟，并在完成记录里如实说明是模拟）验证输出退回 `nproc`/`free -m`，`source=nproc-fallback`/`source=free-fallback`，退出码 0（fail-open，不是 fail-closed——探测本身失败不该阻塞测试跑起来，这与 `resource-gate.sh` 的 fail-closed 语义不同，后者是"要不要起跑"的准入门，本脚本只是读数）。
- [ ] AC3 `--json` 与 report 模式字段一致：`diff <(scripts/effective-capacity.sh | sort) <(scripts/effective-capacity.sh --json | node -e '...解析成同样的 key=value 行排序...')` 的关键字段（`effective_cpu`、`effective_mem_mb`、`nproc`、`cgroup_v2`）取值相同。
- [ ] AC4 不依赖 quay：`grep -c "QUAY_PLUGIN_ROOT\|plugins/cache/quay" scripts/effective-capacity.sh` 为 `0`；在一个移走/重命名了 `~/.claude/plugins/cache/quay` 的临时环境变量模拟（或直接验证脚本从不引用该路径）下脚本仍可独立跑通并给出合理读数。
- [ ] AC5 范围受控且不新增 `scripts/*.mjs`（避免被 `npm run typecheck` 对 `scripts/` 的扫描覆盖面影响）：新增测试用 `scripts/effective-capacity.test.sh` 或等价的 shell 断言脚本（不是 `.mjs`），或若必须用 `.test.mjs`（例如需要更精细的字符串/JSON 断言），需确认它能被 `npm run test:scripts` 的 `node scripts/list-script-tests.mjs` 正常收集且不破坏既有计数类守卫（先读一次 `server/shared/tests/quay-test-script.test.ts` 类似的计数守卫基线，若存在等价的 scripts/ 计数守卫，一并核对）。`npm run typecheck`、`npm run lint` 退出 0。
- [ ] AC6 `git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`；不新增 `scripts/test.sh`/`vitest.config.ts`/`scripts/with-memory-cap.sh`/`package.json` 的改动（这些是后续任务的范围）。

## DoD

真实落地标准：AC1 的三档 CPUQuota 实测读数是本机真实测得（不是推算），附带每档的误差来源说明（cgroup 自身开销、取整方向）；AC2 的 fail-open 行为必须在完成记录里写明是真实环境还是模拟环境测得，如为模拟如实声明；脚本本身在本任务落地后不改变任何现有测试命令的行为（`npm test` 全链路跑一次，读数与改动前一致，证明是纯增量）。未验证项：若本机找不到任何真正缺少 cgroup v2 的环境来验证 AC2，如实声明只验证了模拟路径。

## Touches

- scripts/effective-capacity.sh (new)
- scripts/effective-capacity.test.sh (new，或等价的 node:test 文件，命名以实现时确认的收集方式为准)
- tasks/gap-effective-capacity-probe-cgroup-cpu-mem-quota.md (new)