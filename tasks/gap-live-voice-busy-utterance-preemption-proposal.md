---
id: gap-live-voice-busy-utterance-preemption-proposal
title: 提案：会话忙时新话语主动抢占在跑回合（停前序、带上下文处理当前句）——在 interrupt
  修复复验后研究，默认值须人裁定；同时复核排队可见性回归与 2500 ms 合并窗口
status: done
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

**本任务是提案，不是实现**：在 interrupt 修复合入后先复验「模型主动打断」的真实效果，再研究「busy 时新话语主动抢占」的若干形态，交人裁定。**⛔ 硬约束：未经人进一步裁定，不得把一切补充话语设成中断默认；本任务不改任何产品默认值。** 人已于 2026-10-14 裁定（见 Notes），AC6 负责把该裁定写进提案文档。

## Plan

1. **复验**（依赖任务合入后）：用 capture `b5d01c21….wav`（sha256 前缀 `0f2bd51fbbb28c9f`）中的「终止前面操作」「先暂停一下」两处真实语音，在备用端口实例 / dry-run 执行面回放真实上游，读：模型是否调用 interrupt、执行面是否接受、回合是否中止、修正文本是否随同一回合到达。花费上限 ¥0.3；不重启 :3001。
2. **形态研究**（至少三种，逐一给出代价与风险）：(a) 现状 A+ + 修好的语义 interrupt；(b) 有界抢占——回合已运行 ≥N s 且新话语被模型判为与当前方向相关时抢占；(c) 一律抢占。每种写清：被停回合里已产出的内容如何保留、stale-first 风险（SPEC §18）、浪费的回合成本、与 CLI 队列聚合的交互、对 Quay worker/后台任务的隔离（中断不碰）。
3. **排队可见性复核（去重结论已在 Notes）**：用 b5d01c21 的 58:36–58:52 区间（`to-browser sent` 后 `phase=queued queued=1` 持续约 13 s、人报「气泡没上去」）判定是既有 done 任务的回归还是未覆盖形态；写结论，必要时另立缺陷任务（不在本任务内修）。
4. **2500 ms 合并窗口**：读出 b5d01c21 每次 `queued: opening a 2500 ms coalescing window` 到 `coalesced` 的实际延迟分布及合并片段数（实测 11 次，见 §4），评估缩短/自适应窗口对「拆成多条」的影响；只出建议，不改默认。
5. 产出 `docs/proposals/voice-realtime-busy-preemption-proposal.md`；人已裁定后，把裁定写入该文档新增的 §7，然后经 ABI 勾选后退出、由 driver 机械 fan-in 落地。

## AC

- [x] AC1 复验读数（工具调用、参数、执行面裁决、回合是否中止、花费、未重启 :3001 的 pid 证据）写入提案文档；依赖任务未合入时不得执行本条。
- [x] AC2 提案文档覆盖 (a)(b)(c) 三种形态，各含：保留策略、stale-first 风险、成本、与 CLI 队列聚合的交互、Quay worker 隔离。
- [x] AC3 文档显式写明「默认值须人裁定」，且本任务 diff 不触碰 `server/` 与 `src/` 下任何产品代码（`git diff --name-only develop... -- server src` 为空）。
- [x] AC4 排队可见性：结论为「回归（指出 done 任务及失效点）」或「未覆盖形态（描述）」二选一，附 b5d01c21 证据行。
- [x] AC5 合并窗口：给出本场实测分布表与建议，不改默认值。
- [x] AC6 把 **2026-10-14 的人裁定**写进提案文档（新增 §7「人裁定（2026-10-14）」）：内容是——**保留 A+ 架构**（形态 a，D-6「语义判断、非关键词」不变），**不**采用形态 (b) 的新门槛、**不**采用被禁止的形态 (c)；裁定后的方向是从**指令/提示面**强化「用户说停就停」的可靠性（针对 §1.4 量出的「该抢不抢」）。同时写明该实现的改动**不在本任务内**（AC3 禁改产品代码），已另立 `gap-voice-busy-preemption-instruction-reliability`（若实际立案 id 不同，写明实际 id 与理由）。写完勾选本条。⛔ 不得把「已裁定」写成「已实现」。

## DoD

在 interrupt 修复后的代码上有一份真实复验读数、一份覆盖三种抢占形态 + 排队可见性归因 + 合并窗口建议的提案，以及**把 2026-10-14 人裁定写进文档 §7 的那一节**；产品默认值未被改动。

## Touches

- docs/proposals/voice-realtime-busy-preemption-proposal.md (new)
- experiments/voice-realtime-busy-preemption-recheck/probe.mts (new)
- tasks/gap-live-voice-busy-utterance-preemption-proposal.md

## Notes

### 2026-10-14 人裁定（AC6 所等的那份）

人 yale 裁定：**保留 A+ 架构**——形态 (a)，即「何时抢占由模型的语义判断决定」（D-6 不变，不引入新门槛）。**不**采用形态 (b) 的「run ≥N s 且相关」门槛；**不**采用形态 (c)（提案已判其违反 SPEC §18.7 的「模型发起的有效中断 ≤1 次/run」与 D-6，任务硬约束亦禁止）。

裁定所针对的弱点来自本提案自己的读数（§1.4）：**同一句「先暂停一下」现场被判 send、复验被判 interrupt ⇒ 抢占与否由模型随机决定**，即「该抢不抢」。裁定后的方向是从**指令 / 提示面**强化「用户说停就停」的可靠性——不动架构、不新开门槛。该实现**不在本任务内**（AC3 禁改产品代码），已另立 `gap-voice-busy-preemption-instruction-reliability`。

### 去重结论（2026-10-14 Quay 检索 `coalesc` / `queue` / `session_interrupt`）

- 排队可见性：`gap-live-voice-bounded-queue-refusal-visible`、`gap-live-voice-delivery-state-visible`（AC-327）、`gap-voice-delivered-merged-message-invisible-in-transcript`、`gap-live-voice-caption-removal-on-shown`、`gap-live-voice-pending-utterance-withdraw`（AC-351）均 **done**；今晚「气泡没上去」与它们的关系由本任务 AC4 判定为**未覆盖形态**（被拒的 `session_interrupt` 零可见处置），不新立重复任务。
- 2500 ms 合并窗口：**无**任何任务以窗口时长为对象（AC-327 只让窗口状态可见）；本任务只出建议。
- 抢占：A+ 裁定见 GOAL-041（AC-338..346，均 done）；方案 B（独立 Intent Buffer）仍不做，除非 SPEC §18.7 重开条件触发。

**依赖**：`gap-live-voice-interrupt-missing-intent-drops-stop`（复验前提）。

## Evidence

**AC1 复验读数**（探针 `experiments/voice-realtime-busy-preemption-recheck/probe.mts`；capture `b5d01c21-3f53-4228-a28e-d18b7cb967f7`，sha256 前缀 `0f2bd51fbbb28c9f` 已核对；dry-run 备用实例 :3912，真实上游 `qwen3.8-omni-flash-realtime`）：

- 窗口 `terminate`（offsetMs 102800–106900，4.10 s 音频）：「终止前面操作」+「处理我现在说的这句话」；模型调 `session_interrupt {"intent":"用户要求停止当前操作"}` 再 `session_send {"message":"处理我现在说的这句话"}`；schema 违例 **0**；`stopped` 帧 `{aborted:false,depth:0,runId:null}`（dry-run 无真 run ⇒ 执行面边界，非拒绝）；花费 **¥0.0066**。
- 窗口 `pause`（offsetMs 200800–211300，10.50 s 音频）：「先暂停一下…」；先一次上游 MALFORMED_FUNCTION_CALL（上游模型自身抖动、recoverable），再 `session_interrupt {"message":"先暂停一下，统计一下这次输入了几段话，识别输出了几段。","intent":"用户要求暂停当前运行并统计输入和输出的段落数。"}`；schema 违例 **0**；带 `message` ⇒ 走 **G1 先入队后中断**，dry-run 的假 `session_send` 返回 `queued:false` ⇒ 入队不可确认 ⇒ 执行面**诚实拒绝** `{stopped:false,reason:'revision-not-enqueued'}`（第二实例日志 `correction not enqueued`），无 `stopped` 帧、不静默丢弃；花费 **¥0.0050**。
- 合计 **¥0.0116**（上限 ¥0.3/连接）；`:3001` pid **766174 → 766174**（未重启）。同一段「先暂停一下」现场判 send、复验判 interrupt ⇒ **抢占与否由模型随机决定**。
- 边界：本次两道都自带 `intent`，**未命中**「缺 intent」路径（该修复 `cf1673f6d` 晚于 capture）；dry-run 读不到真实 abort。详见文档 §1.4。

**AC2** 文档 §2 覆盖 (a)(b)(c) 三形态，各含保留策略 / stale-first / 成本 / CLI 队列聚合 / Quay 隔离五项 + 对照表；形态 (c) 标注为任务硬约束禁止的默认化方向。

**AC3** 文档 §5 显式写「默认值须人裁定」；`git diff --name-only develop... -- server src` 为**空**（本任务 diff 仅文档 + 探针，见 §5 与本节末）。

**AC4** 文档 §3 结论取「**未覆盖形态**」：**被拒的 `session_interrupt` 零可见处置**（既不入队、也不成行）。证据行：`15:58:06.856 << function_call session_interrupt {"message":"停止前面的操作，处理我现在说的这句话。"}` + `15:58:06.857 to-browser error TOOL_ARGUMENT_SCHEMA_VIOLATION … (intent: … received undefined)` + 人报 `15:58:36.135 "…但是气泡没上去。"`。排队可见性面**本身正常**（`to-browser queued depth=1`；`phase=queued queued=1/93B` 自 15:58:39.385 持续 13.1 s 至 15:58:52.478）。根因已由依赖任务覆盖；残留的「被拒中断不留痕迹」建议另立缺陷任务（**不在本任务内修**）。

**AC5** 文档 §4 给出**11 次**开窗实测分布表（正文 Plan 假设的 9 次为**误**，实测 11；见 §6 更正），55% 在地板空放；建议事件驱动静默窗口；未改默认值。

**AC6** 已勾：人裁定写进文档**新增的 §7「人裁定（2026-10-14）」**——保留形态 (a)（D-6 不变、不加新门槛）、**不**采用形态 (b) 门槛、**否**形态 (c)；方向＝从**指令 / 提示面**强化「用户说停就停」的可靠性（对 §1.4「该抢不抢」）；实现**不在本任务内**（AC3 禁改产品代码），另立 `gap-voice-busy-preemption-instruction-reliability`（立案 id 与 Notes 一致）。⛔ 该节记录的是**裁定**，非「本任务已实现」。

**本任务 diff**（`git diff --name-only develop...HEAD`）：`docs/proposals/voice-realtime-busy-preemption-proposal.md`、`experiments/voice-realtime-busy-preemption-recheck/probe.mts`；anti-drift 门 `ANTI-DRIFT OK … 2 actual file(s), all within declared Touches`。

## Blocker

**2026-10-13T18:34:09.442Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 5/6，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：2cf232af-00bc-4369-8d95-cf3ae17a61c2
