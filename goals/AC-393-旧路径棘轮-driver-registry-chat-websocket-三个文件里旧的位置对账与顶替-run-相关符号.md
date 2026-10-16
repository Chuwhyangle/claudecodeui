---
id: AC-393
title: 旧路径棘轮：driver、registry、chat-websocket 三个文件里旧的位置对账与顶替 run
  相关符号的活代码命中数只减不增，resultsSeenAtStart 必须为 0
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/shared/tests/resident-legacy-path-ratchet.test.ts
expect: 读数——(a) 用 TypeScript AST 统计（注释、字符串不计）三个文件
  claude-host-driver.provider.ts、chat-run-registry.service.ts、chat-websocket.service.ts
  中：标识符 `supersedeRunning`、`resultTimes`、`resultsSeenAtStart` 的出现次数，以及属性访问
  `.rounds` 的次数；打印 `legacy supersedeRunning=<n> resultTimes=<n>
  resultsSeenAtStart=<n> rounds=<n>`。(b) 初始上限（立案时 AST 口径实测）：supersedeRunning ≤
  3、resultTimes ≤ 9、resultsSeenAtStart = 0、.rounds ≤
  15。上限随基线文件入库，只许下调、不许上调：测试同时断言入库基线文件里的每一项都不大于上述初始值，且三个文件的实际计数不大于入库基线。(c)
  退役不是本条的目标：supersedeRunning 的 3 处是 flag 关态的回滚路径（SPEC §12「回滚即关」），本条不要求把它们降到
  0，也不得为了降数而删除回滚路径；真正的退役在 flag 默认开启并浸泡之后由人另立。(d) 负对照：内存源码里只在注释或字符串里出现这些名字 ⇒ 计数
  0。(e) 取假形态：在三个文件里任一处新增一次活的使用 ⇒ 红；用后还原。(f) 单文件单次运行 < 20s。⚠️ 当前必红：该测试文件与基线文件不存在。
origin: 2026-10-16 另一 Claude 会话「ClaudeCodeUI 局部重构方案」对 GOAL-045 做架构审视（archguard
  读数 + 代码核对），经本会话逐条核实（含在 GOAL 之前的提交 976ef03b1 上重跑 archguard 的环基线、对 13
  个账本写入点的读码），并经用户在会话中同意新增本条（用户答复「同意。」，针对提议的 A–E 五条 AC）。依据：driver 6193
  行且账本内联其中；RESIDENT_RUN_IS_TURN 在 driver 与 registry 各有一份读取；旧路径尚存；server/ 目录级
  import 图存在 11 成员 SCC（GOAL 之前即存在）。关联
  docs/proposals/resident-delivery-turn-ledger-SPEC.md §4.4 I6、§12、§14。
activatedAt: 2026-10-16T13:42:05.982Z
---
