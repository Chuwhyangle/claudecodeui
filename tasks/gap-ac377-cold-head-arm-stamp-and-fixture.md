---
id: gap-ac377-cold-head-arm-stamp-and-fixture
title: AC-377 冷队首回归（S0）：armRound 在无在飞 turn 时给冷/空闲 round 立即写
  resultsSeenAtStart，并建
  server/modules/providers/tests/claude-resident-cold-head-merge.test.ts 逐帧回放
  fdd3e920 序列（含 later 排空合并反例与假形态对照）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-377
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本回合实测，2026-10-16）：`grep -rln "^goal_ac: AC-377" tasks/*.md` → **0** 命中；全库 `grep -rln "AC-377" tasks/` → **0** 命中（唯一命中在 `.quay/gate-events.jsonl`，那是 AC-377 自己的验收日志，不是任务）。同一机制的历史邻居均已 `done`：`gap-resident-merged-queued-turn-leaves-stale-run-running`（10-13 的 `resultsSeenAtStart` 合并扫描本体）与 `gap-ac275-claude-resident-control-queue`（控制队列撤回）。本任务是叠在那一层之上的**冷队首残留洞**——不是同一机制的重复，也不是它的续做。合并候选检查 `task-granularity-advice.js --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/providers/tests/claude-resident-cold-head-merge.test.ts --json` → `peers: []`，无 Touches 重叠的在飞任务。

### 机制（SPEC §1.2、§1.3、§12 S0）

run 的身份存在两本账、靠**位置**对账：注册表每次 send 开一个 run（`chat-run-registry.service.ts`），宿主 driver 用 `state.rounds[]` FIFO（`claude-host-driver.provider.ts`），帧发给 `state.rounds[0].writer`，每个 `result` 只 `shift()` 一个 round 并给它的 writer 写 `complete`。10-13 的修复在这之上叠了第二层位置代理 `resultsSeenAtStart`——「该 round 的消息被 dequeue 时，已经有几个 turn 结束了」——让 `result` 能结算 CLI **折进同一个 turn** 的多个 round。

洞在于：`armRound` 建 round 时 `resultsSeenAtStart: null`（`claude-host-driver.provider.ts:3486`），而**唯一**给它赋值的写者在那段 `command_lifecycle started` 的处理里，且要求 `candidate.queuedUuids.includes(commandUuid)`（`:4343-4348`）。`queuedUuids` 只在**忙时**才压入（`armRound` 里 `busy = state.rounds.length > 0 || Boolean(state.unattended)`，`:3535`；压栈在 `:3539`）。于是**冷启动（或空闲）时 arm 的 round** `queuedUuids` 恒为空，`started` 到来时那个 `owningRound` 永远找不到它，值恒为 `null`；`result` 处理里 `if (finished.resultsSeenAtStart !== null)`（`:4648`）把整段合并扫描跳过。而 voice 忙时发送被 CLI **折进正在跑的 turn** 是常态，于是「冷 round 在队首 + 后来者折进它的 turn、只出一个 `result`」让 FIFO **永久领先一格**：此后每个 turn 结束只关掉前一条消息的 run，最新那个永远 `running`、`turn` lease 一直挂着——界面底部的 `Working…` 在 turn 结束后持续存在（会话 `fdd3e920-2b90-4af5-abf5-fe69559e1b9d` 实测 1h59m）。

SPEC §1.3 的因果对照：只在 `armRound` 加三行（无在飞 turn 时 arm 的 round 立即写 `resultsSeenAtStart = state.resultTimes.length`）后，同一探针五行读数全部归零。**这三行是 S0 的全部内容**，独立于 S1 及之后的账本重写，落地后回退即还原。

### 交付（两件，同一任务）

1. **S0 热修**（`server/modules/providers/list/claude/claude-host-driver.provider.ts`，`armRound` 内）：在 `if (!alreadyQueued)` 分支、`busy` 已经读出来之后，当**没有在飞 turn**（即 `!busy`）时，把该 round 的 `resultsSeenAtStart` 就地写为 `state.resultTimes.length`。`busy` 已经在 `:3535` 读出并用于 `queuedInputs` 的 `resultsSeenAtPush`，两个读数必须同源（同一瞬时），不得各读一次 `state.resultTimes.length`。`alreadyQueued`（冷启动那条已经先 seeding 过队列的路径）也要覆盖——冷启动正是本洞的触发形态，不要只改 `!alreadyQueued` 一支而漏掉它。

2. **回归夹具**（新文件 `server/modules/providers/tests/claude-resident-cold-head-merge.test.ts`）：scripted fake 进程（注入的 `createProcess` 缝）+ **真实** `ClaudeResidentHostDriver`，逐帧回放 SPEC §1.2 的序列表，不碰真实 `claude` 二进制。夹具形状照兄弟文件 `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts`（同一个 scripted 臂的骨架：真 `chat` 连接 / 真 writer / 真 `listRunningRuns()` 读数），但本文件只需 scripted 臂，**不要**搬那份文件里的真实 `claude` 二进制臂（AC-377 明确「不碰真实 claude 二进制」，且预算只有 20s / 单文件）。

### 判据要点（AC-377 criterion 的四条腿，逐字见 AC 记录）

- **(a)** 冷 M1 在飞 → 忙时 M2、M3 在 M1 的 `result` **之前**先后 `started`（被 CLI 折进同一 turn）→ 只来一个 `result`：`roundsOpen=0 turnLeasesOpen=0`，且 `completes=M1:1 M2:1 M3:1`。
- **(b)** 紧接空闲发送 M4、M5，各自 `queued→started→result`：每条结束后 `roundsOpen=0`，其自己 writer 的 `complete` 恰为 1，逐 writer 计数——M4 的 `complete` 不得落在 M3 的 writer 上，M5 的不得落在 M4 的 writer 上。
- **(c)** 反例（**不得过度结算**）：冷 A 在飞，B 与 C 在 A 的 `result` **之后**才同批 `started`（later 排空合并）：A 的 `result` 只结算 A（`roundsOpenAfterFirstResult=2`），合并 `result` 之后 B、C 各 1 个 `complete`、`roundsOpen=0`。
- **(d)** 取假形态：把 arm 时给冷/空闲 round 打 `resultsSeenAtStart` 的那一处**临时**去掉 → (a) 必须红在 `roundsOpen` 或 `completes` 读数上（**不是别的腿先红**）；用后还原。
- **(e)** 单文件单次运行 < 20s。

红线：每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；每条腿用**同一个写者计数**读数面，否则「任何 `result` 一律清空整个 FIFO」这种过度修复会过 (a) 而红 (c) 才被发现；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。

操作注记：新增一个 server 测试文件会让 `server/shared/tests/quay-test-script.test.ts` 的基线覆盖率相对下降一格（该断言的地板是 90%，当前有富余）；若它因此报红，按该测试自身的口径处置。跑测试遵守 `AGENTS.md`：**单文件直接跑**，不做无界多文件 `--test` fan-out。

## AC

- [ ] (a) 腿绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-cold-head-merge.test.ts` 退出 0，且标准输出含 `roundsOpen=0`、`turnLeasesOpen=0`、`completes=M1:1 M2:1 M3:1`。
- [ ] (b) 腿在同一次运行内绿：输出含 M4、M5 各自的逐 writer `complete` 计数（各恰 1），且 M4 的 `complete` 不落在 M3 的 writer、M5 的不落在 M4 的 writer；每条空闲 send 结束读数后 `roundsOpen=0`。
- [ ] (c) 反例腿在同一次运行内绿：输出含 `roundsOpenAfterFirstResult=2`，且合并 `result` 之后 B、C 各 1 个 `complete` 并 `roundsOpen=0`。
- [ ] (d) 假形态对照可复现：临时去掉 arm 时给冷/空闲 round 打 `resultsSeenAtStart` 的那一处后重跑 (a) 腿退出**非 0**，且红色落在 `roundsOpen` 或 `completes` 读数上；随后还原该处、重跑恢复绿。
- [ ] (e) 该判据文件单次运行墙钟 < 20s（以本回合计时为准）。
- [ ] S0 热修只改 resident driver 的 arm 时戳记，对外零语义变化：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 仍全绿。
- [ ] 遵守 `$backend-module-standards`：测试落在 `server/modules/providers/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」）：在交付的树上跑 `server/modules/providers/tests/claude-resident-cold-head-merge.test.ts`，它经**真实 `ClaudeResidentHostDriver` + 注入的 scripted `createProcess` 缝**把会话 `fdd3e920` 的序列逐帧走一遍——冷 M1 的 `queued/started`、M2 与 M3 在 M1 的 `RESULT` 之前 `started`、单个 `result` 收尾——读到每个 run 恰一条其自己 writer 的 `complete`、`roundsOpen=0` 与 `turnLeasesOpen=0`；随后两条空闲 send（M4、M5）各自结算到自己，不再差一格。反例臂读出 `roundsOpenAfterFirstResult=2`，证明修复没有把「later 排空合并」误判成「冷队首合并」。假形态腿（去掉 arm 时戳记）把 (a) 打红、还原后恢复绿——即红的是读数本身，判据有洞会被看见。全程不启真实 `claude` 二进制；`git diff` 只含 driver 的 arm 时戳记三行与这一个新测试文件，以及本任务的 task 文件。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （S0：`armRound` 无在飞 turn 时给冷/空闲 round 立即写 `resultsSeenAtStart`）
- `server/modules/providers/tests/claude-resident-cold-head-merge.test.ts` （新：AC-377 判据文件，逐帧回放 fdd3e920 序列 + later 合并反例 + 假形态腿）
- `tasks/gap-ac377-cold-head-arm-stamp-and-fixture.md` （自触）
