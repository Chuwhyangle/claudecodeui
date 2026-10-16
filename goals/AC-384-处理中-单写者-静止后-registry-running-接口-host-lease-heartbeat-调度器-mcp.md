---
id: AC-384
title: 「处理中」单写者：静止后 registry、running 接口、host lease、heartbeat、调度器、MCP
  读工具同时为空，活动中同时为真，静止后排队消息被发出
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/processing-single-writer.test.ts
expect: 读数——对 SPEC §2 的每个场景（空闲、later 排空合并、next 折叠、interrupt、无人 turn、进程退出）：(a)
  活动中 chatRunRegistry.isProcessing、listRunningRuns、GET
  /api/providers/sessions/running、host 的 turn lease、heartbeat 的 isProcessing、MCP
  overview 的运行集合同时为真；(b) 静止后六者同时为假/为空（I1），不得出现任意两者分歧；(c) 空闲发送在 init 之前（已接受、尚无
  turn）即为处理中，不出现空档；(d) 一条持久化的排队消息在会话静止后被 scheduled-message 调度器认领并发出恰好一次（SPEC
  §1.4 的连带后果）；(e) 取假形态：让任意一个读者继续读旧的闩锁而不是账本 ⇒ 与其余读者分歧 ⇒ 红。⚠️ 当前必红：该测试文件不存在。本条在 S1
  的出口 AC 全部 achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §4.3 与 §4.4
  I6。
activatedAt: 2026-10-16T09:31:16.564Z
statusLog:
  - at: 2026-10-16T09:31:16.564Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:31:16.564Z
---
