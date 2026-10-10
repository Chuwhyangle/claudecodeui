---
id: gap-with-memory-cap-default-adapts-to-effective-memory
title: scripts/with-memory-cap.sh 的默认内存上限从固定 24G 改为按 effective memory
  自适应（不超过物理/cgroup 可用量）
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

**依赖**：`gap-effective-capacity-probe-cgroup-cpu-mem-quota`（已实现，commit `34e8a369`；本任务 worktree 从该分支切出）。

**现状**：`scripts/with-memory-cap.sh:30`（改动前）`CAP="${QUAY_MEMORY_MAX:-24G}"`——固定 24G，不读实际可用内存。`gap-npm-test-server-scripts-bounded-concurrency-and-memory-scope`（done）明确记录了"不改 with-memory-cap.sh"是该任务自己的范围边界，本任务是专门接手这件事的后续任务。

**改法（已实现，见 Evidence）**：`QUAY_MEMORY_MAX` 未设置（或设为空）时，默认值由 `scripts/effective-capacity.sh` 的 `effective_mem_mb` 推导：`DEFAULT_CAP_FRACTION = 75%`，`clamp([512, 24576] MB)`。75% 的理由：给调用方自身（shell/session）与同一宿主 cgroup 下的兄弟进程留出 25% 余量——不是凭感觉，是系统工程里常见的"运行时开销留白"量级，并用三档真实 cgroup（2G/4G/8G）做了存活/反噬两面的实测验证（见 Evidence）。24576MB（=24G）上限保证**大内存宿主行为完全不变**（246G 宿主 ×75% ≫ 24576，照旧落在旧上限）。显式 `QUAY_MEMORY_MAX`（含 `0`/`off`）**逐字不改**。

**不做**：未修改 systemd-run 降级逻辑；未修改任何调用方（`package.json`/`scripts/test.sh`）。

## AC

- [x] AC1 默认值来源替换，显式覆盖逐字不变：见 Evidence，`QUAY_MEMORY_MAX=777M`/`off`/`0` 三种显式路径读数与改动前逐字一致；`scripts/vitest-heap-limit-check.sh`（该脚本明确"一字不许动 with-memory-cap.sh"的依赖方，它自己从不调用本脚本，只断言 vitest.config.ts 的堆上限）读数未变。
- [x] AC2 不超过可用量：2G/4G/8G 三档真实 cgroup 下分别派生 1536M/3072M/6144M（=75%）；一个远小于派生上限的负载（512MB）存活；一个超过派生上限的失控负载被限定在**自己的 scope 内** OOM 杀掉，不反噬宿主的 2G 外层 scope（外层 scope 在负载被杀后仍存活并继续执行）。见 Evidence。
- [x] AC3 负控制：`QUAY_MEMORY_MAX=1G` 显式覆盖下的失控负载依然被 OOM 杀掉（exit=137），journal 确认 `killed by the OOM killer`——证明新默认值逻辑没有污染显式路径。见 Evidence。
- [x] AC4 既有守卫不退化：`bash scripts/vitest-heap-limit-check.sh` → PASS，退出 0，读数与该脚本既有契约一致；`npm run typecheck`、`npm run lint` 均退出 0。

## DoD

真实落地标准：2G/4G/8G 三档的真实 OOM 边界验证（故意触发、确认被杀、确认归因正确、确认外层 scope 不受影响）已贴进 Evidence；`QUAY_MEMORY_MAX` 显式覆盖路径的读数与改动前逐字相同的证据已贴出。未验证项：三档读数来自本机 `systemd-run -p MemoryMax=` 模拟的 cgroup，不是真实不同规格的物理机（与依赖任务的声明一致）；`npm run test:scripts` 全量跑时撞到 3 个**与本任务改动无关**的文件级假红（见 Evidence 的如实披露），已隔离复跑确认是负载类假红，不是本任务引入的回归，未对这 3 个文件做任何修改。

## Touches

- scripts/with-memory-cap.sh
- scripts/with-memory-cap-effective-default.test.mjs (new)
- tasks/gap-with-memory-cap-default-adapts-to-effective-memory.md

## Evidence（完成记录，2026-10-09；worktree `/data/home/yale/work/claudecodeui-worktrees/gap-with-memory-cap-default-adapts-to-effective-memory`，branch `task/gap-with-memory-cap-default-adapts-to-effective-memory`，base 分支 `task/gap-effective-capacity-probe-cgroup-cpu-mem-quota`@`0e848223`，commit `1aca8a3d`，pre-exit merge 干净）

**AC1（默认值 vs 显式覆盖）**：
```
无 QUAY_MEMORY_MAX（本机，cgroup_v2=true，effective_mem_mb=8192） -> CAP=6144M（75%）
QUAY_MEMORY_MAX=1G  -> CAP=1G（逐字不变）
QUAY_MEMORY_MAX=off -> 直通不限（逐字不变，stdout/exit 与裸跑一致）
QUAY_MEMORY_MAX=0   -> 直通不限（逐字不变）
```

**AC2（2G/4G/8G 三档真实 cgroup，派生值 + 存活/反噬两面）**：
```
MemoryMax=2G -> 派生 CAP=1536M（75%）
MemoryMax=4G -> 派生 CAP=3072M（75%）
MemoryMax=8G -> 派生 CAP=6144M（75%）
边界值：EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB=400（极小）  -> CAP=512M（下限 clamp 生效）
边界值：EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB=1048576（极大）-> CAP=24576M（上限 clamp 生效，大宿主行为不变）
```
存活测试（2G 外层 scope，默认派生 1536M 上限，分配 512MB）：`survived: allocated 512MB under a 1536M derived cap`，`payload exit=0`。
反噬测试（同一 2G 外层 scope，失控分配器）：内层 scope `payload exit=137`（OOM killed），**外层 2G scope 存活**并继续执行后续 `echo`；journal 确认 `acneg-*.scope: killed by the OOM killer`、`Failed with result 'oom-kill'`——反噬没有发生。

**AC3（负控制，显式 1G 覆盖仍被杀）**：`QUAY_MEMORY_MAX=1G` 失控分配器 → `exit=137`；journal `actest-*.scope: A process of this unit has been killed by the OOM killer`。

**AC4（既有守卫）**：
```
vitest-heap-limit-check: PASS — 受限：…（与改动前读数同形）
npm run typecheck -> exit 0
npm run lint -> exit 0（仅既有 warning）
```

**自测**：
- `node --test scripts/with-memory-cap-effective-default.test.mjs` → `tests 6 / pass 6 / fail 0`。
- `npm run test:scripts`（全量 38 文件）首次跑撞到 3 个文件级失败：`asr-second-adapter-check.test.mjs`、`voice-capture-process-check.false-forms.test.mjs`、`voice-worklet-build-check.test.mjs`，均报 `Promise resolution is still pending but the event loop has already resolved`——**与本任务改动无文件重叠**（均不触碰 `with-memory-cap.sh`/`effective-capacity.sh`）。隔离重跑（去掉 `--test-concurrency=16` 的并发争抢，三个文件单独一次调用）：**20/20 全绿**，确认是 `--test-concurrency=16` 下的负载类假红（本仓已大量记录的同类机制：高并发下无关文件互相抢占资源产生的"事件循环已空但 promise 未决"假红），不是本任务引入的回归。未对这三个文件做任何改动或重跑豁免。

**范围**：`git diff --name-only` 相对 `develop` 的集合 = `scripts/effective-capacity.sh`、`scripts/effective-capacity.test.mjs`、`scripts/vitest-worker-pool-effective-cpu-check.test.mjs`（来自依赖任务与前序任务，分支携带，非本任务改动）、`scripts/with-memory-cap.sh`、`scripts/with-memory-cap-effective-default.test.mjs`（本任务新增/修改）。
## 复验（2026-10-10，第二轮；上一轮 suite 红为外部信号，非本任务回归）

**上一轮 fan-in `step=suite` 红的判据（外部 TERM）**：故障行是
`not ok - suite-watchdog: terminated by an external signal before the suite finished`——该行只在
`$WATCHDOG_VERDICT` 为空（内部任何看门狗都未触发）时由 `scripts/test.sh` 的 `suite_abort` trap 打印。
`.quay/suite-logs/20261010T165656-1231374/watchdog-trace.txt`：`elapsed_ms=40158 max_silence_ms=10038
progress_events=22`，远低于内部界 `SUITE_MAX_RUNTIME_MS=660000` / `SUITE_SILENCE_MS=240000`；
`.quay/full-suite-state.json` `reason:"failed"`（非 `timeout`/`hung`/`aborted`）。即并发 lane / 共享宿主
发出的外部 TERM，发生在 server 相位 fan-out 之初（`1 fail / 271 cancelled`），与本任务两文件 delta
（`scripts/with-memory-cap.sh` + 自测）无因果关系——`with-memory-cap.sh` 在本机派生的上限仍为 24G，
与改动前字面量逐字相同。

**独立复验读数（2026-10-10）**：
- AC1 默认（本机 `effective_mem_mb=63224` × 75% → clamp 24576M）：`MemoryMax=25769803776`（=24G，大宿主行为不变）；
  显式 `quantities`：`1G→1073741824`、`777M→814743552`、`off→infinity`、`0→infinity`（逐字）。
- AC2 `memory.max=2G/4G/8G` → `1536M/3072M/6144M`；floor（`EFFECTIVE_CAPACITY_TEST_MEMORY_MAX=400MB`→`512M`）、
  ceiling（`=1TB`→`24576M`）clamp 生效；存活（512MB，派生 1536M 上限）exit 0；反噬（失控分配器）内层
  exit=137、journal `killed by the OOM killer`、外层存活并继续 exit 0。
- AC3 `QUAY_MEMORY_MAX=1G` 失控分配器 → exit=137，journal `A process of this unit has been killed by the
  OOM killer` + `Failed with result 'oom-kill'`。
- AC4 `bash scripts/vitest-heap-limit-check.sh` → `PASS`，exit 0；`npm run typecheck` / `npm run lint` 在上一轮
  suite 日志中均 `passed=true`。
- 自测 `node --test scripts/with-memory-cap-effective-default.test.mjs` → `tests 6 / pass 6 / fail 0`。

**树状态**：worktree 干净，`develop`（`719b0ed1`）为 HEAD（`9063de46`）祖先，无需再合并。

## 复验（第三轮，2026-10-10；重新派发后复验，判决前两轮的「外部信号、与本 delta 无因果」结论由调用图证据独立坐实）

**本轮做了什么**：重新派发后 re-provision worktree（幂等）→ `git merge develop`（干净，无冲突；按 per-hunk
union：develop 侧新增的 `## Needs-Human` 保留，本分支 4 条 AC tick 保留）→ 逐条复验 AC，未改实现。

**因果隔离（本轮新增证据，排除本任务 delta 与 suite 红的关联）**：`scripts/test.sh` 只在 **client vitest
相位**（`scripts/test.sh:945` `MEMCAP="$ROOT_DIR/scripts/with-memory-cap.sh"`）调用本脚本；**server 相位完全
不经 `with-memory-cap.sh`**（`scripts/test.sh:884-895` 直接 `env TSX_TSCONFIG_PATH=… node --import tsx --test "$f"`）。
本轮 suite 红发生在 **server 相位 fan-out 之初**（`# tests 274 / pass 2 / fail 1 / cancelled 271`），故
`with-memory-cap.sh` 的默认值改动在机理上不可能触发该红。前两轮的「外部 TERM、与本 delta 无因果」结论由此
坐实，而非仅凭「本机派生值仍是 24G」的间接论证。

**本轮独立复验读数（2026-10-10，worktree 已合并 develop `8899027a`）**：
- 自测 `node --test scripts/with-memory-cap-effective-default.test.mjs` → `tests 6 / pass 6 / fail 0`；该测试读的是
  scope 内真实 `/sys/fs/cgroup/memory.max`（非中间 shell 变量），故 6/6 即 AC1/AC2 派生端到端成立。
- 本机 `bash scripts/effective-capacity.sh` → `effective_mem_mb=63224`（cgroup_v2=true）；×75% → clamp 24576M = 24G，
  与改动前字面量逐字一致。
- AC3 负控制：`QUAY_MEMORY_MAX=1G` 失控分配器 → `payload exit=137`，journal
  `ac3rv-*.scope: A process of this unit has been killed by the OOM killer` + `Failed with result 'oom-kill'`。
- AC4：`bash scripts/vitest-heap-limit-check.sh` → `PASS`，exit 0；`npm run typecheck` → exit 0；
  `npm run lint` → exit 0（仅既有 warning）。

**树状态（第三轮）**：worktree 干净；`develop`（`8899027a`）已是 HEAD（合并 commit `c164ec58`）祖先。

**对 `## Needs-Human` 的覆盖说明**：上一轮写下的「⛔ 不再重派」是当时的现场结论；本轮说明该任务已重新派发并
通过上述复验，未发现新的实现缺陷。

**残余观察（不在本任务范围，仅登记，不改）**：默认推导读的是**调用者自己 cgroup** 的 `memory.max`；若某天
test.sh 被外层 scope 包住（如 fleet 的 24G），client 相位内层默认会变成 75%×24G=18G。本任务 AC 只覆盖
「本机/无更紧 cgroup 时默认仍为 24G」，未覆盖该嵌套语义；登记以留痕，不扩大范围。

## Needs-Human

**执行 2026-10-10T09:05:00.007Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：8b654f58-908c-4921-834c-646c66939330
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-with-memory-cap-default-adapts-to-effective-memory~wk-prod-anchor~1791623042602-e7d831.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-with-memory-cap-default-adapts-to-effective-memory-wk-prod-anchor.log
## Needs-Human

**执行 2026-10-10T10:14:36.577Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：95aceac4-eeb3-4a00-9cd8-bed4d194c0bd
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-with-memory-cap-default-adapts-to-effective-memory~wk-prod-anchor~1791627236452-38aff7.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-with-memory-cap-default-adapts-to-effective-memory-wk-prod-anchor.log
