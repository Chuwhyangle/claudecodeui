---
id: AC-385
title: send 返回 deliveryId 必给、runId 可空：兼容窗口内 runId 回填 deliveryId；被拒绝的发送不产生
  delivery；correlationId 记在 delivery 上
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts
expect: 读数（真实 MCP 传输 + 控制服务 + 调试 agent 的常驻/按次两种会话）——(a)
  session_send、session_create（带首条消息）、session_draft 发送：每次被接受的发送都返回
  deliveryId，且等于随后 lifecycle 帧里的 commandUuid；排队时 queuedMessageUuid 等于
  deliveryId；(b) per-run provider：runId 非空且等于 getRun 的 runId；(c) resident
  忙时发送：兼容窗口内 runId 从不为 null，未绑定 turn 时等于 deliveryId；窗口关闭（测试里把窗口常量置为已过期）后 runId 为
  null，直到绑定后经 run_get 读到；窗口截止常量是带日期的常量，过期即判据变红，逼着移除回填；(d) 被拒绝的发送（RUN_IN_PROGRESS
  等）不产生 delivery；(e) correlationId 记在 delivery 上，并按它可检索；(f) 取假形态：忙时发送不给
  deliveryId ⇒ (a) 红。⚠️ 当前必红：该测试文件不存在。本条在 S2 的出口 AC 全部 achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §8.1 与
  §8.3。
activatedAt: 2026-10-16T09:31:58.881Z
statusLog:
  - at: 2026-10-16T09:31:58.881Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:31:58.881Z
---
