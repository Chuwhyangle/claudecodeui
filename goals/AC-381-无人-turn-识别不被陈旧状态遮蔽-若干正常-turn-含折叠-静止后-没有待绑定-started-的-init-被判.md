---
id: AC-381
title: 无人 turn 识别不被陈旧状态遮蔽：若干正常 turn（含折叠）静止后，没有待绑定 started 的 init 被判为无人 turn，且只通知一次
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts
expect: 读数（scripted fake 进程 + 真实 driver）——(a) 先跑 ≥3 个正常 turn（含一次 next 折叠、一次
  later 排空合并）到静止；再喂一个 system/init（此前没有任何 started），其后 assistant、带
  origin.kind=task-notification（另一腿用 peer）的 RESULT：判为无人 turn，开出一个
  source=unattended 的 run（deliveryIds 为空），RESULT 时把触发类型报告恰好 1 次（打印
  `unattendedNotifications=1`），该 run 恰一条 complete，静止后读数满足 I1。(b) 同形序列在「陈旧 round
  残留」的状态下（用现行缺陷序列预置）也必须识别为无人 turn。(c) 反例：init 之前有 started 的命令 ⇒ 判为 delivered
  turn，不得开 unattended run；cron 形态（CLI 自造 uuid 的 started）⇒ 判为无人 turn，且该 uuid
  不出现在对外 delivery 读数里。(d) 取假形态：把判定临时改回「已有 round 则不开」⇒ (b) 红；用后还原。⚠️
  当前必红：该测试文件不存在。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §4.4 I5 与
  §5.2。
activatedAt: 2026-10-16T09:19:39.084Z
statusLog:
  - at: 2026-10-16T09:19:39.084Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:19:39.084Z
---
