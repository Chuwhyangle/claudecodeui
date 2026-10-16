---
id: AC-379
title: CLI 契约哨兵：真实 claude 二进制 + mock 端点，生产 SDK 路径上四个场景（空闲、later 排空合并、next
  折叠、interrupt）的帧顺序与 SPEC §2 一致
status: achieved
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-cli-contract.test.ts
expect: 读数——(a) 打印 `claudeBinary=<path> claudeVersion=<version>`（路径不得为空、不得
  skip）。(b) 经生产 driver 的 observe 上的只读观测点记录原始帧顺序，四个场景各打印
  `contract.<scenario>=ok|violated`：idle（queued<started<init<RESULT<completed，且
  started 先于 init）；later-drain（A 的 RESULT 之后依次
  completed(A)、started(B)、started(C)，B 与 C 的 started 先于同一个 init，其后一个
  RESULT，completed(B)、completed(C) 在其后）；next-fold（B 的 started 出现在 A 的 init
  之后、RESULT 之前，且该 turn 内没有第二个 init；completed(B) 先于 RESULT，completed(A) 后于
  RESULT）；interrupt（RESULT 带 is_error=true，其后 cancelled(A)，再 started(B)，再新的
  init，最终 completed(B)）。(c) 顺序检查器自带取假自测：对每个场景构造一份被篡改的合成 trace（互换两帧），检查器必须报
  violated，证明哨兵能红。(d) mock 端点零外连、无真实 API key。(e) 单文件单次运行 < 50s（场景里的 Bash sleep 取
  2 秒级）。⚠️ 当前必红：该测试文件不存在。契约一旦被 CLI 升级改变，本条先红，据此先改 SPEC §2 再改账本。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §2 与 §11。
activatedAt: 2026-10-16T09:18:16.990Z
statusLog:
  - at: 2026-10-16T09:18:16.990Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-16T11:01:38.233Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:18:16.990Z
---
