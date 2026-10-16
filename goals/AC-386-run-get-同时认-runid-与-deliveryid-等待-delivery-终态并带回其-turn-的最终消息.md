---
id: AC-386
title: run_get 同时认 runId 与 deliveryId：等待 delivery 终态并带回其 turn 的最终消息，折叠的 delivery
  各自终态、共享最终消息
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts
expect: 读数——(a) run_get 接受 runId 或 deliveryId（互斥，同时给出为参数错误），两个 uuid
  空间互不相交，解析无歧义；(b) waitSeconds>0 等的是 delivery 终态，返回其 turn 的最终助手消息与
  phase、pendingTool；折叠的两条 delivery 各返回自己的终态、共享同一条最终消息；cancelled 的 delivery 返回
  outcome=cancelled 与 reason；(c) 未知 id ⇒ RUN_NOT_FOUND 信封，details 含 idKind；(d)
  等待上限仍为 MCP_RUN_GET_MAX_WAIT_SECONDS，等待只经注入的 now/sleep（假时钟下以数字断言「早于满额预算返回」）；(e)
  取假形态：把 deliveryId 当 runId 解析 ⇒ (a) 红。⚠️ 当前必红：该测试文件不存在。本条在 S2 的出口 AC 全部
  achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §8.2。
activatedAt: 2026-10-16T09:32:33.427Z
statusLog:
  - at: 2026-10-16T09:32:33.427Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-16T14:31:17.889Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:32:33.427Z
---
