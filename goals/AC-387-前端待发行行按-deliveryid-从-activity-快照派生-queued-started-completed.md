---
id: AC-387
title: 前端待发行行按 deliveryId 从 activity 快照派生：queued/started/completed/cancelled
  的显示与重连恢复，旧帧存在时不双计，游标记录不受影响
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx
expect: 读数（vitest + jsdom，渲染真实的待发行组件与 store）——(a) 行的键为 deliveryId，状态取自 activity
  快照：queued 画「排队中」、started 保留文本、completed 离屏、cancelled 清空文本但保留行（id-relations B-2
  不变）；(b) 重连发生在排队中途：行从快照恢复，不依赖重放 run 流；(c) 快照与旧 command_lifecycle 帧同时到达时同一
  deliveryId 只算一行；(d) 无 seq 的会话级帧不进游标记录，游标 {runId, seq} 规则不变；(e) 取假形态：按 runId
  给行做键 ⇒ (a) 红。⚠️ 当前必红：该测试文件不存在。本条在 S3 的出口 AC 全部 achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §9。
activatedAt: 2026-10-16T09:32:52.563Z
statusLog:
  - at: 2026-10-16T09:32:52.563Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-16T14:54:21.056Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:32:52.563Z
---
