---
id: AC-380
title: interrupt 无残留：只向 CLI 请求而不直接改账；在飞命令 cancelled、排队命令照常开新 turn；CLI 其实已空闲时不留
  round/lease/run 的分裂状态
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts
expect: 读数（scripted fake 进程 + 真实 driver）——(a) 在飞 turn 且有一条排队命令时 interrupt：此刻
  turn lease 仍在（账本不合成终态）；随后 RESULT(is_error) 与 cancelled(在飞命令) 到达后，在飞 delivery
  终态为 cancelled(reason=interrupt)、其 turn 终态为 aborted；排队命令 started→新
  init→RESULT→completed，各 run 恰一条 complete；静止后打印 `roundsOpen=0
  turnLeasesOpen=0`。(b) CLI 其实已空闲时 interrupt（不会有 RESULT）：调用返回后不得出现
  `turnLeasesOpen=0 且 roundsOpen>0` 的分裂读数（现行代码的缺陷签名）；超过 T_int 仍无 RESULT 时以
  `interrupt-no-result` 异常记入日志并按 SPEC §10 处理，不得静默残留。(c) interrupt 只向 CLI
  写一次请求，不重复摘 lease。(d) 取假形态：把 interrupt 临时还原为旧实现（直接 leaseRemoved 而不动 round）⇒ (b)
  红在 `turnLeasesOpen=0 roundsOpen=1` 这一签名上；用后还原。⚠️ 当前必红：该测试文件不存在。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §5.2 与
  §6.3。
activatedAt: 2026-10-16T09:18:40.994Z
statusLog:
  - at: 2026-10-16T09:18:40.994Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-16T11:46:08.108Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:18:40.994Z
---
