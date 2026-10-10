---
id: gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu
title: scripts/test.sh 的服务端阶段并发上限按 effective CPU 自适应（而非固定
  16），server-phase-concurrency-check.sh 的坡度表守卫改成按核数分档
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

**依赖**：`gap-effective-capacity-probe-cgroup-cpu-mem-quota`（需先落地，提供 `scripts/effective-capacity.sh` 的 `effective_cpu` 读数）。

**现状**：`scripts/test.sh:67` `CONCURRENCY_CEILING="${QUAY_TEST_CONCURRENCY_CEILING:-16}"` 是固定字面量，16 的依据是 `scripts/server-phase-concurrency-check.sh` 的 SLOPE_TABLE——在**本机 128 核**上实测。该守卫按"坡度表支撑"fail-closed：AC3 要求上限值必须在表里找到且是实测 0 失败的档。在 2/4/8 有效核的环境下，16 路并发大概率过订阅（每个 `tsx --test` 进程的内存/CPU 占用是固定的，有效核越少，同样 16 路并发的排队/抢占/OOM 风险越高）。

**本任务要做的**：把 `CONCURRENCY_CEILING` 默认值改成 `scripts/effective-capacity.sh` 的 `effective_cpu` 的函数（例如 `min(16, effective_cpu × K)`，K 由新增的分档坡度表实测决定，不得凭感觉设K），`QUAY_TEST_CONCURRENCY_CEILING` 显式覆盖的语义不变（仍然优先于自适应默认值）。`server-phase-concurrency-check.sh` 的 SLOPE_TABLE 从"单一 128 核读数"扩展为"按 effective_cpu 分档的坡度表"（至少含 2/4/8/128 核四档的实测 0 失败读数），AC 判词改为验证**公式**在各档下落在实测安全区间内，而不是验证单一字面量。

**不做**：不改变 fail-closed 语义（守卫找不到坡度表支撑的值时仍判红）；不改 `--for-task`/`QUAY_TEST_STOP_AFTER`/`__PERFILE__`/`__PERFILE_KIND__` 契约；不改 typecheck/lint 并行机制（`gap-suite-server-dispatch-longest-first-and-parallel-static-stages` 的范围，本任务不碰）；不弱化任何既有 false-forms/AC 的断言面；不因为本任务的改动让完整 fan-in 流程的任何一步被跳过或简化。

## AC

- [ ] AC1 公式接入：`CONCURRENCY_CEILING` 的默认值来自 `scripts/effective-capacity.sh` 读数的函数，`QUAY_TEST_CONCURRENCY_CEILING` 显式设置时覆盖不变（`QUAY_TEST_DRY=1` 下三档验证：不给 flag 时打印值随 effective_cpu 变化；显式给出时打印值=给出值，不被公式覆盖）。
- [ ] AC2 坡度表分档实测（不得凭感觉）：至少在 `systemd-run -p CPUQuota=200%/400%/800%` 三档 + 本机 128 核共四档，每档跑只含服务端阶段的真实套件调用，记录 0 失败的最大并发值，写入扩展后的 SLOPE_TABLE；`server-phase-concurrency-check.sh` 的判词验证公式在每一档的推荐值都落在该档实测 0 失败区间内。
- [ ] AC3 fail-closed 不削弱：`server-phase-concurrency-check.sh` 对"无坡度表支撑的公式/值"仍判红（负控制：注入一个在任一实测档都没有 0 失败支撑的 K 值，守卫必须红）。
- [ ] AC4 既有契约不变：`scripts/suite-scope-check.sh`、既有 `__PERFILE__`/`__PERFILE_KIND__` 格式、`QUAY_TEST_STOP_AFTER=order|stages` 两个测试接缝全部保持逐字不变（diff 对照）。
- [ ] AC5 false-forms/AC 不被削弱：7 个 `server/modules/voice/tests/*.false-forms.test.ts`（含本会话此前落地的 `gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged` 的合并用例）在新并发公式下逐一跑通，耗时与改动前（128核档）同量级（不因为本任务引入新的假红）。
- [ ] AC6 完整 fan-in 验证不被绕过：本任务落地走正常 worktree→fan-in 流程（`.git/fan-in.lock` 序列化、真实全量 `scripts/test.sh`），不使用 `--for-task` 之外的任何跳步手段；`npm run typecheck`/`npm run lint` 退出 0。

## DoD

真实落地标准：四档（2/4/8/128 effective core）的真实实测坡度表数据必须贴进完成记录，且落地后的第一轮真实 fan-in（`.quay/verification-round.jsonl`）里能读到并行度/耗时读数，与本机 128 核档的历史基线（round 756-773 窗口）比较无显著劣化。未验证项如实声明：若本会话/本次实现找不到真正受限到 2/4/8 effective core 的宿主，各档读数均来自本机用 `systemd-run -p CPUQuota=` 模拟的 cgroup，不是真实不同规格的物理机，需在完成记录里注明这一局限。

## Touches

- scripts/test.sh
- scripts/server-phase-concurrency-check.sh
- scripts/suite-duration-baseline.tsv（如因公式变化需要重新生成，须按文件头注释的再生成命令操作，不得手改）
- tasks/gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu.md