---
id: AC-395
title: 账本转移收口：账本对 driver 不透明，转移函数返回 {changed, effects}，driver 不再对账本字段读写，账本类型不含
  driver 类型，行为等价，同一转移不再有多份拼写
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-ledger-transitions.test.ts
expect: "读数（行为等价的重构；新文件
  server/modules/providers/list/claude/claude-resident-ledger.ts
  持有转移函数与账本类型，driver 只持实例并转发事件）——(a) 转移表：SPEC §5.2 的每个事件（send、lifecycle
  queued/started/completed/cancelled、init、RESULT、interrupt 请求、撤回请求、进程退出、owed
  结算、double-init）各有至少一条表驱动用例，断言转移后的账本状态与返回值 `{changed, effects}`；effects
  用类型表达为判别联合，成员不含函数类型，由类型层面的断言文件核对，不用文本扫描；转移函数允许在模块内部原地改账（账本靠对象同一性工作：pendingSta\
  rt.includes(delivery)、byUuid 与 deliveries 引用同一对象），禁止模块外写。(b) 重复拼写收成一份：「关闭 turn
  并记 closedTurns」在立案时有三份（进程退出 :4614、RESULT :4929、`closeLedgerTurnOnly`
  :6180，后者已是现成 helper 但只有一处调用），收成同一个转移，对同一 outcome 产出逐字相同的 closedTurns
  记录；三处「异常记账 + [reconcile] 日志」（:3187、:4826、:4978）收成同一个 reportAnomaly
  effect。这是首刀。(c) 账本对 driver 不透明，按**写入目标的类型**而不是文本前缀判定：AST 扫描
  claude-host-driver.provider.ts，对 `turnLedger`
  的字段访问（`<expr>.turnLedger.<field>`，读与写都算）计数为 0，账本整体只作为参数传给模块函数——这同时消除别名写（立案时
  :4925 与 :6180 是 `const turn = state.turnLedger.turn; turn.open = false`，:4707
  起是对 byUuid.get 取出的 delivery 赋值，都不经 `turnLedger.` 前缀直写，按前缀计数会漏）；模块交给 driver
  的账本对象一律是只读视图类型，类型层面的夹具用 TypeScript 程序化编译一段对返回对象赋值的片段，必须得到只读属性诊断（TS2540），证明
  driver 侧写入是编译错误。(d) 账本类型不夹带 driver 类型：立案时 ResidentLedgerDelivery 带 `round:
  ResidentRound`（dispatcher 的 round，持有 writer 与 settle）、`leaseId`、`leaseHeld`（该
  lease 是否已报给 manager），这些是 driver 记账；须移到 driver 侧按 commandUuid 索引的表，或对 round
  用泛型/不透明句柄；断言新文件只 import shared（AST），不引用 ResidentRound。这是 AC-396「只 import
  shared」的前置，不在本条解决就会在搬迁时才发现。(e) 固定尾巴由 driver 统一 commit：转移函数返回账本是否变化，driver
  在其后统一同步 lease 并发布，不给每个转移单配 effects；带 await 与定时器的动作（如 :3130 之后的
  stopResidentTurn、armInterruptWatchdog）留在 driver，账本侧只改 interruptRequested；需要读
  driver 状态的输入（如 cancelledReason）由 driver 先算好作为事件载荷传入。(f) 行为等价由既有的
  AC-378（性质测试）、AC-380、AC-381 保护：它们已是 achieved，goal-driver 会对 achieved 的 AC
  复验，本条不得让它们变红；本条判据文件另含一条小型回放：把 SPEC 附录 A 四个场景的帧序列喂给转移函数，终态读数满足 I1–I6。(g) 取假形态：把
  RESULT 转移里的 owed 标记去掉 ⇒ (a) 红；把一处账本字段访问重新写回 driver ⇒ (c) 红；让账本类型重新引用
  ResidentRound ⇒ (d) 红。(h) 单文件单次运行 < 40s。时序：本条的任务排在 AC-385 之后（已落地）、AC-386
  的任务之后、AC-390 的任务之前。首个产出是转移表（含每个写入点归入哪个转移）；读完 driver 的 :4350 到 :4760
  之后若发现某写入点与账本无法分离，须在完成记录里逐条列出，不得悄悄保留。⚠️ 当前必红：该测试文件不存在，且对 turnLedger 的字段访问不为 0。"
origin: 2026-10-16 另一 Claude 会话「ClaudeCodeUI 局部重构方案」对 GOAL-045 做架构审视（archguard
  读数 + 代码核对），经本会话逐条核实（含在 GOAL 之前的提交 976ef03b1 上重跑 archguard 的环基线、对 13
  个账本写入点的读码），并经用户在会话中同意新增本条（用户答复「同意。」，针对提议的 A–E 五条 AC）。依据：driver 6193
  行且账本内联其中；RESIDENT_RUN_IS_TURN 在 driver 与 registry 各有一份读取；旧路径尚存；server/ 目录级
  import 图存在 11 成员 SCC（GOAL 之前即存在）。关联
  docs/proposals/resident-delivery-turn-ledger-SPEC.md §4.4 I6、§12、§14。
  2026-10-16 经对方会话对 AC 判据的对抗式复核（别名写绕过前缀计数、账本 delivery 类型夹带 driver 的 round 与
  lease 记账、动态 import 空转风险、shared 的求值叶子断言），并核实代码后修订本条期望文本；基线数字在 AC-385 落地后的 HEAD
  上复测不变。
activatedAt: 2026-10-16T13:42:06.552Z
---
