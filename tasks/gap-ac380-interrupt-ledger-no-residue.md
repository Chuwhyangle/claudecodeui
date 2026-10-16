---
id: gap-ac380-interrupt-ledger-no-residue
title: AC-380 interrupt 无残留（S1 账本上的 interrupt 语义）：interrupt 只向 CLI 请求不改账、在飞命令
  cancelled(reason=interrupt)、turn aborted、排队命令照常开新 turn；CLI 已空闲时不出现
  `turnLeasesOpen=0 且 roundsOpen>0` 的分裂读数，超 T_int 无 RESULT 记
  `interrupt-no-result` 异常；交付
  server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts（含取假形态）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac378-ledger-invariants-property-test
goal_ac: AC-380
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: AC-380' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-380' tasks/` → **0** 命中 ⇒ 无 todo/ready/needs-human 任务认领 AC-380。机制词 grep：`interrupt-no-result` → **0** 命中（该异常码全库尚不存在）；`interruptRequested` → 只命中 `gap-ac378-ledger-invariants-property-test`（S1 账本转移表里的一行描述，非 interrupt 判据）。合并候选（`node .claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --root <主检出> --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts --json`）报 `peers: [gap-ac377-cold-head-arm-stamp-and-fixture (ready), gap-ac378-ledger-invariants-property-test (ready)]`，共享文件同为 resident driver。判定 **separate**：AC-377（S0 热修）与 AC-378（S1 账本 + 性质测试）各有自己的判据文件与独立验收，本条是 interrupt 语义的**独立判据**（SPEC §15 为 AC-380 单列一个判据文件），且 AC-378 已 `ready` 即将派发，合并只省一次固定开销却把两条 AC 的验收搅在一起。本条的读数面（`turn.interruptRequested` 与账本投影）由 AC-378 的 S1 账本给出，故在任务层以结构化字段声明它与 AC-378 的先后（quay 对 Touches 重叠的任务本就按 Touches 串行），正文不再复述这层关系。

### 机制（SPEC §2 C-5、§5.2、§6.3、§10）

现状 `interrupt()`（`server/modules/providers/list/claude/claude-host-driver.provider.ts:2474`）在向 CLI 请求之后**直接改账**——`round.interrupted = true; await stopResidentTurn(state.process.query); state.sink.leaseRemoved(appSessionId, 'turn')`——而该 round 留在 `state.rounds` FIFO 里不动。CLI 其实已空闲（不会有 RESULT）时，最后一行就把 turn lease 摘成 0，round 却永不 `shift()`：留下 `turnLeasesOpen=0` 且 `roundsOpen>0` 的**分裂读数**——账本侧没有 lease，注册表那座 run 仍 `running`，没有任何后续帧能收口（SPEC §6.3；§10.1 `phantom-run` 的前身；界面底部 `Working…` 在 interrupt 后残留）。

SPEC §5.2 转移表「interrupt 请求」行与 §6.3 的修法：interrupt **只做两件事**——向 CLI 发一次 interrupt、置 `turn.interruptRequested = true`；**账本不直接改任何状态**（不合成终态、不摘 lease）。状态全部由随后的帧驱动：在飞命令的 lifecycle `cancelled` 给出该 delivery 的 `cancelled(reason=interrupt)`（C-5），`RESULT(is_error)` 给出 turn 的 `aborted`；§5.3 顺序无关——两者先后不固定、互不等待，一致性靠 I4 的 owed 交叉核对。lease 由账本投影重算（§5.4），interrupt 本身不再碰它。排队命令不受影响：它在新 turn 里照常 `started → 新 init → RESULT → completed`。若置位后超过 `T_int`（默认 5 s）仍无 RESULT ⇒ 以 `interrupt-no-result` 异常记入 §10.2 形状的日志（S1 起 `mode=log`；`enforce` 是 AC-390 的事），不得静默留残；RESULT 一到即清该定时器。

### 交付（两件，同一任务）

1. **interrupt 收口**（`server/modules/providers/list/claude/claude-host-driver.provider.ts`）：把 `interrupt()` 改成只向 CLI 请求 + 置 `interruptRequested`，**不再** `leaseRemoved`；再加一个 `T_int` 看门狗，置位后超时仍无 RESULT 就发一行 §10.2 形状的异常（`[reconcile] session=<app> mode=log anomaly=interrupt-no-result detail=…`），RESULT 到达时清掉。若 AC-378 的 S1 账本已把「interrupt 只请求」与投影重算落地，本条只补 `T_int` 看门狗与异常行，**不要重写账本**（重复实现会与 AC-378 的落点冲突）。`T_int` 若做成 driver 可注入项（`ClaudeResidentHostDriverOptions`，driver 文件内）就用小值，避免为一条腿付 5 s 墙钟。

2. **判据文件**（新文件 `server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts`，AC-380 判据）：**scripted fake 进程**（注入的 `createProcess` 缝）+ **真实** `ClaudeResidentHostDriver`，骨架照兄弟文件 `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 的 scripted 臂（真 driver / 真 writer / `listRunningRuns()` / `driver.busyInputReading().roundsOpen` / `turnLeaseCount(manager, SESSION_ID)`），**不要**搬那份文件里的真实 `claude` 二进制臂（AC-380 明确「scripted fake 进程 + 真实 driver」，且不启真实二进制）。四条腿 (a)–(d) 逐字见下。

### 假形态（AC (d) 为什么承重）

把 `interrupt()` 临时改回旧实现（`leaseRemoved` 而不动账本）⇒ (b) 腿必须红在 `turnLeasesOpen=0 roundsOpen=1` 这条读数上。这是我们**已知的现行缺陷签名**，判据必须能在它身上变红；红落在别的腿（超时、更早的断言、别的读数）不算数。

## AC

- [x] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印 (a) 腿：在飞 turn 且有一条排队命令时调 interrupt，**interrupt 返回后**读到 `inFlightLeaseAtInterrupt=1`（账本未合成终态、lease 仍在）；随后喂 `RESULT(is_error)` 与在飞命令的 `cancelled`，读到 `inFlightDelivery=cancelled reason=interrupt`、`inFlightTurn=aborted`；排队命令走 `started → 新 init → RESULT → completed`，逐 run `complete` 计数各恰 1（`completes=…`，不得为 0 或 2）；静止后打印**同一行**含 `roundsOpen=0 turnLeasesOpen=0`（逐字，不得折行）。
- [x] (b) 同一次运行内另有一条腿：CLI **其实已空闲**（不会有 RESULT）时 interrupt，**调用返回后**不得出现 `turnLeasesOpen=0` 与 `roundsOpen>0` 同时成立的分裂读数（打印一致读数，例如 `idleAfterInterruptRoundsOpen=1 idleAfterInterruptTurnLeasesOpen=1`；打印成 0/1 分裂即红）；且超过 `T_int` 仍无 RESULT 时标准输出含 `interrupt-no-result` 的异常行（§10.2 形状）；另有一条 RESULT 及时到达的对照腿，**不**出现该异常行。
- [x] (c) 同一次运行内打印 `cliInterruptWrites=1`：每次 driver `interrupt()` 只向 CLI 写一次请求（对 fake 进程 `query.interrupt` 计数），且该路径不调用 `leaseRemoved(…, 'turn')`（打印 `leaseRemovedDuringInterrupt=0`），turn lease 读数不因 interrupt 自身改变。
- [x] (d) 取假形态可复现：把 `interrupt()` 临时改回旧实现（调用 `leaseRemoved(appSessionId, 'turn')` 而不动账本），判据文件一字不动，重跑 (b) 腿 ⇒ 退出**非 0**，且红落在 `turnLeasesOpen=0 roundsOpen=1` 这条读数上（**不是别的腿先红**）；用后还原、重跑 (a)/(b) 恢复绿。逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含该临时代码。
- [x] (e) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [x] (f) 不使既有判据变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 退出 **0**，且该文件在 `git diff --name-only` 里不出现。
- [x] (g) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 346，以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（AC2 的 `known=3 unknown=343`、AC3 的 `known=1 unknown=345`，即 `base+1`）各 +1，并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动，免得给 diff 添未声明文件）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (h) 遵守 `$backend-module-standards`：判据落 `server/modules/providers/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts`——它经**注入的 scripted `createProcess` 缝 + 真实 `ClaudeResidentHostDriver`**：(a) 造一个在飞 turn 加一条排队命令、调 interrupt，**先**读到 turn lease 仍在（账本没合成终态），**再**喂 `is_error` 的 RESULT 与在飞命令的 `cancelled`，读到该 delivery `cancelled(reason=interrupt)`、其 turn `aborted`，排队命令在新 turn 里完成、每个 run 恰一条自己 writer 的 `complete`，静止 `roundsOpen=0 turnLeasesOpen=0`；(b) CLI 空闲时 interrupt 不再留下 `turnLeasesOpen=0 roundsOpen>0` 的分裂态，超 `T_int` 无 RESULT 时真的打出 `interrupt-no-result` 异常行（及时 RESULT 的对照腿不打出）；(c) 一次 interrupt 只写一次 CLI 请求、不摘 lease；(d) 假形态（改回直接 `leaseRemoved`）把 (b) 打红在 `turnLeasesOpen=0 roundsOpen=1` 上、还原后恢复绿——即红的是读数本身，判据有洞会被看见。全程不启真实 `claude` 二进制；`git diff` 只含 driver 的 interrupt 收口（含 `T_int` 看门狗）、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （interrupt 收口：只向 CLI 请求 + 置 `interruptRequested`、不直接改账；`T_int` 看门狗与 `interrupt-no-result` 异常行）
- `server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts` （新：AC-380 判据文件——scripted fake 进程 + 真实 driver 的 (a)–(d) 四条腿 + `T_int` 异常行）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac380-interrupt-ledger-no-residue.md` （自触）
