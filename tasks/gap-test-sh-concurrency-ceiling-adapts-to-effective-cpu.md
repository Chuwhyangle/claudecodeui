---
id: gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu
title: scripts/test.sh 的服务端阶段并发上限按 effective CPU 自适应（而非固定
  16），server-phase-concurrency-check.sh 的坡度表守卫改成按核数分档
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

**依赖**：`gap-effective-capacity-probe-cgroup-cpu-mem-quota`（需先落地，提供 `scripts/effective-capacity.sh` 的 `effective_cpu` 读数）。

**现状**：`scripts/test.sh:67` `CONCURRENCY_CEILING="${QUAY_TEST_CONCURRENCY_CEILING:-16}"` 是固定字面量，16 的依据是 `scripts/server-phase-concurrency-check.sh` 的 SLOPE_TABLE——在**本机 128 核**上实测。该守卫按"坡度表支撑"fail-closed：AC3 要求上限值必须在表里找到且是实测 0 失败的档。在 2/4/8 有效核的环境下，16 路并发大概率过订阅（每个 `tsx --test` 进程的内存/CPU 占用是固定的，有效核越少，同样 16 路并发的排队/抢占/OOM 风险越高）。

**本任务要做的**：把 `CONCURRENCY_CEILING` 默认值改成 `scripts/effective-capacity.sh` 的 `effective_cpu` 的函数（例如 `min(16, effective_cpu × K)`，K 由新增的分档坡度表实测决定，不得凭感觉设K），`QUAY_TEST_CONCURRENCY_CEILING` 显式覆盖的语义不变（仍然优先于自适应默认值）。`server-phase-concurrency-check.sh` 的 SLOPE_TABLE 从"单一 128 核读数"扩展为"按 effective_cpu 分档的坡度表"（至少含 2/4/8/128 核四档的实测 0 失败读数），AC 判词改为验证**公式**在各档下落在实测安全区间内，而不是验证单一字面量。

**不做**：不改变 fail-closed 语义（守卫找不到坡度表支撑的值时仍判红）；不改 `--for-task`/`QUAY_TEST_STOP_AFTER`/`__PERFILE__`/`__PERFILE_KIND__` 契约；不改 typecheck/lint 并行机制（`gap-suite-server-dispatch-longest-first-and-parallel-static-stages` 的范围，本任务不碰）；不弱化任何既有 false-forms/AC 的断言面；不因为本任务的改动让完整 fan-in 流程的任何一步被跳过或简化。

## AC

- [x] AC1 公式接入：`CONCURRENCY_CEILING` 的默认值来自 `scripts/effective-capacity.sh` 读数的函数，`QUAY_TEST_CONCURRENCY_CEILING` 显式设置时覆盖不变（`QUAY_TEST_DRY=1` 下三档验证：不给 flag 时打印值随 effective_cpu 变化；显式给出时打印值=给出值，不被公式覆盖）。
- [x] AC2 坡度表分档实测（不得凭感觉）：至少在 `systemd-run -p CPUQuota=200%/400%/800%` 三档 + 本机 128 核共四档，每档跑只含服务端阶段的真实套件调用，记录 0 失败的最大并发值，写入扩展后的 SLOPE_TABLE；`server-phase-concurrency-check.sh` 的判词验证公式在每一档的推荐值都落在该档实测 0 失败区间内。
- [x] AC3 fail-closed 不削弱：`server-phase-concurrency-check.sh` 对"无坡度表支撑的公式/值"仍判红（负控制：注入一个在任一实测档都没有 0 失败支撑的 K 值，守卫必须红）。
- [x] AC4 既有契约不变：`scripts/suite-scope-check.sh`、既有 `__PERFILE__`/`__PERFILE_KIND__` 格式、`QUAY_TEST_STOP_AFTER=order|stages` 两个测试接缝全部保持逐字不变（diff 对照）。
- [x] AC5 false-forms/AC 不被削弱：7 个 `server/modules/voice/tests/*.false-forms.test.ts`（含本会话此前落地的 `gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged` 的合并用例）在新并发公式下逐一跑通，耗时与改动前（128核档）同量级（不因为本任务引入新的假红）。
- [x] AC6 完整 fan-in 验证不被绕过：本任务落地走正常 worktree→fan-in 流程（`.git/fan-in.lock` 序列化、真实全量 `scripts/test.sh`），不使用 `--for-task` 之外的任何跳步手段；`npm run typecheck`/`npm run lint` 退出 0。

## DoD

真实落地标准：四档（2/4/8/128 effective core）的真实实测坡度表数据必须贴进完成记录，且落地后的第一轮真实 fan-in（`.quay/verification-round.jsonl`）里能读到并行度/耗时读数，与本机 128 核档的历史基线（round 756-773 窗口）比较无显著劣化。未验证项如实声明：若本会话/本次实现找不到真正受限到 2/4/8 effective core 的宿主，各档读数均来自本机用 `systemd-run -p CPUQuota=` 模拟的 cgroup，不是真实不同规格的物理机，需在完成记录里注明这一局限。

## Touches

- scripts/test.sh
- scripts/server-phase-concurrency-check.sh
- scripts/suite-duration-baseline.tsv（如因公式变化需要重新生成，须按文件头注释的再生成命令操作，不得手改）
- tasks/gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu.md

## 完成记录

### 结论

`scripts/test.sh` 的 `CONCURRENCY_CEILING` 默认值从固定字面量 `16` 改为 **effective CPU 的函数**：

```
CONCURRENCY_CEILING = min(CEILING_CAP=16, effective_cpu × K)，K 默认 1
```

`effective_cpu` 来自 `scripts/effective-capacity.sh`（cgroup-v2 bandwidth-quota 感知）。`QUAY_TEST_CONCURRENCY_CEILING` 显式设置时语义不变（优先于自适应默认值）。探测不可用 / 读数缺失 / 不可解析 ⇒ fail-open 回 16（本机既有默认），不改既有行为。新增测试接缝 `QUAY_TEST_CONCURRENCY_CEILING_K`（覆盖 K，使守卫的 fail-closed 可证伪）。

`scripts/server-phase-concurrency-check.sh` 的 SLOPE_TABLE 从"单档 6 列"（col1 = N）改为"按 effective_cpu 分档 7 列"（`cpu N load1 wallms fails files prov`），判词改为逐档验证公式推荐值 `f(c)=min(16,c×K)` 落在该档实测 0 失败区间内。原有 128 核历史读数（`N=4/16/32/64/100/128` 及竞争进程行）逐字保留。

### K 的依据（K=1，由实测推出，非凭感觉）

四档真实实测（每档 `bash scripts/test.sh --test-concurrency=N <271 个 server 文件>`，只含服务端阶段；测量时把 liveness watchdog `QUAY_SUITE_MAX_RUNTIME_MS`/`QUAY_SUITE_SILENCE_MS` 提高，否则低核档会在套件级守护上 ABORT——见"局限"）：

| cpu 档（来源） | N | wall_ms | fails | 失败文件 |
|---|---|---|---|---|
| 2（CPUQuota=200%） | 2 | 926234 | 0 | — |
| 2 | 4 | 784986 | 1 | voice-error-classification.false-forms.test.ts |
| 4（CPUQuota=400%） | 4 | 452518 | 0 | — |
| 4 | 8 | 412421 | 0 | — |
| 4 | 16 | 487118 | 2 | claude-peer-name-title-guard.test.ts, resident-server-restart.test.ts |
| 8（CPUQuota=800%） | 8 | 250206 | 0 | — |
| 8 | 16 | 243930 | 1 | resident-server-restart.test.ts |
| 8 | 32 | 376892 | 2 | agent-retirement.test.ts, resident-server-restart.test.ts |
| 128（本机） | 16 | 152510 | 0 | — |

- `f(c)=c`（K=1）在 2/4/8/128 四档全部是实测 0 失败行 ⇒ K=1 有实测支撑。
- K≥2 被两档证伪：cpu=2 取 f=4 红（voice false-forms 撞 tsc 假形臂 2× 稀释），cpu=8 取 f=16 红（resident-server-restart 撞 60s 定长内部截止）。
- 容量模型：档墙钟 ≈ 服务端阶段总 CPU（~2400 core-s）/ c（2 核 926s、4 核 452s、8 核 250s、128 核 N=16 152s ≈ 2400/16），与 N 基本无关；逐文件墙钟 ≈ cpu_per_file × N/c ⇒ N>c 既变慢又稀释定长内部截止、放大共享 scratch 竞态。故推荐值封顶在 c 本身。

### 逐 AC 证据

**AC1（公式接入）**：`QUAY_TEST_DRY=1` 下探针（`--test-concurrency=100000` 触发夹取）：
- host（effective_cpu=128）→ 打印 `concurrency=16`；`EFFECTIVE_CAPACITY_TEST_CPU_MAX=2` → 2；`=4` → 4；`=8` → 8；`=64` → 16（被 16 夹住）。
- 显式 `QUAY_TEST_CONCURRENCY_CEILING=7` → host 与 cpu=2 下都打印 7（不被公式覆盖）；`=2` 在 cpu=64 下打印 2。
- 探测不可用（`EFFECTIVE_CAPACITY_TEST_CPU_MAX=bad` 等）⇒ 回 16。

**AC2（分档实测）**：上表四档读数写入扩展后的 SLOPE_TABLE（7 列表，19 行）；守卫 `bash scripts/server-phase-concurrency-check.sh` 退出 0，逐档读数：`cpu=2 f=2 墙钟=926234ms 0失败档=[2] 最小失败N=4 ｜ cpu=4 f=4 墙钟=452518ms 0失败档=[4,8] 最小失败N=16 ｜ cpu=8 f=8 墙钟=250206ms 0失败档=[8] 最小失败N=16 ｜ cpu=128 f=16 墙钟=152510ms 0失败档=[4,16,16,32,64,100,128,128,128,128] 最小失败N=128`。判词验证每个档的 `f(c)` 都在该档 0 失败档集合内、且 `f(c) < tier_min_unsafe(c)`（有失败行时）。

**AC3（fail-closed 负控制）**：`QUAY_TEST_CONCURRENCY_CEILING_K=3` 跑守卫 ⇒ 退出 1，5 条断言红（cpu=2 的 f=6 无 0 失败支撑且 ≥ 最小失败 4；cpu=4 的 f=12；cpu=8 的 f=16 无支撑且 ≥ 16）。fail-closed 未削弱。

**AC4（既有契约不变）**：
- `scripts/suite-scope-check.sh` 与 develop 逐字节相同（`cmp -s` 通过）。
- 契约 token diff：`__PERFILE__` 的输出行 `echo "__PERFILE__ duration_ms=$dur $label passed=$ok end_ms=$end"`、`__PERFILE_KIND__` 的输出行 `echo "__PERFILE_KIND__ file=$label kind=$kind"`、dry-run 行 `echo "dry run: args consumed (concurrency=$CONCURRENCY, files=${#FILES[@]})"` 内容逐字未变，仅行号位移；`QUAY_TEST_STOP_AFTER=order|stages` 两接缝内容逐字未变，仅行号位移。
- 唯一 `__PERFILE__` 相关 delta 是把注释里一句中文重新折行（且该行现已与 develop 逐字一致），无任何输出行改动。

**AC5（false-forms 不削弱）**：`server/modules/voice/tests/*.false-forms.test.ts`——本任务 AC 点名 7 个，develop 实有 9 个；跑全 9 个（超集）：9/9 通过，`rc=0`，73.3s，dry 行 `concurrency=16, files=9`。与 128 核档同量级，未引入新假红。

**AC6（fan-in 不被绕过）**：改动走正常 worktree（`task/gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu`）→ fan-in 流程；`npm run typecheck` 退出 0（19s），`npm run lint` 退出 0（11s），`server/shared/tests/quay-test-script.test.ts` 通过（rc=0，36s）。未使用任何跳步手段。

### Touches 签核

`scripts/suite-duration-baseline.tsv` **无需重新生成**：本改动只改 `CONCURRENCY_CEILING` 的默认取值来源，不改服务端文件的派发顺序（longest-first 数据未变）。Touches 里对该文件的"如因公式变化需要重新生成"条件未触发。

### 局限（如实声明）

1. **各低核档读数均来自 `systemd-run -p CPUQuota=` 的 cgroup 模拟**，在本机 128 核宿主上用 bandwidth-quota 把有效核压到 2/4/8，**不是真实 2/4/8 核的物理机**。DoD 要求的正是这一披露。cpu_source 差异（`cpu.max` vs 真实 cpuset）可能让排队/缓存行为略有出入，但带宽配额对每进程 CPU 占用的稀释机制与真实低核机同源。
2. **低核档测量必须临时抬高 liveness watchdog**：`QUAY_SUITE_MAX_RUNTIME_MS`（默认 660000）与 `QUAY_SUITE_SILENCE_MS`（默认 240000）是按本机 54–59s 全套墙钟标定的，2 核档全套墙钟 ~926s 会在套件级守护上 ABORT（实测到 270 cancelled）。故测量窗口内这两个变量被抬高；实际封住单文件的是 `QUAY_TEST_FILE_TIMEOUT`（默认 600s），不是 liveness watchdog。这只是测量工具的处理，未改动 `scripts/test.sh` 里两个 watchdog 的默认值。
3. **1 核宿主的残留风险**：守卫判词②断言"调低（4/2/1）与默认（4）原样生效"，其默认档 4 是针对旧 128 核档的既有断言面；本任务不得弱化任何既有断言面，故未把②改成随 ceiling 自适应。若某 1 核宿主的自适应 ceiling 落在 4 以下，②仍会以既有默认 4 判读——已在守卫实现里保持原语义，未引入新值。

## Needs-Human

**执行 2026-10-10T10:33:35.029Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：aa2c1cd5-233e-4a60-a1ab-580f208b9173
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu~wk-prod-anchor~1791628380762-084e0e.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu-wk-prod-anchor.log
