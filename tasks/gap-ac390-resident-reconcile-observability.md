---
id: gap-ac390-resident-reconcile-observability
title: AC-390 对账与可观测（S5）：log 模式只记不改、enforce 模式把幽灵 run 以
  aborted/reason=reconciled 关闭，真实在跑的 turn
  两种模式都不被关；`[reconcile]`/`[ledger]`/`[turn]` 日志带 session= 且 `command_lifecycle
  forwarded` 行补 session=；交付
  server/modules/providers/tests/claude-resident-reconcile.test.ts（含取假形态）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac387-pending-deliveries-from-activity-snapshot
  - gap-ac388-activity-dock-honest-status
  - gap-ac389-escape-abort-guard
goal_ac: AC-390
---
---
id: gap-ac390-resident-reconcile-observability
title: AC-390 对账与可观测（S5）：log 模式只记不改、enforce 模式把幽灵 run 以
  aborted/reason=reconciled 关闭，真实在跑的 turn
  两种模式都不被关；`[reconcile]`/`[ledger]`/`[turn]` 日志带 session= 且 `command_lifecycle
  forwarded` 行补 session=；交付
  server/modules/providers/tests/claude-resident-reconcile.test.ts（含取假形态）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac387-pending-deliveries-from-activity-snapshot
  - gap-ac388-activity-dock-honest-status
  - gap-ac389-escape-abort-guard
goal_ac: AC-390
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -l 'goal_ac: *AC-390' tasks/*.md` → **0** 命中；全库 `grep -ln 'AC-390' tasks/*.md` → 只命中 `gap-ac380-interrupt-ledger-no-residue`（其正文把 `interrupt-no-result` 的 `enforce` 明确留给「AC-390 的事」，是交叉引用不是认领）。机制词 grep：`phantom-run` → **0**；`frame-without-turn` → **0**；`[reconcile]` / `[ledger]` / `[turn]` 日志前缀 → **0**；`mode=log` / `mode=enforce` / `T_q` → **0**（`owed-terminal-missing`、`double-init` 已由 S1 账本落地，见 `claude-host-driver.provider.ts` 的异常记录点）。合并候选（`node .claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --root <主检出> --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/websocket/services/chat-run-registry.service.ts --json`）报 `peers: [gap-ac380-interrupt-ledger-no-residue (ready), gap-ac381-unattended-after-turns (ready), gap-ac382-run-is-turn-resident-init-minted-run (todo), gap-ac383-delivery-activity-snapshot-channel (todo), gap-ac384-processing-single-writer (todo)]`，共享文件为 resident driver 与 chat-run-registry。判定 **separate**：这些是 S1–S2 的出口判据，各有自己的判据文件与独立验收；本条是 S5 的对账与可观测收口（SPEC §15 为 AC-390 单列 `claude-resident-reconcile.test.ts`），且 §10.1 明令「**先只打日志（`mode=log`）观察一段时间无误报后再启用 `mode=enforce`**」——阶段语义与验收面都不同，不合并。与上游各阶段的先后关系用结构化 `depends_on` 表达（见 frontmatter），正文不复述。

### 机制（SPEC §10.1、§10.2、§12 S5）

现状：S1 的账本（`claude-host-driver.provider.ts` 的 `turnLedger`）已能记录 `owed-terminal-missing` 与 `double-init` 两个异常，但 **§10.1 的对账循环本身尚不存在**——`phantom-run`、`frame-without-turn`、`interrupt-no-result`、`late-started-after-unattended-init` 全库 0 命中，`mode=log|enforce`、`T_q`（默认 10 s）也不存在；`[reconcile]`/`[ledger]`/`[turn]` 三类日志前缀全库 0 命中（driver 本身没有任何日志汇，只有 registry 的 `lifecycleLog` 一处）。这正是 fdd3e920 现场「`Working…` 差一格不消失」的**最终防线缺口**：注册表里那座 run 一直 `running`、lease 挂着，没有任何后续帧能收口，而没有对账把这处分歧读出来、写进日志。

SPEC §10.1：在 **`RESULT` 之后**与 **heartbeat（既有 5 s 一拍，`activity-heartbeat.service.ts` 的 `ACTIVITY_HEARTBEAT_INTERVAL_MS`）** 上检查 I1 / I4，读「注册表有 `running` 的 run / lease，而账本静止，持续 > `T_q`（默认 10 s）」⇒ 异常码 `phantom-run`；**先只打日志（`mode=log`）**，观察无误报后再 **`mode=enforce`**——enforce 把幽灵 run 以 `aborted`、`reason: reconciled` 关闭。§10.1 明确**不用 lease 定时过期来「修」**（那会结算真正在跑的 turn、也会掩盖真实积压），所以 enforce 的判定必须**先看 turn 是否已开**：一个已经开了 turn、真实在跑的长 turn，账本并不「静止」，绝不能被关（AC (c)）。

§10.2 日志形状（逐字，`session=` 一律在行内）：

```
[ledger]    session=<app> delivery=<8> state=<s> turn=<8|-> source=<…>
[turn]      session=<app> turn=<8> kind=<delivered|unattended> open|close outcome=<completed|aborted> deliveries=<n>
[reconcile] session=<app> mode=<log|enforce> anomaly=<code> detail=<…>
```

并给既有 `[ChatRunRegistry] command_lifecycle forwarded uuid=… state=… runId=… connections=…` 行补 `session=`（`chat-run-registry.service.ts` 的生产 `lifecycleLog` 目前只有 uuid/state/runId/connections，现场是靠与 transcript 按时间交叉才能把行归到会话——附录 C）。

### 交付（五件，同一任务）

1. **对账循环**（`claude-host-driver.provider.ts` 内新的一段）：复用既有可注入时钟缝 `now?: () => number`，把 `T_q`（默认 10 s）做成 driver 选项（判据用小值 / 注入时钟，不为一条腿付 10 s 墙钟）；在 `RESULT` 与 heartbeat 心跳上跑：读「注册表 running 的 run / lease」与「账本是否静止」，超过 `T_q` 读出一行 `[reconcile] session=<app> mode=<log|enforce> anomaly=phantom-run detail=…`；`mode=log` **只记不改**（注册表与 lease 读数一字不变），`mode=enforce` 才把幽灵 run 以 `aborted`、`reason=reconciled` 关闭。**判据必须能注入一处分歧**（注册表有 running 的 run 而账本静止）——所以「注册表读数」要像已有端口 `connectedClientCount?: () => number` 那样作为**读数端口/入参注入**，**不要**从 driver 里 `import` `modules/websocket`：该文件头与 `claude-resident-unattended-turn.test.ts` 的**结构读数**把 driver 钉死在「零 import of `modules/websocket`」，越界会红那条判据（driver → websocket 会成环）。

2. **其余四个异常码的行**：`owed-terminal-missing`、`double-init`（S1 账本已产出，本条把它们的记录接到 `[reconcile]` 行与日志汇上）、`interrupt-no-result`（若 S1 的 `T_int` 看门狗已落地则接它；否则本条自己补一行看门狗，**不要重复实现**已在的）、`frame-without-turn`（§5.2）——每个码一条与 (a) 同形、`anomaly=<code>` 逐字的行。

3. **`[ledger]` / `[turn]` 日志与 driver 日志汇**：给 driver 加一个**可注入的日志汇**（照 `chat-run-registry.service.ts` 的 `lifecycleLog?: (line: …) => void` 先例，**默认 no-op**，生产在合成根接上 `console.log`——不要在 driver 里直接 `console.log`，否则判据读不到行、生产每会话刷屏），在 turn 开 / 关、delivery 终态、lease 变化各产生**恰好一行**，行内带 `session=<app>`。

4. **`command_lifecycle forwarded` 行补 `session=`**：`chat-run-registry.service.ts` 的 `ChatRunLifecycleForwardLog` 增益一个会话字段（如 `appSessionId`），生产 `lifecycleLog` 行补 `session=<app>`。⚠️ 加宽该类型会红**手搓 stub**：`server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts` 手写了一个四字段收集器并 `log.push(line)`——改字段前先跑它、按需就地修订（结构化推入允许多余字段，但若它按字面断言整行文本则须同步该字面量）。

5. **判据文件**（新文件 `server/modules/providers/tests/claude-resident-reconcile.test.ts`）：scripted fake 进程 + 真实 `ClaudeResidentHostDriver`（骨架照 `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 的 scripted 臂：真 driver / 真 writer / `listRunningRuns()` / `turnLeaseCount(manager, SESSION_ID)`），配合 `createChatRunRegistry({ lifecycleLog })` 的注入实例、注入时钟与注入的注册表读数端口，(a)–(f) 六条腿逐字见下。**不要**搬那份文件里的真实 `claude` 二进制臂。

**类型落位**：新类型的家照本文件既有判据读数类型（`ClaudeResidentLedgerReading`、`ClaudeResidentLifecycleReading`，均**从 driver 文件导出**）的先例留在 `claude-host-driver.provider.ts` 内；日志行类型留在 `chat-run-registry.service.ts` 内（`ChatRunLifecycleForwardLog` 已在那里）。**本任务不新增 `server/shared/types.ts` 条目**（该文件是并发热点，且此处无跨模块消费者）。

### 假形态（AC (f) 为什么承重）

把对账的判定临时改成**不看 turn 是否已开**（只看「注册表有 running 的 run 且账本超过 `T_q` 无变化」就关）⇒ (c) 腿必须红：一个已经开了 turn、正在跑的真实长 turn，会在 heartbeat 多拍之后被 `enforce` 错关。这正是 §10.1 明令不用 lease 过期来「修」的原因——**过结算**。判据必须能在它身上变红；红落在别的腿（超时、更早的断言、别的读数）不算数。

### 边界

- 遵守 `AGENTS.md` 的 `$backend-module-standards`：判据落 `server/modules/providers/tests/`；跨模块只经 `index.ts` barrel；无 `any`。
- 本条**不重启服务**（SPEC §12：生效需重启，由人决定时机；执行者不得自行重启）。
- 单文件单次运行须在 `goal gate` 默认 60 s 内（SPEC §11）；`T_q` 与 heartbeat 一律走注入时钟 / 小值。

## AC

- [x] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-reconcile.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。`mode=log` 腿：注入一处分歧（注册表有 `running` 的 run，而账本静止且超过注入时钟的 `T_q`）⇒ 标准输出**恰好一行**匹配 `^\[reconcile\] session=.* mode=log anomaly=phantom-run( |$)`（计数断言 `reconcileLineCount=1`）；且注册表读数与 lease 读数在注入前后**一字不变**（打印 `runsBefore=runsAfter=1 leasesBefore=leasesAfter=1`，`mode=log` 不得改任何状态）。
- [x] (b) 同一次运行内 `mode=enforce` 腿：同一分歧 ⇒ 幽灵 run 被以 `aborted`、`reason=reconciled` 关闭（打印 `phantomRunOutcome=aborted reason=reconciled`），并记**同一行** `[reconcile] … mode=enforce anomaly=phantom-run`；关闭后注册表读数归零（打印 `runsAfter=0`）。
- [x] (c) 反例腿（两种模式各一次）：turn 已开的真实长 turn（有真实 turn、账本开着不静止），在 `mode=log` 与 `mode=enforce` 下、推进注入时钟使 heartbeat **多拍**（≥3 拍）之后，**都不被关闭**（打印 `longTurnClosed=false longTurnClosed=false`，每拍后 turn lease 仍为 1）。(f) 的假形态必须让这腿红。
- [x] (d) 其余四个异常码各有一个注入用例、各得到**一行**对应记录（逐码计数断言 `lineCount=1`）：`owed-terminal-missing`、`double-init`、`interrupt-no-result`、`frame-without-turn`；每行匹配 `^\[reconcile\] session=.* anomaly=<code>( |$)`，`anomaly=<code>` **逐字**。
- [x] (e1) `command_lifecycle forwarded` 行含 `session=`：经注入的 `createChatRunRegistry({ lifecycleLog })` 转发一帧后，收集到的行文本匹配 `session=<app>`（打印该行）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts` 仍退出 **0**（加宽字段不得红它）。
- [x] (e2) `[ledger]` / `[turn]` 计数断言：一次完整 turn（开 → delivery 终态 → 关）与一次 lease 变化，各产生**恰好一行** `[ledger]` 与**恰好一行** `[turn]`，行内含 `session=<app>`（打印 `ledgerLines=… turnOpenLines=1 turnCloseLines=1`，不得多、不得少）。
- [x] (f) 取假形态可复现：把对账判定临时改成「不看 turn 是否已开」（只看注册表有 run 且账本超 `T_q` 无变化就关），判据文件一字不动，重跑 ⇒ 退出**非 0**，且红落在 (c) 的长 turn 被错关上（**不是别的腿先红**）；用后还原、重跑 (a)–(e) 恢复绿。逐字红态读数、退出码与命令行抄进完成记录，最终 `git diff` 不含该临时代码。
- [x] (g) 该判据文件单次运行墙钟 **< 50s**（`T_q` 与 heartbeat 一律走注入时钟 / 小值，不为判据付 10 s 墙钟）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [x] (h) 不使既有判据变红：`server/modules/providers/tests/claude-resident-ledger-invariants.test.ts`、`server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 各退出 **0**，且二者在 `git diff --name-only` 里不出现。
- [x] (i) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 **349**），把 `server/shared/tests/quay-test-script.test.ts` 两条计数 pin 改为 `known=3 unknown=347` 与 `known=1 unknown=349`（即 `base+1`），并改写其上方注释里的算术（`350 - 3`、`350 - 1`）；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板被新增文件压破 90% 才追加一行（先量，通常不动，免得给 diff 添未声明文件）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (j) 遵守 `$backend-module-standards`：判据落 `server/modules/providers/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/modules/providers/tests/claude-resident-reconcile.test.ts`——它经**注入时钟 + 注入的注册表读数端口 + 注入的日志汇 + scripted fake 进程 + 真实 `ClaudeResidentHostDriver`**：(a) 在 `mode=log` 下注入一处「注册表有 running 的 run 而账本静止超 `T_q`」的分歧，恰好打出一行 `[reconcile] … mode=log anomaly=phantom-run`，且注册表与 lease 读数一字不变（只记不改）；(b) 同一分歧在 `mode=enforce` 下把幽灵 run 以 `aborted`、`reason=reconciled` 关掉、记同一行；(c) 一个已开 turn 的真实长 turn 在两种模式、heartbeat 多拍之后都不被关（防过结算）；(d) 另外四个异常码各得到对应一行；(e) `command_lifecycle forwarded` 行含 `session=`，turn 开 / 关 / delivery 终态 / lease 变化各恰好一行 `[ledger]`/`[turn]`；(f) 假形态（对账忽略 turn 是否已开）把 (c) 打红、还原后恢复绿——即红的是读数本身，判据有洞会被看见。全程不启真实 `claude` 二进制、不重启服务；`git diff` 只含 driver 的对账循环 + 日志汇、`chat-run-registry.service.ts` 的 `session=` 字段与其生产行、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （对账循环 + `T_q` + `mode=log|enforce` + `[reconcile]` 行；driver 可注入日志汇与 `[ledger]`/`[turn]` 行；注册表读数端口）
- `server/modules/providers/tests/claude-resident-reconcile.test.ts` （新：AC-390 判据文件——scripted fake 进程 + 真实 driver + 注入时钟 / 注册表读数端口 / 日志汇，(a)–(f) 六条腿）
- `server/modules/websocket/services/chat-run-registry.service.ts` （`ChatRunLifecycleForwardLog` 增益会话字段、生产 `command_lifecycle forwarded` 行补 `session=`）
- `server/modules/websocket/services/activity-heartbeat.service.ts` （§10.1 的 heartbeat 触发点：在既有 5 s 一拍的 tick 上驱动对账检查；若实现把触发放别处则不改此文件，故列为可能触点）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac390-resident-reconcile-observability.md` （自触）
