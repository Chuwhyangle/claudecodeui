---
id: AC-378
title: 账本不变量：种子化随机交错（冷/忙发送、终态与 RESULT 两种先后、RESULT 正常/出错、无人 init、interrupt、进程退出）下
  I1–I6 恒成立
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-ledger-invariants.test.ts
expect: 读数——(a) 固定种子表（≥200 条序列，确定性：同一种子两次运行结果逐字相同）驱动 scripted fake 进程 + 真实
  driver；序列由操作 {冷发送、忙发送 later、忙发送 next、CLI 的
  queued/started/completed/cancelled、RESULT 正常或 is_error、无人 init、interrupt、进程退出}
  按 SPEC §2 的实测契约生成，其中折叠命令的终态相对 RESULT 的先后（SPEC C-3）两种都生成。打印 `sequences=<n>
  violations=0`。(b) 每条序列静止后断言 SPEC §4.4：I1（无 running run、无 turn
  lease、processing=false）、I2（每个 delivery 与每个 turn 恰一个终态）、I3（一个 turn 的帧只进它自己的
  run，seq 从 1 连续）、I4（仍欠终态的命令至多保持到下一个 turn 开始，否则以 owed-terminal-missing
  结算并记异常）、I5（init 时无待绑定 started ⇔ 无人 turn）、I6（lease 数等于由账本重算的投影）。(c)
  失败时打印最小反例序列与违反的不变量编号。(d) 取假形态两处：把 result 的结算临时改回单次 rounds.shift（位置对账）⇒
  violations>0，首个违约为 I1 或 I2 且带反例序列；把生成器改成违背契约（某命令永不到终态）⇒ 必须被记为 anomaly 或按 I4
  结算，不得静默通过。(e) 整份文件单次运行 < 40s。⚠️ 当前必红：该测试文件不存在；写成后在现行代码（位置对账）上必红，账本落地后转绿。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §4.4、§5 与
  §11。
activatedAt: 2026-10-16T09:17:45.990Z
statusLog:
  - at: 2026-10-16T09:17:45.990Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:17:45.990Z
---
