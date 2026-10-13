---
id: gap-live-voice-busy-utterance-preemption-proposal
title: 提案：会话忙时新话语主动抢占在跑回合（停前序、带上下文处理当前句）——在 interrupt
  修复复验后研究，默认值须人裁定；同时复核排队可见性回归与 2500 ms 合并窗口
status: ready
labels:
  - gap
  - P1
  - proposal
parent: null
children: []
extra:
  acceptance: test -f docs/proposals/voice-realtime-busy-preemption-proposal.md
depends_on:
  - gap-live-voice-interrupt-missing-intent-drops-stop
---
## Proposal

**人的诉求（2026-10-13 live voice 实测，原话经转写）**：「没有看到比较积极的停止前序的推理，然后开启后续的」「让它停掉前面这句话，先处理我现在说的这句话」「你看，这句『先暂停一下』居然会排在 queue 里面，要等到前面那句话处理完了，它才能排进去吗？」

**现状（A+ 裁定，2026-10-12，SPEC `docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3/§18）**：会话忙时语音照常进 CLI 队列，只在回合边界聚合；只有 Realtime 模型语义判断为「停止或修正当前方向」时才调 `session_interrupt`。实测 b5d01c21：唯一一次正确的 interrupt 因缺 `intent` 被拒（由 `gap-live-voice-interrupt-missing-intent-drops-stop` 修）；「先暂停一下，先统计……」被模型判为普通 send，进队列等完整个回合（15:59:53 入队）。

**本任务是提案，不是实现**：在 interrupt 修复合入后先复验「模型主动打断」的真实效果，再研究「busy 时新话语主动抢占」的若干形态，交人裁定。**⛔ 硬约束：未经人进一步裁定，不得把一切补充话语设成中断默认；本任务不改任何产品默认值。**

## Plan

1. **复验**（依赖任务合入后）：用 capture `b5d01c21….wav`（sha256 前缀 `0f2bd51fbbb28c9f`）中的「终止前面操作」「先暂停一下」两处真实语音，在备用端口实例 / dry-run 执行面回放真实上游，读：模型是否调用 interrupt、执行面是否接受、回合是否中止、修正文本是否随同一回合到达。花费上限 ¥0.3；不重启 :3001。
2. **形态研究**（至少三种，逐一给出代价与风险）：(a) 现状 A+ + 修好的语义 interrupt；(b) 有界抢占——回合已运行 ≥N s 且新话语被模型判为与当前方向相关时抢占；(c) 一律抢占。每种写清：被停回合里已产出的内容如何保留、stale-first 风险（SPEC §18）、浪费的回合成本、与 CLI 队列聚合的交互、对 Quay worker/后台任务的隔离（中断不碰）。
3. **排队可见性复核（去重结论已在 Notes）**：用 b5d01c21 的 58:36–58:52 区间（`to-browser sent` 后 `phase=queued queued=1` 持续约 13 s、人报「气泡没上去」）判定是既有 done 任务的回归还是未覆盖形态；写结论，必要时另立缺陷任务（不在本任务内修）。
4. **2500 ms 合并窗口**：读出 b5d01c21 每次 `queued: opening a 2500 ms coalescing window` 到 `coalesced` 的实际延迟分布及合并片段数（本场 9 次合并中 ≥2 片段的次数），评估缩短/自适应窗口对「拆成多条」的影响；只出建议，不改默认。
5. 产出 `docs/proposals/voice-realtime-busy-preemption-proposal.md`，停在 needs-human 等人裁定。

## AC

- [ ] AC1 复验读数（工具调用、参数、执行面裁决、回合是否中止、花费、未重启 :3001 的 pid 证据）写入提案文档；依赖任务未合入时不得执行本条。
- [ ] AC2 提案文档覆盖 (a)(b)(c) 三种形态，各含：保留策略、stale-first 风险、成本、与 CLI 队列聚合的交互、Quay worker 隔离。
- [ ] AC3 文档显式写明「默认值须人裁定」，且本任务 diff 不触碰 `server/` 与 `src/` 下任何产品代码（`git diff --name-only develop... -- server src` 为空）。
- [ ] AC4 排队可见性：结论为「回归（指出 done 任务及失效点）」或「未覆盖形态（描述）」二选一，附 b5d01c21 证据行。
- [ ] AC5 合并窗口：给出本场实测分布表与建议，不改默认值。
- [ ] AC6 任务停在 needs-human，等人写入裁定；worker 不得自行勾选裁定。

## DoD

在 interrupt 修复后的代码上有一份真实复验读数，以及一份覆盖三种抢占形态、排队可见性归因与合并窗口建议的提案，交人裁定；产品默认值未被改动。

## Touches

- docs/proposals/voice-realtime-busy-preemption-proposal.md (new)
- experiments/voice-realtime-busy-preemption-recheck/probe.mts (new)
- tasks/gap-live-voice-busy-utterance-preemption-proposal.md

## Notes

**去重结论（2026-10-14 Quay 检索 `coalesc` / `queue` / `session_interrupt`）**：
- 排队可见性：`gap-live-voice-bounded-queue-refusal-visible`、`gap-live-voice-delivery-state-visible`（AC-327）、`gap-voice-delivered-merged-message-invisible-in-transcript`、`gap-live-voice-caption-removal-on-shown`、`gap-live-voice-pending-utterance-withdraw`（AC-351）均 **done**；今晚「气泡没上去」与它们的关系待本任务 AC4 判定，不新立重复任务。
- 2500 ms 合并窗口：**无**任何任务以窗口时长为对象（AC-327 只让窗口状态可见）；本任务只出建议。
- 抢占：A+ 裁定见 GOAL-041（AC-338..346，均 done）；方案 B（独立 Intent Buffer）仍不做，除非 SPEC §18.7 重开条件触发。

**依赖**：`gap-live-voice-interrupt-missing-intent-drops-stop`（复验前提）。
