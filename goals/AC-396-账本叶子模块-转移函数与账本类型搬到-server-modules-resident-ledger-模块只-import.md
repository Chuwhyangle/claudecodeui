---
id: AC-396
title: 账本叶子模块：转移函数与账本类型搬到 server/modules/resident-ledger，模块只 import
  shared，driver 经 barrel 引用，SCC 成员集合不变
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/resident-ledger/tests/resident-ledger-leaf-module.test.ts
expect: 读数——(a) server/modules/resident-ledger/ 有 index.ts barrel，只导出 driver
  与测试需要的转移函数与类型，每个导出带消费者注释；(b) 复用 AC-394 落地的静态加字面量动态 import
  扫描器（不另写一份）断言：该目录内全部非测试文件的 import 目标只落在 **server/shared/**（注意不是仓库根的
  shared/）、本目录自身、node 内置与第三方包，对 server/modules/** 其它目录零 import（含动态），且该目录不在任何非平凡
  SCC 里；其前提是 AC-394 的 shared 叶子断言（server/shared 对 modules
  零入边）持续成立，本条不重复断言，只引用它；(c) claude-host-driver.provider.ts 对该模块的 import 都经
  `@/modules/resident-ledger/index.js`（AST 核对，不深引用其内部文件）；(d) AC-395 的落点
  claude-resident-ledger.ts 已不存在或只是对新模块的转发，driver 文件里没有账本类型声明，账本类型不引用 driver 的
  ResidentRound（AC-395 (d) 的前置已完成）；(e) AC-394 在搬迁后仍绿：SCC 成员集合包含于基线三组；(f)
  取假形态：在新模块里加一条对 modules/websocket 的 import ⇒ (b) 红；让 driver 深引用新模块内部文件 ⇒ (c)
  红；用后还原。(g) 单文件单次运行 < 30s。时序：依赖 AC-395 的任务；排在 AC-390 的任务之前。⚠️ 当前必红：目录与文件不存在。
origin: 2026-10-16 另一 Claude 会话「ClaudeCodeUI 局部重构方案」对 GOAL-045 做架构审视（archguard
  读数 + 代码核对），经本会话逐条核实（含在 GOAL 之前的提交 976ef03b1 上重跑 archguard 的环基线、对 13
  个账本写入点的读码），并经用户在会话中同意新增本条（用户答复「同意。」，针对提议的 A–E 五条 AC）。依据：driver 6193
  行且账本内联其中；RESIDENT_RUN_IS_TURN 在 driver 与 registry 各有一份读取；旧路径尚存；server/ 目录级
  import 图存在 11 成员 SCC（GOAL 之前即存在）。关联
  docs/proposals/resident-delivery-turn-ledger-SPEC.md §4.4 I6、§12、§14。
  2026-10-16 经对方会话对 AC 判据的对抗式复核（别名写绕过前缀计数、账本 delivery 类型夹带 driver 的 round 与
  lease 记账、动态 import 空转风险、shared 的求值叶子断言），并核实代码后修订本条期望文本；基线数字在 AC-385 落地后的 HEAD
  上复测不变。
activatedAt: 2026-10-16T13:42:06.801Z
statusLog:
  - at: 2026-10-16T17:01:08.511Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
