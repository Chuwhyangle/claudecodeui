---
id: AC-390
title: 对账与可观测：log 模式只记不改，enforce 模式关闭幽灵 run；运行中的真实 turn 在两种模式下都不被关；生命周期日志带 session=
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-reconcile.test.ts
expect: 读数——(a) log 模式：注入分歧（注册表有 running 的 run 而账本静止且超过 T_q）⇒ 恰好一行 `[reconcile]
  session=… mode=log anomaly=phantom-run`，且注册表与 lease 读数不变；(b) enforce 模式：同一分歧 ⇒
  幽灵 run 以 aborted、reason=reconciled 关闭并记同一行；(c) 反例：turn 已开的真实长 turn，在两种模式、含
  heartbeat 多拍之后都不被关闭；(d)
  其余异常码（owed-terminal-missing、double-init、interrupt-no-result、frame-without-turn）各有一个注入用例得到对应一行；(e)
  `command_lifecycle forwarded` 行含 `session=`；turn 开/关、delivery 终态、lease
  变化各产生恰好一行 [ledger]/[turn] 日志（计数断言）；(f) 取假形态：对账忽略 turn 是否已开 ⇒ (c) 红。⚠️
  当前必红：该测试文件不存在。本条在 S4 的出口 AC 全部 achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §10。
activatedAt: 2026-10-16T09:35:20.171Z
statusLog:
  - at: 2026-10-16T09:35:20.171Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:35:20.170Z
---
