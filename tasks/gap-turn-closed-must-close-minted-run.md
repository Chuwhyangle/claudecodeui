---
id: gap-turn-closed-must-close-minted-run
title: turn-closed 只清 writer 不关 run：turn 关闭时必须关闭它铸造的 run，否则幽灵 run 永续
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
<!-- dedup-ref --> 机制去重（立案时实测 2026-10-17）：`grep -rln 'turn-closed\|turnRun = null\|minted run' tasks/*.md` 只命中 gap-ac188-case-budget-red-is-postturn-renavigation-tail 与 gap-ac188-case-bootstrap-collision-and-gate-kill（都是 AC-188 的 case budget 话题，顺带提到「turn 后」），没有一条认领「turn-closed 必须关闭它铸造的 run」。gap-ac390-resident-reconcile-observability（done）是**对账兜底**（enforce 关幽灵 run），本任务是**根因**（turn 关账时就不该丢 run）——两条腿互为纵深、不同机制不同文件，separate。

## Finding

### 缺陷面

一座 turn 铸造的 run，只有 `run-closed`/`turn-result` 效果 → `closeRun` 一条路能关它（claude-host-driver.provider.ts:4744-4752）。而 `closeRun` 第一步 `state.runtimes.get(deliveryId)` 取不到就**静默 return**（:4969-4972）。`turn-closed` 效果只把 `state.turnRun` 置 null（:4759-4765）——它只保证「下一轮帧不写进上一轮 run」，**不保证这座 run 被关闭**。所以只要 per-delivery 那条腿失效（runtime 缺失或 turnWriter 没指对），turn 关了、writer 清了，registry 里的 run 却永远 running。

实测（2026-10-17）：会话 4073c200（Quay-fleet Manager/Driver 自举验收）的 turn 在 04:47:47 结束，但 registry 里它的 run 仍在 running（running 列表 `startedAt 04:47:21.707` 21+ 分钟没动）；快照 `turn.phase=idle`、`turn.runId` 已 null（turn-closed 跑过了），而 running 列表仍列着它——正是「turn 关了、run 没关」的形状。触发点与 `owed-terminal-missing` 相关（该 run 铸造前 25ms 有一条 `delivery 97683b03 reached the next turn with no terminal`），与 `frame-without-turn` 无关（050a5ac0 有 119 条 frame-without-turn 但 run 全正常关）。

### 修法

在 `runLedgerEffect` 的 `turn-closed` 分支（:4759-4765），置 null 之前，先经 `state.turnRun.writer` 写终态帧（用 effect 的 `outcome` 决定 completed/aborted），再把 `state.turnRun` 置 null。与 per-delivery 的 `closeRun` 是同一条 writer（都是 bind-turn-run 时 `handle.writer`），注册表对重复终态幂等（decorateAndRecordEvent 丢掉第一次之后的），所以正常路径零变化、异常路径兜住。把「一个 turn 铸造的 run 在 turn 关闭时必然关闭」变成构造不变量，不再依赖 delivery runtime 的账本。

## AC
- [x] AC1 红态基线：经 scripted fake 进程 + 真实 driver 造出「turn 已关、但它铸造的 run 在 registry 里仍 running」的分歧（delivery 的 runtime 已被丢弃或终态从未到）⇒ 现状 run 仍 running（红）。
- [x] AC2 根因修复：同一分歧在改动后，turn 关闭 ⇒ registry 里那座 run 以对应 outcome（completed/aborted）关闭、终态帧写进该 run 的 writer；`turn.phase` 与 lease 照旧收口。
- [x] AC3 正常路径零变化：一个正常 turn（有 per-delivery closeRun 正常跑的）在改动后行为逐字不变——turn 关、run 关、帧路由不变、无重复终态可见。
- [x] AC4 取假形态：删掉 turn-closed 里的「写终态帧」臂 ⇒ AC2 红（run 又变幽灵）；还原恢复绿。红落在根因臂本身。
- [x] AC5 兄弟判据不被打红：单文件跑 server/modules/providers/tests/claude-resident-reconcile.test.ts 与 server/modules/providers/tests/claude-resident-unattended-turn.test.ts 仍绿；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `。

## DoD
真实落地判据：交付树上构造「turn 关闭但 delivery runtime 已丢弃」的分歧，改动后 registry 里该 turn 的 run 必被关闭（completed/aborted 与 outcome 一致）；删掉修复臂 ⇒ 复现幽灵 run。`git diff` 只含 `claude-host-driver.provider.ts` 的 turn-closed 分支、判据文件、本任务 task 文件。

## Touches
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （turn-closed 分支补终态帧）
- `server/modules/providers/tests/claude-resident-reconcile.test.ts` （就地加「turn 关但 run 未关」根因臂；若 grep 契约不允许加缝则另起同级文件）
- `tasks/gap-turn-closed-must-close-minted-run.md` （自触）
