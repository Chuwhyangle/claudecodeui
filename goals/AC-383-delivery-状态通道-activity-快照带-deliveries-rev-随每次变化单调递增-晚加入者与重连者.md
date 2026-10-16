---
id: AC-383
title: delivery 状态通道：activity 快照带 deliveries[]，rev 随每次变化单调递增，晚加入者与重连者拿到完整队列，旧
  command_lifecycle 以无 seq 的会话级帧双发
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/activity-deliveries-snapshot.test.ts
expect: 读数——(a) ActivityProtocolSnapshot.deliveries[] 的形状符合 SPEC
  §7.1（deliveryId、state、source、priority、enqueuedAt、startedAt、endedAt、turnId、reason、有界
  text），text 只在 queued/started 时携带且长度不超过上限；(b) 每次 delivery 状态变化 rev 恰好 +1 并发
  activity.upsert（整份快照），心跳携带当前 rev；(c)
  晚加入者订阅即收到含当前队列的快照；重连者重新订阅后恢复排队行与保留窗口内的终态条目；终态条目超过保留窗口后被丢弃，每会话不超过 50 条；(d) 旧
  command_lifecycle 帧仍发，但不带 runId、不带 seq、不进任何 run 的事件缓冲；(e) 取假形态：去掉 started 时的
  rev 递增 ⇒ (b) 红；去掉订阅时的快照 ⇒ (c) 红（晚加入者读到空队列）。⚠️ 当前必红：该测试文件不存在。本条在 S1 的出口 AC 全部
  achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §7。
activatedAt: 2026-10-16T09:30:28.330Z
statusLog:
  - at: 2026-10-16T09:30:28.330Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-16T12:35:15.016Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:30:28.330Z
---
