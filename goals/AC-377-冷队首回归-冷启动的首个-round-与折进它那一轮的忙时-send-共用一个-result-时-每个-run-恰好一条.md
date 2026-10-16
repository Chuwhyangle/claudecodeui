---
id: AC-377
title: 冷队首回归：冷启动的首个 round 与折进它那一轮的忙时 send 共用一个 result 时，每个 run 恰好一条
  complete，随后的空闲 send 不再差一格
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-cold-head-merge.test.ts
expect: 读数（scripted fake 进程 + 真实 ClaudeResidentHostDriver，不碰真实 claude 二进制）——(a)
  回放 2026-10-16 fdd3e920 的序列（SPEC §1.2、§1.3）：冷 M1 在飞，忙时 M2 与 M3 在 M1 的 result
  之前先后 started（被 CLI 折进同一 turn），只来一个 result；之后打印 `roundsOpen=0
  turnLeasesOpen=0`，且 M1、M2、M3 各自 writer 的 complete 恰为 1（打印 `completes=M1:1 M2:1
  M3:1`）。(b) 紧接着空闲发送 M4、M5（各自 queued→started→result）：每条结束后 `roundsOpen=0`，其自己
  writer 的 complete 恰为 1，且 M4 的 complete 不得落在 M3 的 writer 上、M5 的不得落在 M4 的 writer
  上（逐 writer 计数）。(c) 反例（不得过度结算）：冷 A 在飞，B 与 C 在 A 的 result 之后才同批 started（later
  排空合并）：A 的 result 只结算 A（打印 `roundsOpenAfterFirstResult=2`），合并 result 之后 B、C 各 1
  个 complete、`roundsOpen=0`。(d) 取假形态：把 arm 时给冷/空闲 round 打 resultsSeenAtStart
  的那一处临时去掉，(a) 必须红在 `roundsOpen` 或 `completes` 读数上（不是别的腿先红）；用后还原。(e) 单文件单次运行 <
  20s。⚠️ 当前必红：该测试文件不存在。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §1.3 与 §12
  S0。
activatedAt: 2026-10-16T09:17:21.434Z
statusLog:
  - at: 2026-10-16T09:17:21.434Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-16T10:06:21.622Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:17:21.434Z
---
