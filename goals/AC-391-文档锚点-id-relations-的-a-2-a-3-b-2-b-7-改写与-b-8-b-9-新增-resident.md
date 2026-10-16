---
id: AC-391
title: 文档锚点：id-relations 的 A.2/A.3/B-2/B-7 改写与 B-8/B-9 新增、resident-sessions §8
  补排空合并，均有稳定锚点可机械核对
status: draft
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts
expect: "读数——(a) 读 docs/proposals/id-relations-and-projection-invariants.md 与
  docs/proposals/claude-resident-sessions.md，断言稳定的 HTML 注释锚点齐全：`<!-- anchor:
  delivery-id -->`（A.2）、`<!-- anchor: run-is-turn -->`（A.3）、`<!-- anchor:
  b2-state-channel -->`、`<!-- anchor: b7-state-channel -->`、`<!-- anchor:
  b8-processing-single-writer -->`、`<!-- anchor: b9-terminal-order-independent
  -->`、`<!-- anchor: resident-drain-merge -->`（resident-sessions §8）；(b)
  每个锚点之后的同一小节内含该小节要求的关键断言的编号引用（如 A.3 小节引用 SPEC 的 I2/I3，B-8 小节引用
  I1/I6），用锚点定位而不是整篇正文 grep；(c) 本 SPEC 的 §15 矩阵列出的判据文件在仓内存在，且每个文件被一个 AC 的
  criterion 逐字引用；(d) 取假形态：删掉任一锚点或改名 ⇒ 红。⚠️ 当前必红：该测试文件不存在。本条在 S4 的出口 AC 全部
  achieved 之后才激活。"
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §12 文档行与
  §13.3。
---
