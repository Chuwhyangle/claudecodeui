---
id: AC-382
title: run 即 turn：resident 的 run 在 init 铸造，折叠与排空合并的 delivery 共享同一个 run，帧只进该
  run，不再有顶替 run
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/chat-run-turn-semantics.test.ts
expect: 读数（真实 chat-control + 注册表 + scripted fake 进程，RESIDENT_RUN_IS_TURN 开）——(a)
  空闲 send ⇒ 一个 turn、一个 run；(b) later 两条忙时 send 被排空合并 ⇒ 仅一个 run，其 deliveryIds
  恰含这两条，各 delivery 终态独立、先后任意；(c) next 折叠 ⇒ 不新铸 run，delivery 绑定到开着的 turn 的
  run；(d) 无人 turn ⇒ source=unattended、deliveryIds 为空；(e) 每个 run 的所有帧都带自己的
  runId，seq 从 1 连续，没有任何帧带别的 turn 的 runId；(f) 对 resident 会话 startRun 带
  supersedeRunning 的调用次数为 0（spy 计数）；(g) per-run provider（调试 agent 的按次进程）仍是一个
  delivery 对一个 run；(h) 取假形态：帧仍按 rounds[0] 的 writer 路由 ⇒ (e) 红。⚠️
  当前必红：该测试文件不存在。本条在 S1 的出口 AC 全部 achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §6。
activatedAt: 2026-10-16T09:29:47.918Z
statusLog:
  - at: 2026-10-16T09:29:47.918Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-16T12:06:45.572Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:29:47.918Z
---
