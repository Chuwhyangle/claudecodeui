---
id: AC-393
title: 旧路径棘轮：旧的位置对账与顶替 run 相关符号在 server/ 全部非测试代码里的活代码命中数只减不增，resultsSeenAtStart 必须为 0
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/shared/tests/resident-legacy-path-ratchet.test.ts
expect: 读数——(a) 用 TypeScript AST 统计（注释、字符串不计）：标识符
  `supersedeRunning`、`resultTimes`、`resultsSeenAtStart` 在 **server/
  全部非测试代码**中的出现次数（按文件列出），以及属性访问 `.rounds` 在 claude-host-driver.provider.ts
  中的次数（`.rounds` 太泛，只扫 driver）；打印 `legacy supersedeRunning=<n> resultTimes=<n>
  resultsSeenAtStart=<n> rounds(driver)=<n>`。(b) 初始上限（立案时 AST 口径实测，AC-385
  落地后复测不变）：supersedeRunning ≤ 3（registry 2、chat-websocket 1）、resultTimes ≤
  9（driver）、resultsSeenAtStart = 0、driver 的 .rounds ≤
  15；目前这三个标识符只出现在这些文件里，所以扩到全部非测试代码计数不变，但新文件里再写旧符号就会被抓到。上限随基线文件入库，只许下调、不许上调：测试同时断言入库基线文件里的每一项都不大于上述初始值，且实际计数不大于入库基线。(c)
  失败信息必须写明两点：新增命中所在的文件与行；若它是同名但与旧账无关的局部变量（resultTimes 是泛名），请改名，不要上调基线。(d)
  退役不是本条的目标：supersedeRunning 的 3 处是 flag 关态的回滚路径（SPEC §12「回滚即关」），本条不要求把它们降到
  0，也不得为了降数而删除回滚路径；真正的退役在 flag 默认开启并浸泡之后由人另立。(e) 负对照（防空转）：内存源码里只在注释或字符串里出现这些名字 ⇒
  计数 0。(f) 取假形态：在任一非测试文件（含新建文件）新增一次活的使用 ⇒ 红；用后还原。(g) 单文件单次运行 < 20s。⚠️
  当前必红：该测试文件与基线文件不存在。
origin: 2026-10-16 另一 Claude 会话「ClaudeCodeUI 局部重构方案」对 GOAL-045 做架构审视（archguard
  读数 + 代码核对），经本会话逐条核实（含在 GOAL 之前的提交 976ef03b1 上重跑 archguard 的环基线、对 13
  个账本写入点的读码），并经用户在会话中同意新增本条（用户答复「同意。」，针对提议的 A–E 五条 AC）。依据：driver 6193
  行且账本内联其中；RESIDENT_RUN_IS_TURN 在 driver 与 registry 各有一份读取；旧路径尚存；server/ 目录级
  import 图存在 11 成员 SCC（GOAL 之前即存在）。关联
  docs/proposals/resident-delivery-turn-ledger-SPEC.md §4.4 I6、§12、§14。
  2026-10-16 经对方会话对 AC 判据的对抗式复核（别名写绕过前缀计数、账本 delivery 类型夹带 driver 的 round 与
  lease 记账、动态 import 空转风险、shared 的求值叶子断言），并核实代码后修订本条期望文本；基线数字在 AC-385 落地后的 HEAD
  上复测不变。
activatedAt: 2026-10-16T13:42:05.982Z
statusLog:
  - at: 2026-10-16T14:54:58.029Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
