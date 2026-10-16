---
id: AC-392
title: 开关单点：RESIDENT_RUN_IS_TURN 在非测试服务端代码里只有一处读取，位于
  server/shared/utils.ts，调用时读取，driver、registry、chat-websocket 都经它判定
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/shared/tests/resident-run-is-turn-single-reader.test.ts
expect: 读数——(a) 用 TypeScript AST（不是文本 grep；注释与字符串里的名字不计）扫描 server/ 下全部非测试代码（排除
  /tests/ 目录与 *.test.ts），统计对 `process.env.RESIDENT_RUN_IS_TURN`（含
  `process.env['RESIDENT_RUN_IS_TURN']`）的读取，打印 `flagReaders=1
  at=server/shared/utils.ts:<line>`。立案时实测基线为 2
  处：claude-host-driver.provider.ts:759 与 chat-run-registry.service.ts:51。(b) 谓词
  `residentRunIsTurn` 由 server/shared/utils.ts 导出（按 backend-module-standards
  带消费者注释），claude-host-driver.provider.ts、chat-run-registry.service.ts、chat-websocket.service.ts
  三处的 import 声明（AST 核对）都指向它，不再从 chat-run-registry 转出口；理由是它是求值叶子：providers 与
  websocket 之间有文档化的 ESM 求值顺序约束（见 claude.provider.ts 里关于 providerRegistry 求值前被读取的
  TDZ 注释），shared 不 import 它们。(c) 调用时读取而非模块加载时缓存：导入后把变量依次设为 '1'、其它值、删除，调用结果依次为
  true、false、false（'true' 与 '0' 也是 false，只有恰为 '1' 才为真）。(d)
  负对照（防空转）：测试内以内存源码喂同一扫描器——只在注释里提到该名字的源码计数为 0，含两处真实读取的源码计数为 2。(e)
  取假形态：在任一非测试文件里临时加第二处读取 ⇒ (a) 红；用后还原。(f) 单文件单次运行 < 20s。时序：本条的任务排在 AC-385 与
  AC-386 的任务落地之后（它们的 Touches 含 chat-run-registry.service.ts，会重叠）。⚠️
  当前必红：该测试文件不存在，且读取点为 2 处。
origin: 2026-10-16 另一 Claude 会话「ClaudeCodeUI 局部重构方案」对 GOAL-045 做架构审视（archguard
  读数 + 代码核对），经本会话逐条核实（含在 GOAL 之前的提交 976ef03b1 上重跑 archguard 的环基线、对 13
  个账本写入点的读码），并经用户在会话中同意新增本条（用户答复「同意。」，针对提议的 A–E 五条 AC）。依据：driver 6193
  行且账本内联其中；RESIDENT_RUN_IS_TURN 在 driver 与 registry 各有一份读取；旧路径尚存；server/ 目录级
  import 图存在 11 成员 SCC（GOAL 之前即存在）。关联
  docs/proposals/resident-delivery-turn-ledger-SPEC.md §4.4 I6、§12、§14。
activatedAt: 2026-10-16T13:42:05.692Z
statusLog:
  - at: 2026-10-16T16:06:50.151Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
