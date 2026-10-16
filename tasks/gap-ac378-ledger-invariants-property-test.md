---
id: gap-ac378-ledger-invariants-property-test
title: AC-378 账本不变量性质测试（S1）：在 resident driver 内落地 delivery/turn 账本（取代 rounds[]
  FIFO 与位置对账），并交付
  server/modules/providers/tests/claude-resident-ledger-invariants.test.ts（种子化
  ≥200 序列断言 I1–I6 + 两处取假形态）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-378
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: AC-378' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-378' tasks/` → **0** 命中，`grep -rln 'GOAL-045' tasks/` → **0** 命中 ⇒ 无 todo/ready/needs-human 任务认领 AC-378，GOAL-045 其余 AC 亦无在飞任务。合并候选（`node .claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --root <主检出> --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/providers/tests/claude-resident-ledger-invariants.test.ts --json`）报 `peers: [gap-ac377-cold-head-arm-stamp-and-fixture (todo)]`，唯一共享文件是同一条 resident driver；判定 **separate**：那是 SPEC §12 的 S0 热修（`armRound` 冷队首三行时戳记，SPEC 明写「独立于后续所有阶段」），本条是 S1 账本重写 + 性质测试 —— 两条 AC、两套验收；调度器按 Touches 串行，合并省不下并行度。

### 机制（SPEC §1.2 / §2 / §4.4 / §5 / §11 / §12 S1）

现状 run 的身份存在**两本账、靠位置对账**：注册表每次 send 开一个 run（`chat-run-registry.service.ts`），driver 用 `state.rounds[]` FIFO（`claude-host-driver.provider.ts`），`result` 只 `shift()` 一个 round，并靠 `resultsSeenAtStart`（10-13 叠的第二层位置代理）把 CLI **折进同一 turn** 的多个命令一并结算（`claude-host-driver.provider.ts:3486`、`:4343`、`:4648`）。生产 SDK 路径实测的 CLI 契约（SPEC §2，C-1..C-6）让位置对账在设计上不可靠：**C-3 终态与 `RESULT` 的先后不固定**、**C-4 `later` 被排空合并成一个 turn**、**C-5 interrupt 只打断在飞命令**。于是一个 turn 结束可能只关掉前一条命令的 run，最新那个永久 `running`、`turn` lease 一直挂着——界面底部 `Working…` 差一格不消失（会话 `fdd3e920` 实测 1h59m）。

SPEC §5 的 S1 修法：driver 内建一份 delivery/turn **账本**（`deliveries: Map<commandUuid, …>` / `foreign` / `turn` / `pendingStart`，§5.1），身份读自 CLI 的 `commandUuid` 与 `init`/`RESULT`，不再由 FIFO 顺序或计数推断。delivery 终态只由 lifecycle 驱动、turn 终态只由 `RESULT` 驱动，两者互不等待，一致性只靠 I4 的 owed 交叉核对（§5.3 顺序无关）。`lease` 不再手工配平，每次账本变更后**重算**（§5.4，取代现有 5 处 `leaseAdded` / `leaseRemoved`：`:2487`、`:3048`、`:3559`、`:4662`、`:4697` 附近）；`roundsOpen` / `busyInputReading` 等既有读数接口**形状不变**、由账本计算。S1 对外**零语义变化**（§12 N-1）：注册表仍每次 send 一个 run；delivery 的 activity 快照与 run=turn 是 S2 的事，本条不碰。实现遵守 `$backend-module-standards`。

### 交付（两件，同一任务）

1. **S1 账本**（`server/modules/providers/list/claude/claude-host-driver.provider.ts`）：按 §5.1/§5.2 转移表落地账本，取代 `state.rounds[]` FIFO、`resultsSeenAtStart`、`resultTimes` 位置逻辑与 5 处手工 lease 配平。要点：`send` 写 `pushed` 并令 `processing=true`；lifecycle `queued/started/completed/cancelled` 驱动 delivery 状态（`started` 时 `turn.open` 则绑 `turn.id`，否则进 `pendingStart`；uuid 未知则入 `foreign`）；`system/init` 铸 `turnId`、按 `pendingStart` 是否非空定 `kind`、`turn.open=true`；`RESULT` 关 turn（`is_error ∧ interruptRequested` ⇒ `aborted`）；interrupt **只**向 CLI 发请求并置 `interruptRequested`，**不直接改任何状态**（C-5）；下一个 `started`/`init` 前仍 owed 的 delivery 按 `cancelled(owed-terminal-missing)` 结算并记异常（I4）；进程退出 / host 关闭把未终态 delivery 结算 `cancelled(process-exit)`、开着 turn 结算 `aborted`。

2. **性质测试**（新文件 `server/modules/providers/tests/claude-resident-ledger-invariants.test.ts`，AC-378 判据）：复用 fake 进程夹具（注入的 `createProcess` 缝）+ **真实** `ClaudeResidentHostDriver`，夹具骨架照 `claude-resident-merged-queued-turn.test.ts` 的 scripted 臂（真 driver / 真 writer / `listRunningRuns()` / `busyInputReading().roundsOpen` / `turnLeaseCount`），**不要**搬那份文件里的真实 `claude` 二进制臂。种子化随机生成 ≥200 条交错序列，操作集与终态相对 `RESULT` 的两种先后按 SPEC §2 契约生成（SPEC §11、§15）。**新增 server 测试文件会让 `server/shared/tests/quay-test-script.test.ts` 的基线覆盖率相对下降一格**（地板 90%，当前有富余）；若因此报红，按该测试自身口径处置。跑测试遵守 `AGENTS.md`：单文件直接跑，不做无界多文件 `--test` fan-out；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。

## AC

- [ ] (a) 种子表：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-ledger-invariants.test.ts` 退出 0，标准输出含 `sequences=<n> violations=0`（`n ≥ 200`），且**同一种子跑两次输出逐字相同**（确定性）。
- [ ] (b) 每条序列静止后断言 SPEC §4.4 的 I1–I6：I1 无 running run / 无 turn lease / `processing=false`；I2 每 delivery 与每 turn 恰一终态；I3 帧只进本 turn 的 run 且 `seq` 从 1 连续；I4 仍欠终态的命令至多保持到下一个 turn 开始，否则以 `owed-terminal-missing` 结算并记异常；I5 `init` 无待绑定 `started` ⇔ 无人 turn；I6 lease 数等于由账本重算的投影。
- [ ] (c) 失败时输出**最小反例序列**与违反的**不变量编号**（同一次运行内，(d) 的假形态下可见 `violation=I<n>` 与反例序列）。
- [ ] (d) 取假形态两处：① 把 `result` 的结算临时改回单次 `rounds.shift`（位置对账）⇒ `violations>0`，首个违约为 **I1 或 I2** 且带反例序列；② 把生成器改成违背契约（某命令永不到终态）⇒ 必须被记为 anomaly 或按 I4 结算，**不得静默通过**。两处均用后还原、重跑恢复绿。
- [ ] (e) 该判据文件单次运行墙钟 **< 40s**（以本回合计时为准）。
- [ ] S1 对外零语义变化：既有 6 个钉住 `roundsOpen` / `busyInputReading` 的测试文件（`claude-resident-busy-input.test.ts`、`claude-resident-control-queue.test.ts`、`claude-resident-merged-queued-turn.test.ts`、`claude-resident-name-live-mirror.test.ts`、`claude-resident-name-mirror-latency.test.ts`、`claude-resident-peer-name-refresh.test.ts`）仍全绿。
- [ ] 遵守 `$backend-module-standards`：测试落在 `server/modules/providers/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/modules/providers/tests/claude-resident-ledger-invariants.test.ts`，它经**注入的 scripted `createProcess` 缝 + 真实 `ClaudeResidentHostDriver`** 把 ≥200 条种子化序列走完——冷发送、忙发送 `later`/`next`、CLI 的 `queued`/`started`/`completed`/`cancelled`、`RESULT` 正常与 `is_error`、无人 `init`、interrupt、进程退出——其中折叠命令的**终态相对 `RESULT` 的先后两种都生成**；每条序列静止后账本读数满足 I1–I6，整份打印 `sequences=<n> violations=0`。假形态腿（把 `result` 结算改回单次 `rounds.shift`）把 `violations` 打正、首个违约落在 I1 或 I2 且打印最小反例序列，还原后恢复 `violations=0`；生成器违约腿（某命令永不到终态）被记为 anomaly 或按 I4 结算，不静默通过——即红的是读数本身，判据有洞会被看见。`git diff` 只含 driver 的账本重写与这一个新测试文件，以及本任务的 task 文件。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （S1：账本取代 `rounds[]` FIFO / `resultsSeenAtStart` / `resultTimes` 位置逻辑与 5 处手工 lease 配平）
- `server/modules/providers/tests/claude-resident-ledger-invariants.test.ts` （新：AC-378 判据文件，种子化 ≥200 序列断言 I1–I6 + 两处取假形态）
- `tasks/gap-ac378-ledger-invariants-property-test.md` （自触）