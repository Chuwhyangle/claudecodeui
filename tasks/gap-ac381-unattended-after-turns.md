---
id: gap-ac381-unattended-after-turns
title: AC-381 无人 turn 识别不被陈旧状态遮蔽：正常 turn（含 next 折叠、later 排空合并）静止后再来无待绑定 started
  的 init 仍判为无人 turn（开 source=unattended、deliveryIds 为空、RESULT 报触发类型恰 1 次、恰一条
  complete、I1 满足），陈旧 round 残留下同判；反例（init 前有 started ⇒ delivered、cron 自造 uuid
  不外露）；交付
  server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts（含取假形态）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac378-ledger-invariants-property-test
goal_ac: AC-381
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-381' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-381' tasks/` → **0** 命中 ⇒ 无任何状态（含 todo/ready/needs-human）的任务认领 AC-381。机制词 grep：`unattended-after-turns` 在 `server/`、`src/` 下 **0** 命中（唯一出现处是 `docs/proposals/resident-delivery-turn-ledger-SPEC.md` §15 验收矩阵的自身表格）；`openUnattendedTurnIfOwn` → 只命中 `claude-host-driver.provider.ts`（定义与调用），无任务认领。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts --json`）报 `peers: [gap-ac377-cold-head-arm-stamp-and-fixture (ready), gap-ac378-ledger-invariants-property-test (ready), gap-ac380-interrupt-ledger-no-residue (todo)]`，共享文件同为 resident driver。判定 **separate**：AC-377（S0 热修）、AC-378（S1 账本 + 性质测试）、AC-380（interrupt 语义）各有自己的判据文件与独立验收，本条是无人 turn 识别（I5）的**独立判据**（SPEC §15 为 AC-381 单列一个判据文件）；合并只省一次固定开销却把两条 AC 的验收搅在一起。本条的读数面（账本对 `init` 的 delivered/unattended 判定、`foreign` 集合）由 AC-378 的 S1 账本给出，故在任务层以结构化字段声明先后（quay 对 Touches 重叠的任务本就按 Touches 串行），正文不再复述这层关系。

### 机制（SPEC §1.4、§4.4 I5、§5.1 / §5.2）

现状 `openUnattendedTurnIfOwn`（`server/modules/providers/list/claude/claude-host-driver.provider.ts:3582`）在 `state.rounds.length > 0` 时直接 `return`（:3593）——只要还有任何一条 round 挂在 `state.rounds` FIFO 上，后续任何 `system/init` 都不再被认成无人 turn。SPEC §1.4 已把这条列为差一格的连带后果**第一条**：陈旧 round（合并 turn 只结算队首、FIFO 永久领先一格）会让后台任务、cron、对端消息引起的无人 turn 全部失去识别，「后台工作完成」的通知也不发。

SPEC §4.4 **I5** 给的判据是**结构性的、与 FIFO 位置无关**：`init` 到来时没有待绑定的 `started`（且无 foreign `started`）⇔ 无人 turn；有待绑定的 `started` ⇔ delivered turn。§5.1 / §5.2 的转移表把这个判定落在账本上：`started` 到来时若 `turn.open` 则绑当前 turn（折叠，C-2），否则进 `pendingStart`；`init` 铸 `turnId`，`kind = pendingStart 非空 ? delivered : unattended`。`pushedUuids` 之外、CLI 自造 uuid 的 `started`（cron 发火，E9 §9.4）进 `foreign` 集合（§5.1「不对外」；§4.3「不进快照、不对外暴露」），其所在 turn 仍为 unattended。

通知侧：`finishUnattendedTurn`（:3966）在 `result` 上读 `origin.kind`——`peer` → 触发类型 `cross-session-message`，其余用开启时从 `Stop` hook 读到的 trigger。CLI 对「宿主层自己的 turn 回报」写的 origin 是 `kind: 'task-notification'`（对应共享词表里的 `background-task`，见 `claude-sessions.provider.ts:1009-1015`）。本条要求 `task-notification` 与 `peer` 两条 origin 都读对触发类型，且**恰好报 1 次**。

### 交付（两件，同一任务）

1. **无人 turn 判定改为 I5**（`server/modules/providers/list/claude/claude-host-driver.provider.ts`）：把 `openUnattendedTurnIfOwn` 的「已有 round 则不开」早退换成账本读数——按 `pendingStart` 是否为空判 delivered / unattended，并让两条边界成立：「已推命令的 `started` 待绑定 ⇒ delivered」，以及「CLI 自造 uuid 的 `started` ⇒ 入 `foreign`、仍判 unattended 且该 uuid 不出现在对外 delivery 读数里」。若 AC-378 的 S1 账本已把 §5.2 转移表的 `pendingStart` / `foreign` / `kind` 落地，本条**只补**判定接线与四条腿的读数面，**不要**重写账本（重复实现会与 AC-378 的落点冲突）。`finishUnattendedTurn` 须让 `task-notification` 与 `peer` 两条 origin 都报出正确触发类型且恰报 1 次。

2. **判据文件**（新文件 `server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts`，AC-381 判据）：**scripted fake 进程**（注入的 `createProcess` 缝）+ **真实** `ClaudeResidentHostDriver`，骨架照兄弟文件 `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 的 scripted 臂（真 driver / 真 writer / `listRunningRuns()` / `driver.busyInputReading().roundsOpen` / `turnLeaseCount(manager, SESSION_ID)`），**不要**搬那份文件里的真实 `claude` 二进制臂（AC-381 明确「scripted fake 进程 + 真实 driver」，且不启真实二进制）。四条腿 (a)–(d) 逐字见下。

### 假形态（AC (d) 为什么承重）

把无人 turn 判定临时改回旧实现（`openUnattendedTurnIfOwn` 里恢复 `if (state.rounds.length > 0) return;`）⇒ (b) 腿（陈旧 round 残留下的同形序列）必须红在 `staleResidueUnattended` 读数上——这正是我们**已知的现行缺陷签名**（SPEC §1.4 第一条），判据必须能在它身上变红；红落在别的腿（超时、更早的断言、别的读数）不算数。

## AC

- [x] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印 (a) 腿：scripted fake 进程 + 真实 `ClaudeResidentHostDriver`，先跑 ≥3 个正常 turn（含一次 `next` 折叠、一次 `later` 排空合并）到静止；再喂一个 `system/init`（此前没有任何待绑定的 `started`）、其后一条 assistant 帧、再到带 `origin.kind=task-notification` 的 RESULT（另一腿用 `peer`）：读到 `unattendedSource=unattended`（开出的 run `source=unattended`）、`unattendedDeliveryIds=0`（`deliveryIds` 为空）、`unattendedNotifications=1`（RESULT 时触发类型恰报 1 次）、该 run 恰一条 `complete`（`unattendedCompletes=1`），静止后**同一行**含 `roundsOpen=0 turnLeasesOpen=0`（I1 满足，逐字，不得折行）；两条 origin 腿各读到正确触发类型（`task-notification` → `background-task`，`peer` → `cross-session-message`）。
- [x] (b) 同一次运行内另有一条腿：用**现行缺陷序列**预置「陈旧 round 残留」（忙时 send 折叠进在飞 turn、CLI 只出一个 `result`，令 `state.rounds` FIFO 领先一格、遗留一个 running round），此后喂同形序列（无待绑定 `started` 的 `init` + assistant + RESULT）仍必须判为无人 turn：打印 `staleResidueUnattended=true`、`staleResidueUnattendedNotifications=1`。若判定像现行实现那样在 `state.rounds.length > 0` 时早退，本条读数必须为 `false` / `0`。
- [x] (c) 同一次运行内打印两条反例：其一，`init` 之前有一条**已推**命令的 `started`（`pushedUuids` 命中、待绑定）⇒ 判为 delivered turn，打印 `deliveredTurn=true unattendedRunsOpened=0`（不得开 unattended run）；其二，cron 形态——CLI 自造 uuid 的 `started`（不在 `pushedUuids`）领先 `init` ⇒ 判为无人 turn，打印 `cronUnattended=true`，且该 uuid **不出现**在对外 delivery 读数里（打印 `foreignUuidInPublicReadings=false`）。
- [x] (d) 取假形态可复现：把无人 turn 判定临时改回旧实现（在 `openUnattendedTurnIfOwn` 恢复 `if (state.rounds.length > 0) return;` 早退），判据文件一字不动，重跑 (b) 腿 ⇒ 退出**非 0**，且红落在 (b) 腿的 `staleResidueUnattended` 读数上（**不是别的腿先红**）；用后还原、重跑 (a)/(b) 恢复绿。逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含该临时代码。
- [x] (e) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [x] (f) 不使既有判据变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 与 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-unattended-turn.test.ts` 各退出 **0**，且这两个文件在 `git diff --name-only` 里不出现。
- [x] (g) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 346，以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（AC2 的 `known=3 unknown=343`、AC3 的 `known=1 unknown=345`，即 `base+1`）各 +1，并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动，免得给 diff 添未声明文件）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (h) 遵守 `$backend-module-standards`：判据落 `server/modules/providers/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts`——它经**注入的 scripted `createProcess` 缝 + 真实 `ClaudeResidentHostDriver`**：(a) 先跑 ≥3 个正常 turn（含 `next` 折叠、`later` 排空合并）到静止，再喂无待绑定 `started` 的 `init` + assistant + RESULT（`origin.kind=task-notification`，另一腿 `peer`），读到开出的 run `source=unattended`、`deliveryIds` 为空、`unattendedNotifications=1`、该 run 恰一条 `complete`，静止后 `roundsOpen=0 turnLeasesOpen=0`（I1）；(b) 用现行缺陷序列预置陈旧 round 残留后，同形序列仍判为无人 turn（`staleResidueUnattended=true`）；(c) 反例两支——`init` 前有待绑定 `started` ⇒ delivered turn、不开 unattended run；cron 形态（CLI 自造 uuid 的 `started`）⇒ 仍判无人 turn 且该 uuid 不出现在对外 delivery 读数里；(d) 假形态（把判定改回「已有 round 则不开」）把 (b) 打红在 `staleResidueUnattended` 上、还原后恢复绿——即红的是读数本身，判据有洞会被看见。全程不启真实 `claude` 二进制；`git diff` 只含 driver 的无人 turn 判定接线、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （无人 turn 判定改为 I5：`openUnattendedTurnIfOwn` 不再按 `rounds.length>0` 早退，改按账本 `pendingStart` / `foreign` 判 delivered / unattended；`finishUnattendedTurn` 的 `origin.kind` 两条触发类型恰报一次）
- `server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts` （新：AC-381 判据文件——scripted fake 进程 + 真实 driver，(a)–(d) 四条腿）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac381-unattended-after-turns.md` （自触）
