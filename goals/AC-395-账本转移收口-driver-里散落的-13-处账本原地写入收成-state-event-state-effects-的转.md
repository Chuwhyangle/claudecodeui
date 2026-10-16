---
id: AC-395
title: 账本转移收口：driver 里散落的 13 处账本原地写入收成 (state, event) → (state, effects)
  的转移函数，行为等价，同一转移不再有多份拼写
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-ledger-transitions.test.ts
expect: 读数（行为等价的重构；新文件
  server/modules/providers/list/claude/claude-resident-ledger.ts
  持有转移函数与账本类型，driver 只持实例并转发事件）——(a) 转移表：SPEC §5.2 的每个事件（send、lifecycle
  queued/started/completed/cancelled、init、RESULT、interrupt 请求、撤回请求、进程退出、owed
  结算、double-init）各有至少一条表驱动用例，断言 (state,event) → (state',effects) 的新状态与 effects
  列表；effects 是数据（如 syncLeases、publishDelivery、reportAnomaly、settleRound），不含
  writer 或 sink 调用。(b) 三处原先各自拼写的「关闭 turn 并记 closedTurns」（进程退出、RESULT、第三条路径，立案时位于
  driver 的 :4614、:4929、:6186）收成同一个转移，对同一 outcome 产出逐字相同的 closedTurns 记录与
  effects；三处「异常记账 + [reconcile] 日志」（:3187、:4826、:4978）收成同一个 reportAnomaly
  effect。(c) AST 扫描 claude-host-driver.provider.ts：对 `turnLedger`
  各字段的字段级原地写（`.push/.splice/.set/.add/.delete` 调用，以及对
  `.turn.open`、`.interruptRequested` 等的赋值）计数为 0，打印基线 13 →
  0；账本类型声明（ResidentLedgerDelivery、ResidentLedgerTurn、ResidentLedger）不再出现在 driver
  文件里。(d) 行为等价由既有的 AC-378（性质测试）、AC-380、AC-381 保护：它们已是 achieved，goal-driver 会对
  achieved 的 AC 复验，本条不得让它们变红；本条判据文件另含一条小型回放：把 SPEC 附录 A 四个场景的帧序列喂给转移函数，终态读数满足
  I1–I6。(e) 取假形态：把 RESULT 转移里的 owed 标记去掉 ⇒ (a) 红；把一处原地写重新内联回 driver ⇒ (c) 红。(f)
  单文件单次运行 < 40s。时序：本条的任务排在 AC-385、AC-386 的任务落地之后、AC-390
  的任务之前。首个产出是转移表（含每个写入点归入哪个转移）；读完 driver 的 :4350 到 :4760 之后若发现某写入点与 effects
  无法分离，须在完成记录里逐条列出，不得悄悄保留内联写。⚠️ 当前必红：该测试文件不存在，且字段级原地写为 13 处。
origin: 2026-10-16 另一 Claude 会话「ClaudeCodeUI 局部重构方案」对 GOAL-045 做架构审视（archguard
  读数 + 代码核对），经本会话逐条核实（含在 GOAL 之前的提交 976ef03b1 上重跑 archguard 的环基线、对 13
  个账本写入点的读码），并经用户在会话中同意新增本条（用户答复「同意。」，针对提议的 A–E 五条 AC）。依据：driver 6193
  行且账本内联其中；RESIDENT_RUN_IS_TURN 在 driver 与 registry 各有一份读取；旧路径尚存；server/ 目录级
  import 图存在 11 成员 SCC（GOAL 之前即存在）。关联
  docs/proposals/resident-delivery-turn-ledger-SPEC.md §4.4 I6、§12、§14。
activatedAt: 2026-10-16T13:42:06.552Z
---
